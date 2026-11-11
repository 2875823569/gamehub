import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { HostGame, type HostSnapshot } from "../../packages/host-game";
import { partyGames } from "../../packages/games/registry";
import { MAX_PLAYERS } from "../../packages/games/liars-dice/rules";
import type { ClientAction, RoomView, ServerMessage } from "../../packages/protocol";
import type { PeerRoster } from "../../packages/peer-protocol";
import type { ApiConfig } from "./config";
import { ApiError } from "./errors";
import type { AccessIdentity } from "./access-store";
import { IdentityService } from "./identity-store";
import { withTransaction } from "./db";
import { digest, newToken } from "./tokens";
import { validPlaySession } from "./play-store";

type RoomRow = {
  id: string; environment_id: string; generation: number; game_id: string; version_id: string;
  official_key: string; host_player_id: string; sequence: number; lease_owner: string;
  lease_epoch: number; lease_until: Date; status: string; snapshot: HostSnapshot | null;
};
type Member = { player_id: string; access_session_id: string; nickname: string; last_seen_at: Date; joined_at: Date };
export interface RoomBaseline {
  room: RoomRow; members: Member[]; playerId: string; now: number;
}
const phaseStatus = (snapshot: HostSnapshot) => snapshot.phase === "lobby" ? "waiting" : snapshot.phase === "playing" ? "playing" : "ended";
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class RoomsStore {
  readonly instanceId = randomUUID();
  hasClaims=false;
  readonly identity: IdentityService;
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly pool: Pool, readonly config: ApiConfig) { this.identity = new IdentityService(pool, config); }
  private async serial<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(roomId) ?? Promise.resolve();
    const promise = prior.catch(() => undefined).then(operation);
    this.queues.set(roomId, promise);
    try { return await promise; } finally { if (this.queues.get(roomId) === promise) this.queues.delete(roomId); }
  }
  private async guest(client: PoolClient, access: AccessIdentity) {
    const result = await client.query("SELECT id,nickname FROM guest_sessions WHERE access_session_id=$1 AND environment_id=$2 AND generation=$3", [access.id, this.config.environmentId, access.generation]);
    if (!result.rows[0]) throw new ApiError(409, "GUEST_SESSION_REQUIRED", "请先设置本次游玩的昵称");
    return result.rows[0] as { id: string; nickname: string };
  }
  private async playSession(client: PoolClient, access: AccessIdentity, gameId: string, versionId: string) {
    const id = randomUUID();
    // The room fixes an approved official version even if a newer version is published later.
    await client.query(`INSERT INTO play_sessions(id,environment_id,generation,access_session_id,game_id,version_id,scope,resource_digest,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'internal_catalog',$7,now()+interval '1 hour')`,
    [id,this.config.environmentId,access.generation,access.id,gameId,versionId,digest(this.config.tokenSecret,"room-resource",newToken())]);
    return id;
  }
  private async allowedGame(client: PoolClient, gameId: string, versionId?: string, requirePublished = true, playing = false) {
    const row = (await client.query(
      `SELECT g.*,v.id AS approved_version_id,v.review_status,v.deleted_at AS version_deleted,h.version_id AS published_version
       FROM games g LEFT JOIN publication_heads h ON h.game_id=g.id AND h.environment_id=g.environment_id AND h.scope='internal_catalog'
       JOIN game_versions v ON v.game_id=g.id AND v.id=COALESCE($3::uuid,h.version_id)
       WHERE g.id=$1 AND g.environment_id=$2 FOR SHARE OF g,v`,
      [gameId, this.config.environmentId, versionId ?? null])).rows[0];
    if (!row || row.restricted || row.deleted_at || row.version_deleted || row.review_status !== "approved") {
      throw new ApiError(409, "GAME_UNAVAILABLE", "游戏当前不可游玩");
    }
    if (!row.official_key || (row.official_key !== "liars-dice" && !partyGames.has(row.official_key))) {
      throw new ApiError(422, "PACKAGE_UNSUPPORTED", "用户多人规则需先通过独立沙箱验收，当前仅支持官方游戏");
    }
    if (!row.published_version) {
      if (requirePublished || !playing || new Date(row.updated_at).getTime() + 3600000 <= Date.now()) {
        throw new ApiError(409, "GAME_UNAVAILABLE", "游戏已下架，不能新开局或加入");
      }
    }
    return row;
  }
  private roster(base: RoomBaseline, exclude?: string): PeerRoster {
    return {
      code: base.room.id, gameId: base.room.official_key, hostId: base.room.host_player_id,
      epoch: base.room.lease_epoch, revision: base.room.sequence, you: base.playerId,
      players: base.members.filter(member => member.player_id !== exclude).map(member => ({
        id: member.player_id, name: member.nickname,
        connected: base.now - member.last_seen_at.getTime() <= 15000,
        ...(base.now - member.last_seen_at.getTime() > 15000 ? { disconnectAt: member.last_seen_at.getTime() + 60000 } : {}),
      })),
    };
  }
  private view(base: RoomBaseline, snapshot = base.room.snapshot): RoomView {
    const engine = new HostGame(this.roster(base), snapshot ?? undefined);
    const view = engine.view(base.playerId, base.now);
    view.revision = base.room.sequence;
    return view;
  }
  async create(access: AccessIdentity, gameId: string) {
    this.hasClaims=true;
    return withTransaction(this.pool, async client => {
      await this.identity.assertAccess(client, access);
      const guest = await this.guest(client, access), game = await this.allowedGame(client, gameId);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('rooms-create'),hashtext($1))", [access.id]);
      const count = await client.query("SELECT count(*)::int AS n FROM room_members m JOIN rooms r ON r.id=m.room_id WHERE m.access_session_id=$1 AND m.left_at IS NULL AND r.status<>'closed'", [access.id]);
      if (count.rows[0].n >= 5) throw new ApiError(429, "RATE_LIMITED", "请先退出已有房间");
      const roomId = randomUUID(), inviteToken = newToken();
      await client.query(
        `INSERT INTO rooms(id,environment_id,generation,game_id,version_id,official_key,invitation_digest,host_player_id,lease_owner,lease_epoch,lease_until)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,now()+interval '15 seconds')`,
        [roomId, this.config.environmentId, access.generation, gameId, game.approved_version_id, game.official_key,
          digest(this.config.tokenSecret, "room-invite", inviteToken), guest.id, this.instanceId]);
      const playSessionId = await this.playSession(client, access, gameId, game.approved_version_id);
      await client.query("INSERT INTO room_members(room_id,player_id,access_session_id,nickname,play_session_id) VALUES($1,$2,$3,$4,$5)", [roomId, guest.id, access.id, guest.nickname,playSessionId]);
      const row = (await client.query("SELECT *,now() AS clock FROM rooms WHERE id=$1", [roomId])).rows[0];
      const members = (await client.query<Member>("SELECT player_id,access_session_id,nickname,last_seen_at,joined_at FROM room_members WHERE room_id=$1", [roomId])).rows;
      const base: RoomBaseline = { room: row, members, playerId: guest.id, now: row.clock.getTime() };
      const engine = new HostGame(this.roster(base)), snapshot = engine.snapshot();
      snapshot.revision = 0;
      await client.query("UPDATE rooms SET snapshot=$2 WHERE id=$1", [roomId, snapshot]);
      return { roomId, inviteToken, sequence: 0, versionId: game.approved_version_id, view: this.view(base, snapshot) };
    });
  }
  async join(access: AccessIdentity, roomId: string, inviteToken: string) {
    return this.serial(roomId, async () => {
      await withTransaction(this.pool, async client => {
        await this.identity.assertAccess(client, access);
        const guest = await this.guest(client, access);
        const room = (await client.query("SELECT * FROM rooms WHERE id=$1 AND environment_id=$2 AND generation=$3 FOR UPDATE", [roomId, this.config.environmentId, access.generation])).rows[0] as RoomRow | undefined;
        if (!room || room.status === "closed") throw new ApiError(404, "NOT_FOUND", "房间不存在或已关闭");
        const credential = await client.query("SELECT id FROM rooms WHERE id=$1 AND invitation_digest=$2", [roomId, digest(this.config.tokenSecret, "room-invite", inviteToken)]);
        if (!credential.rowCount) throw new ApiError(403, "PERMISSION_DENIED", "房间邀请无效");
        await this.allowedGame(client, room.game_id, room.version_id, true);
        const existing = (await client.query("SELECT left_at FROM room_members WHERE room_id=$1 AND player_id=$2", [roomId, guest.id])).rows[0];
        if (existing && !existing.left_at) {
          await client.query("UPDATE room_members SET last_seen_at=now() WHERE room_id=$1 AND player_id=$2", [roomId, guest.id]);
          return;
        }
        const maxPlayers = partyGames.get(room.official_key)?.maxPlayers ?? MAX_PLAYERS;
        const size = (await client.query("SELECT count(*)::int AS n FROM room_members WHERE room_id=$1 AND left_at IS NULL", [roomId])).rows[0].n;
        if (size >= maxPlayers) throw new ApiError(409, "RESOURCE_IN_USE", "房间人数已满");
        // Official games preserve their existing late-join spectator behavior.
        const playSessionId = await this.playSession(client, access, room.game_id, room.version_id);
        await client.query(
          `INSERT INTO room_members(room_id,player_id,access_session_id,nickname,play_session_id) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(room_id,player_id) DO UPDATE SET left_at=NULL,last_seen_at=now(),nickname=EXCLUDED.nickname,play_session_id=EXCLUDED.play_session_id`,
          [roomId, guest.id, access.id, guest.nickname,playSessionId]);
        await client.query("UPDATE rooms SET sequence=sequence+1,updated_at=now() WHERE id=$1", [roomId]);
      });
      return this.stateUnlocked(access, roomId);
    });
  }
  /** Exposed for deterministic lease-fencing integration tests. */
  async load(access: AccessIdentity, roomId: string): Promise<RoomBaseline> {
    this.hasClaims=true;
    return withTransaction(this.pool, async client => {
      await this.identity.assertAccess(client, access);
      const guest = await this.guest(client, access);
      const row = (await client.query("SELECT *,now() AS clock,lease_until>now() AS lease_valid FROM rooms WHERE id=$1 AND environment_id=$2 AND generation=$3 FOR UPDATE", [roomId, this.config.environmentId, access.generation])).rows[0];
      if (!row || row.status === "closed") throw new ApiError(404, "NOT_FOUND", "房间不存在或已关闭");
      const member = (await client.query("SELECT play_session_id,left_at,last_seen_at>now()-interval '60 seconds' AS recoverable FROM room_members WHERE room_id=$1 AND player_id=$2", [roomId, guest.id])).rows[0];
      if (!member || member.left_at || !member.recoverable) throw new ApiError(403, "PERMISSION_DENIED", "不是有效房间成员或已超过重连期限");
      await validPlaySession(client,this.config,member.play_session_id,access.id);
      await this.allowedGame(client, row.game_id, row.version_id, false, row.status === "playing");
      if (row.lease_owner !== this.instanceId && row.lease_valid) throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "房间由其他实例处理，请稍后重连");
      const newEpoch = row.lease_owner === this.instanceId && row.lease_valid ? row.lease_epoch : row.lease_epoch + 1;
      await client.query("UPDATE rooms SET lease_owner=$2,lease_epoch=$3,lease_until=now()+interval '15 seconds' WHERE id=$1", [roomId, this.instanceId, newEpoch]);
      await client.query("UPDATE room_members SET last_seen_at=now() WHERE room_id=$1 AND player_id=$2", [roomId, guest.id]);
      const expired = await client.query("UPDATE room_members SET left_at=now() WHERE room_id=$1 AND left_at IS NULL AND last_seen_at<now()-interval '60 seconds' RETURNING player_id", [roomId]);
      const members = (await client.query<Member>("SELECT player_id,access_session_id,nickname,last_seen_at,joined_at FROM room_members WHERE room_id=$1 AND left_at IS NULL ORDER BY joined_at,player_id", [roomId])).rows;
      if (!members.some(m => m.player_id === row.host_player_id)) {
        row.host_player_id = members[0].player_id;
        await client.query("UPDATE rooms SET host_player_id=$2 WHERE id=$1", [roomId, row.host_player_id]);
      }
      if (expired.rowCount) {
        row.sequence++;
        await client.query("UPDATE rooms SET sequence=$2,updated_at=now() WHERE id=$1", [roomId, row.sequence]);
      }
      row.lease_owner = this.instanceId; row.lease_epoch = newEpoch;
      return { room: row, members, playerId: guest.id, now: row.clock.getTime() };
    });
  }
  async commit(access: AccessIdentity, base: RoomBaseline, snapshot: HostSnapshot, eventType: string,
    action?: { id: string; requestDigest: string; result: ServerMessage }, leaving = false) {
    return withTransaction(this.pool, async client => {
      await this.identity.assertAccess(client, access);
      const row = (await client.query("SELECT *,lease_until>now() AS lease_valid FROM rooms WHERE id=$1 FOR UPDATE", [base.room.id])).rows[0];
      await this.allowedGame(client, base.room.game_id, base.room.version_id, false, base.room.status === "playing");
      if (!row || row.environment_id !== this.config.environmentId || row.generation !== access.generation ||
          row.lease_owner !== this.instanceId || row.lease_epoch !== base.room.lease_epoch ||
          !row.lease_valid || row.sequence !== base.room.sequence || row.status === "closed") {
        throw new ApiError(409, "VERSION_CONFLICT", "房间状态或主持租约已变化，请重新同步");
      }
      const member = await client.query("SELECT player_id,play_session_id FROM room_members WHERE room_id=$1 AND player_id=$2 AND access_session_id=$3 AND left_at IS NULL FOR SHARE", [row.id, base.playerId, access.id]);
      if (!member.rowCount) throw new ApiError(403, "PERMISSION_DENIED", "房间成员资格已失效");
      await validPlaySession(client,this.config,member.rows[0].play_session_id,access.id);
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 262144) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "房间状态超过上限");
      const sequence = row.sequence + 1;
      snapshot.revision = sequence;
      let host = row.host_player_id, status = phaseStatus(snapshot);
      if (leaving) {
        await client.query("UPDATE room_members SET left_at=now() WHERE room_id=$1 AND player_id=$2", [row.id, base.playerId]);
        await client.query("UPDATE play_sessions SET revoked_at=now() WHERE id=$1",[member.rows[0].play_session_id]);
        const remaining = base.members.filter(m => m.player_id !== base.playerId);
        if (!remaining.length) status = "closed";
        else if (host === base.playerId) host = remaining[0].player_id;
      }
      await client.query("UPDATE rooms SET snapshot=$2,sequence=$3,status=$4,host_player_id=$5,updated_at=now() WHERE id=$1", [row.id, snapshot, sequence, status, host]);
      await client.query("INSERT INTO room_events(id,room_id,sequence,event_type,player_id) VALUES($1,$2,$3,$4,$5)", [randomUUID(), row.id, sequence, eventType, base.playerId]);
      if (action) {
        const result = action.result.type === "ack" ? { ...action.result, revision: sequence } : action.result;
        await client.query("INSERT INTO room_actions(room_id,action_id,player_id,request_digest,sequence,result) VALUES($1,$2,$3,$4,$5,$6)",
          [row.id, action.id, base.playerId, action.requestDigest, sequence, result]);
        await client.query("UPDATE room_members SET last_action_at=now() WHERE room_id=$1 AND player_id=$2", [row.id, base.playerId]);
      }
      return sequence;
    });
  }
  private async snapshotUnlocked(access: AccessIdentity, roomId: string) {
    const base = await this.load(access, roomId), engine = new HostGame(this.roster(base), base.room.snapshot ?? undefined);
    engine.tick(base.now);
    const snapshot = engine.snapshot();
    snapshot.revision = base.room.snapshot?.revision ?? 0;
    if (fingerprint(snapshot) !== fingerprint(base.room.snapshot)) {
      base.room.sequence = await this.commit(access, base, snapshot, "timeout_or_roster");
      base.room.snapshot = snapshot;
    }
    return base;
  }
  private async stateUnlocked(access: AccessIdentity, roomId: string) {
    const base=await this.snapshotUnlocked(access,roomId);
    return {roomId,sequence:base.room.sequence,versionId:base.room.version_id,view:this.view(base)};
  }
  state(access: AccessIdentity, roomId: string) { return this.serial(roomId, () => this.stateUnlocked(access, roomId)); }
  /** One authority refresh per room, but distinct authorization and projection for every member. */
  projections(accesses:AccessIdentity[],roomId:string){
    return this.serial(roomId,async()=>{
      const result=new Map<string,{roomId:string;sequence:number;versionId:string;view:RoomView}|ApiError>();
      const ids=[...new Set(accesses.map(access=>access.id))];
      if(!ids.length)return result;
      const valid=await withTransaction(this.pool,async client=>{
        const rows=(await client.query<{access_session_id:string;player_id:string;generation:number}>(
          `SELECT m.access_session_id,m.player_id,a.generation FROM room_members m
           JOIN rooms r ON r.id=m.room_id JOIN environments e ON e.id=r.environment_id
           JOIN test_access_sessions a ON a.id=m.access_session_id JOIN test_access_grants t ON t.id=a.grant_id
           JOIN play_sessions p ON p.id=m.play_session_id JOIN games g ON g.id=p.game_id
           JOIN game_versions v ON v.id=p.version_id
           WHERE r.id=$1 AND r.environment_id=$2 AND r.generation=e.generation AND r.status<>'closed'
             AND m.access_session_id=ANY($3::uuid[]) AND m.left_at IS NULL AND m.last_seen_at>now()-interval '60 seconds'
             AND e.accepting_access AND a.environment_id=e.id AND a.generation=e.generation
             AND a.revoked_at IS NULL AND a.expires_at>now() AND t.revoked_at IS NULL AND t.expires_at>now()
             AND p.environment_id=e.id AND p.generation=e.generation AND p.access_session_id=a.id
             AND p.revoked_at IS NULL AND p.expires_at>now() AND p.user_id IS NULL
             AND p.game_id=r.game_id AND p.version_id=r.version_id
             AND NOT g.restricted AND g.deleted_at IS NULL AND v.deleted_at IS NULL AND v.review_status='approved'
           FOR SHARE OF e,a,t,p,g,v`,
          [roomId,this.config.environmentId,ids])).rows.filter(row=>accesses.some(access=>access.id===row.access_session_id&&access.generation===row.generation));
        if(rows.length)await client.query("UPDATE room_members SET last_seen_at=now() WHERE room_id=$1 AND access_session_id=ANY($2::uuid[]) AND left_at IS NULL",[roomId,rows.map(row=>row.access_session_id)]);
        return rows;
      });
      for(const id of ids)if(!valid.some(row=>row.access_session_id===id))result.set(id,new ApiError(403,"PERMISSION_DENIED","房间成员或游玩授权已失效"));
      if(!valid.length)return result;
      const leader=accesses.find(access=>access.id===valid[0].access_session_id)!;
      const base=await this.snapshotUnlocked(leader,roomId),engine=new HostGame(this.roster(base),base.room.snapshot??undefined);
      for(const member of valid){
        const view=engine.view(member.player_id,base.now);view.revision=base.room.sequence;
        result.set(member.access_session_id,{roomId,sequence:base.room.sequence,versionId:base.room.version_id,view});
      }
      return result;
    });
  }
  action(access: AccessIdentity, roomId: string, actionId: string, expectedSequence: number, action: ClientAction) {
    return this.serial(roomId, async () => {
      const base = await this.load(access, roomId);
      const requestDigest = fingerprint({ ...action, requestId: actionId });
      const existing = (await this.pool.query("SELECT * FROM room_actions WHERE room_id=$1 AND action_id=$2", [roomId, actionId])).rows[0];
      if (existing) {
        if (existing.player_id !== base.playerId || existing.request_digest !== requestDigest) throw new ApiError(409, "VERSION_CONFLICT", "操作编号已用于不同操作");
        return { roomId, sequence: base.room.sequence, result: existing.result as ServerMessage, view: this.view(base), duplicate: true };
      }
      if (base.room.sequence !== expectedSequence) throw new ApiError(409, "VERSION_CONFLICT", "房间状态已更新，请重新同步");
      const rate = (await this.pool.query("SELECT last_action_at>now()-interval '100 milliseconds' AS too_fast FROM room_members WHERE room_id=$1 AND player_id=$2", [roomId, base.playerId])).rows[0];
      if (rate?.too_fast) throw new ApiError(429, "RATE_LIMITED", "操作过快，请稍后重试");
      if (action.type === "start") {
        await withTransaction(this.pool, client => this.allowedGame(client, base.room.game_id, base.room.version_id, true));
      }
      const engine = new HostGame(this.roster(base), base.room.snapshot ?? undefined);
      const result = engine.act(base.playerId, { ...action, requestId: actionId }, base.now);
      const snapshot = engine.snapshot();
      // The durable action table owns deduplication; bound the private snapshot independently.
      snapshot.receipts = [];
      base.room.sequence = await this.commit(access, base, snapshot, "action", { id: actionId, requestDigest, result });
      base.room.snapshot = snapshot;
      const canonicalResult = result.type === "ack" ? { ...result, revision: base.room.sequence } : result;
      return { roomId, sequence: base.room.sequence, result: canonicalResult, view: this.view(base), duplicate: false };
    });
  }
  leave(access: AccessIdentity, roomId: string) {
    return this.serial(roomId, async () => {
      const base = await this.load(access, roomId), roster = this.roster(base, base.playerId);
      if (roster.hostId === base.playerId && roster.players[0]) roster.hostId = roster.players[0].id;
      const engine = new HostGame(roster, base.room.snapshot ?? undefined);
      await this.commit(access, base, engine.snapshot(), "leave", undefined, true);
      return { left: true };
    });
  }
  async ticket(access: AccessIdentity, roomId: string) {
    const base = await this.load(access, roomId), ticket = newToken();
    await withTransaction(this.pool, async client => {
      await this.identity.assertAccess(client, access);
      await client.query("INSERT INTO room_connection_tickets(token_digest,room_id,player_id,access_session_id,environment_id,generation) VALUES($1,$2,$3,$4,$5,$6)",
        [digest(this.config.tokenSecret, "room-ticket", ticket), roomId, base.playerId, access.id, this.config.environmentId, access.generation]);
    });
    return { ticket, expiresInSeconds: 30, path: `/api/v1/rooms/${roomId}/stream` };
  }
  async consumeTicket(roomId: string, ticket: string): Promise<AccessIdentity> {
    return withTransaction(this.pool, async client => {
      const row = (await client.query(
        `UPDATE room_connection_tickets SET consumed_at=now() WHERE token_digest=$1 AND room_id=$2
         AND environment_id=$3 AND consumed_at IS NULL AND expires_at>now() RETURNING *`,
        [digest(this.config.tokenSecret, "room-ticket", ticket), roomId, this.config.environmentId])).rows[0];
      if (!row) throw new ApiError(403, "PERMISSION_DENIED", "连接票据无效或已使用");
      const access = (await client.query("SELECT id,generation,expires_at FROM test_access_sessions WHERE id=$1", [row.access_session_id])).rows[0] as AccessIdentity;
      if (!access || access.generation !== row.generation) throw accessRequiredForRoom();
      await this.identity.assertAccess(client, access);
      return access;
    });
  }
}
function accessRequiredForRoom() { return new ApiError(403, "TEST_ACCESS_REQUIRED", "测试访问已失效"); }
