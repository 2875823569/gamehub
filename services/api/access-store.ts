import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ApiConfig } from "./config";
import { withTransaction } from "./db";
import { ApiError, accessRequired } from "./errors";
import { digest, newToken, isToken } from "./tokens";

interface Environment { generation: number; accepting_access: boolean }
export interface AccessIdentity { id: string; generation: number; expires_at: Date }
export interface GuestIdentity { id: string; nickname: string }

export class AccessStore {
  constructor(readonly pool: Pool, readonly config: ApiConfig) {}

  async assertEnvironment(): Promise<void> {
    const result = await this.pool.query("SELECT mode FROM environments WHERE id = $1", [this.config.environmentId]);
    if (result.rows[0]?.mode !== this.config.mode) throw new Error("环境未初始化或部署模式不匹配，请先执行 db:init");
  }

  private async environment(client: PoolClient): Promise<Environment> {
    const result = await client.query<Environment>(
      "SELECT generation, accepting_access FROM environments WHERE id = $1 AND mode = $2 FOR SHARE",
      [this.config.environmentId, this.config.mode],
    );
    if (!result.rows[0]) throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "环境暂不可用");
    return result.rows[0];
  }

  private async audit(client: PoolClient, generation: number, actor: string, action: string, objectId: string, requestId?: string) {
    await client.query(
      "INSERT INTO audit_events(id, environment_id, generation, actor, action, object_id, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), this.config.environmentId, generation, actor, action, objectId, requestId ?? null],
    );
  }

  async issueInvitation(maxUses: number, ttlSeconds: number, actor: string, authorize?: (client: PoolClient) => Promise<void>) {
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000 ||
        !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 604800 || !actor.trim()) {
      throw new Error("邀请次数须为 1—1000、有效期须为 60—604800 秒，并记录操作者");
    }
    return withTransaction(this.pool, async client => {
      const env = await this.environment(client);
      await authorize?.(client);
      if (!env.accepting_access) throw accessRequired();
      const id = randomUUID(), invitation = newToken();
      const result = await client.query<{ expires_at: Date }>(
        `INSERT INTO test_access_grants(id, environment_id, generation, token_digest, expires_at, max_uses)
         VALUES ($1,$2,$3,$4,now() + $5 * interval '1 second',$6) RETURNING expires_at`,
        [id, this.config.environmentId, env.generation, digest(this.config.tokenSecret, "invite", invitation), ttlSeconds, maxUses],
      );
      await this.audit(client, env.generation, actor, "test_invitation_issued", id);
      return { id, invitation, expiresAt: result.rows[0].expires_at.toISOString(), maxUses };
    });
  }

  async revokeInvitation(id: string, actor: string, authorize?: (client: PoolClient) => Promise<void>): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      const env = await this.environment(client);
      await authorize?.(client);
      const result = await client.query(
        `UPDATE test_access_grants SET revoked_at = now()
         WHERE id=$1 AND environment_id=$2 AND revoked_at IS NULL RETURNING id`,
        [id, this.config.environmentId],
      );
      if (result.rowCount) await this.audit(client, env.generation, actor, "test_invitation_revoked", id);
      return Boolean(result.rowCount);
    });
  }

  async allowRequest(ip: string, scope: "auth" | "api" = "auth"): Promise<boolean> {
    const result = await this.pool.query<{ attempts: number }>(
      `INSERT INTO access_rate_limits(key_digest, window_start, attempts)
       VALUES ($1, date_trunc('minute', now()), 1)
       ON CONFLICT (key_digest, window_start) DO UPDATE SET attempts = access_rate_limits.attempts + 1
       RETURNING attempts`,
      [digest(this.config.tokenSecret, `rate:${this.config.environmentId}:${scope}`, ip)],
    );
    return result.rows[0].attempts <= (scope === "auth" ? 60 : 600);
  }

  async exchange(invitation: string, requestId: string, oldToken?: string) {
    return withTransaction(this.pool, async client => {
      const env = await this.environment(client);
      if (!env.accepting_access) throw accessRequired();
      const result = await client.query<{ id: string; expires_at: Date }>(
        `UPDATE test_access_grants SET used_count = used_count + 1
         WHERE token_digest=$1 AND environment_id=$2 AND generation=$3
           AND revoked_at IS NULL AND expires_at > now() AND used_count < max_uses
         RETURNING id, expires_at`,
        [digest(this.config.tokenSecret, "invite", invitation), this.config.environmentId, env.generation],
      );
      if (!result.rows[0]) throw new ApiError(403, "INVITATION_INVALID", "邀请无效、已过期、已撤销或次数已用完");
      const id = randomUUID(), token = newToken();
      const session = await client.query<AccessIdentity>(
        `INSERT INTO test_access_sessions(id, environment_id, generation, grant_id, token_digest, expires_at)
         VALUES ($1,$2,$3,$4,$5,LEAST($6::timestamptz, now() + $7 * interval '1 second'))
         RETURNING id, generation, expires_at`,
        [id, this.config.environmentId, env.generation, result.rows[0].id,
          digest(this.config.tokenSecret, "access", token), result.rows[0].expires_at, this.config.accessTtlSeconds],
      );
      if (isToken(oldToken)) {
        await client.query(
          "UPDATE test_access_sessions SET revoked_at=now() WHERE token_digest=$1 AND environment_id=$2 AND revoked_at IS NULL",
          [digest(this.config.tokenSecret, "access", oldToken), this.config.environmentId],
        );
      }
      await this.audit(client, env.generation, "test_visitor", "test_invitation_exchanged", id, requestId);
      return { token, identity: session.rows[0] };
    });
  }

  private async authorize(client: PoolClient, token: string): Promise<AccessIdentity> {
    if (!isToken(token)) throw accessRequired();
    const env = await this.environment(client);
    if (!env.accepting_access) throw accessRequired();
    const result = await client.query<AccessIdentity>(
      `SELECT s.id, s.generation, s.expires_at FROM test_access_sessions s
       JOIN test_access_grants g ON g.id=s.grant_id
       WHERE s.token_digest=$1 AND s.environment_id=$2 AND s.generation=$3
         AND s.revoked_at IS NULL AND s.expires_at>now()
         AND g.revoked_at IS NULL AND g.expires_at>now()
       FOR SHARE OF s, g`,
      [digest(this.config.tokenSecret, "access", token), this.config.environmentId, env.generation],
    );
    if (!result.rows[0]) throw accessRequired();
    return result.rows[0];
  }

  async current(token: string): Promise<AccessIdentity> {
    return withTransaction(this.pool, client => this.authorize(client, token));
  }

  async revokeSession(token: string, requestId: string): Promise<void> {
    await withTransaction(this.pool, async client => {
      // Lock order follows authorize: environment -> session/grant, then update.
      const session = await this.authorize(client, token);
      await client.query("UPDATE test_access_sessions SET revoked_at=now() WHERE id=$1", [session.id]);
      await this.audit(client, session.generation, "test_visitor", "test_session_revoked", session.id, requestId);
    });
  }

  async guest(token: string, nickname?: string): Promise<GuestIdentity> {
    return withTransaction(this.pool, async client => {
      const session = await this.authorize(client, token);
      if (nickname !== undefined) {
        await client.query(
          `INSERT INTO guest_sessions(id, access_session_id, environment_id, generation, nickname)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (access_session_id) DO NOTHING`,
          [randomUUID(), session.id, this.config.environmentId, session.generation, nickname],
        );
      }
      const result = await client.query<GuestIdentity>(
        "SELECT id, nickname FROM guest_sessions WHERE access_session_id=$1", [session.id],
      );
      if (!result.rows[0]) throw new ApiError(409, "GUEST_SESSION_REQUIRED", "请先输入昵称创建游客身份");
      return result.rows[0];
    });
  }

  async pruneRateLimits(): Promise<void> {
    await this.pool.query("DELETE FROM access_rate_limits WHERE window_start < now() - interval '10 minutes'");
  }
}
