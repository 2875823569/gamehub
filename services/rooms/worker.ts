import { DurableObject } from "cloudflare:workers";
import { challenge, createRound, MAX_PLAYERS, MIN_PLAYERS, placeBid, randomInt, RECONNECT_MS, type Round } from "../../packages/games/liars-dice/rules";
import type { ClientAction, RoomView, ServerMessage, Session } from "../../packages/protocol";

interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

interface Player {
  id: string;
  token: string;
  name: string;
  offlineAt?: number;
}

interface StoredRoom {
  code: string;
  hostId: string;
  phase: "lobby" | "playing" | "finished";
  players: Player[];
  round?: Round;
}

interface Attachment { playerId: string; lastMessageAt?: number }

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const json = (data: unknown, status = 200) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});

async function readNickname(request: Request): Promise<string> {
  const text = await request.text();
  if (text.length > 1024) throw new Error("请求过大。");
  const data = JSON.parse(text) as { name?: unknown };
  const name = typeof data.name === "string" ? data.name.trim().replace(/[\u0000-\u001f\u007f]/g, "") : "";
  if (!name || [...name].length > 12) throw new Error("昵称需要 1～12 个字。");
  return name;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "不允许跨站请求。" }, 403);
    if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, game: "liars-dice" });
    try {
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const name = await readNickname(request);
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
          const room = env.ROOMS.get(env.ROOMS.idFromName(code));
          const result = await room.fetch(new Request("https://room/init", {
            method: "POST", body: JSON.stringify({ code, name })
          }));
          if (result.status !== 409) return result;
        }
        return json({ error: "创建房间繁忙，请重试。" }, 503);
      }
      const match = url.pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/(join|socket)$/);
      if (!match) return json({ error: "房间码无效，或接口不存在。" }, 404);
      if ((match[2] === "join" && request.method !== "POST") ||
          (match[2] === "socket" && request.method !== "GET")) return json({ error: "请求方法不正确。" }, 405);
      if (match[2] === "join") {
        const name = await readNickname(request);
        return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(new Request("https://room/join", {
          method: "POST", body: JSON.stringify({ name })
        }));
      }
      url.pathname = "/socket";
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(new Request(url, request));
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "请求内容格式错误。" }, 400);
      return json({ error: error instanceof Error ? error.message : "操作失败，请重试。" }, 400);
    }
  }
} satisfies ExportedHandler<Env>;

export class GameRoom extends DurableObject<Env> {
  private room: StoredRoom | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.room = await ctx.storage.get<StoredRoom>("room"); });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init") {
      if (this.room) return json({ error: "房间已存在。" }, 409);
      const { code, name } = await request.json<{ code: string; name: string }>();
      const player = this.newPlayer(name);
      this.room = { code, hostId: player.id, phase: "lobby", players: [player] };
      await this.save();
      return json(this.session(player), 201);
    }
    if (!this.room) return json({ error: "房间不存在或已关闭，请检查房间码。" }, 404);
    if (url.pathname === "/join") {
      if (this.room.players.length >= MAX_PLAYERS) return json({ error: "房间已满，最多 6 位玩家。" }, 409);
      const { name } = await request.json<{ name: string }>();
      if (this.room.players.some(p => p.name === name)) return json({ error: "房间里已有这个昵称，换一个吧。" }, 409);
      const player = this.newPlayer(name);
      this.room.players.push(player);
      await this.save();
      this.broadcast();
      return json(this.session(player), 201);
    }
    if (url.pathname !== "/socket") return json({ error: "接口不存在。" }, 404);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "需要 WebSocket 连接。" }, 426);
    const player = this.room.players.find(p => p.token === url.searchParams.get("token"));
    if (!player) return json({ error: "房间身份已失效，请重新加入。" }, 401);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Each identity has one active connection. Old tabs must stop reconnecting on 4001.
    for (const old of this.sockets(player.id)) {
      old.serializeAttachment({ playerId: "" });
      old.close(4001, "已在另一个页面连接");
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: player.id } satisfies Attachment);
    player.offlineAt = undefined;
    await this.save();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  private newPlayer(name: string): Player {
    return { id: crypto.randomUUID(), token: crypto.randomUUID(), name, offlineAt: Date.now() };
  }

  private session(player: Player): Session {
    return { code: this.room!.code, playerId: player.id, token: player.token };
  }

  private sockets(playerId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter(ws =>
      (ws.deserializeAttachment() as Attachment | null)?.playerId === playerId && ws.readyState === 1);
  }

  private view(playerId: string): RoomView {
    const room = this.room!;
    const round = room.round;
    return {
      code: room.code, phase: room.phase, hostId: room.hostId, you: playerId,
      players: room.players.map(p => ({
        id: p.id, name: p.name, connected: this.sockets(p.id).length > 0,
        disconnectAt: p.offlineAt === undefined ? undefined : p.offlineAt + RECONNECT_MS
      })),
      round: round ? {
        number: round.number, playerIds: round.playerIds, names: round.names,
        turnId: round.playerIds[round.turnIndex], bids: round.bids,
        yourDice: round.dice[playerId] ?? [],
        ...(room.phase === "finished" ? { revealedDice: round.dice, outcome: round.outcome } : {})
      } : undefined
    };
  }

  private send(ws: WebSocket, message: ServerMessage) {
    try { ws.send(JSON.stringify(message)); } catch { /* Close/error handler updates membership. */ }
  }

  private broadcast() {
    if (!this.room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const id = (ws.deserializeAttachment() as Attachment | null)?.playerId;
      if (id && this.room.players.some(p => p.id === id)) this.send(ws, { type: "state", state: this.view(id) });
    }
  }

  private async save() {
    if (!this.room) return;
    await this.ctx.storage.put("room", this.room);
    const deadlines = this.room.players.flatMap(p => p.offlineAt === undefined ? [] : [p.offlineAt + RECONNECT_MS]);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment?.playerId || !this.room) return;
    try {
      if (typeof message !== "string" || message.length > 1024) throw new Error("消息格式不正确。");
      const now = Date.now();
      if (attachment.lastMessageAt && now - attachment.lastMessageAt < 150) throw new Error("操作太快，请稍后重试。");
      attachment.lastMessageAt = now;
      ws.serializeAttachment(attachment);
      const player = this.room.players.find(p => p.id === attachment.playerId);
      if (!player) throw new Error("你已离开房间。");
      const action = JSON.parse(message) as ClientAction;
      if (!action || typeof action !== "object") throw new Error("消息格式不正确。");
      switch (action.type) {
        case "start": {
          if (player.id !== this.room.hostId) throw new Error("只有房主可以开始游戏。");
          if (this.room.phase === "playing") throw new Error("本局还没有结束。");
          if (this.room.players.length < MIN_PLAYERS) throw new Error("至少需要 2 位玩家。");
          if (this.room.players.some(p => !this.sockets(p.id).length)) throw new Error("还有玩家未连接，请等他们回来。");
          this.room.round = createRound(this.room.players, (this.room.round?.number ?? 0) + 1, randomInt);
          this.room.phase = "playing";
          break;
        }
        case "bid":
          if (this.room.phase !== "playing" || !this.room.round) throw new Error("当前不在对局中。");
          placeBid(this.room.round, player.id, action.count, action.face);
          break;
        case "challenge":
          if (this.room.phase !== "playing" || !this.room.round) throw new Error("当前不在对局中。");
          challenge(this.room.round, player.id);
          this.room.phase = "finished";
          break;
        case "leave":
          this.forfeit(player.id, "leave");
          this.room.players = this.room.players.filter(p => p.id !== player.id);
          this.reassignHost();
          this.send(ws, { type: "left" });
          ws.serializeAttachment({ playerId: "" });
          ws.close(1000, "已离开房间");
          break;
        default: throw new Error("不支持的操作。");
      }
      if (!this.room.players.length) { await this.destroy(); return; }
      await this.save();
      this.broadcast();
    } catch (error) {
      this.send(ws, { type: "error", message: error instanceof SyntaxError ? "消息格式不正确。" : error instanceof Error ? error.message : "操作失败。" });
    }
  }

  private forfeit(id: string, reason: "disconnect" | "leave") {
    if (this.room?.phase === "playing" && this.room.round?.playerIds.includes(id)) {
      this.room.round.outcome = { loserId: id, reason };
      this.room.phase = "finished";
    }
  }

  private reassignHost() {
    if (!this.room) return;
    if (!this.room.players.some(p => p.id === this.room!.hostId)) {
      this.room.hostId = (this.room.players.find(p => this.sockets(p.id).length) ?? this.room.players[0])?.id ?? "";
    }
  }

  private async disconnected(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    ws.serializeAttachment({ playerId: "" });
    if (!attachment?.playerId || !this.room) return;
    const player = this.room.players.find(p => p.id === attachment.playerId);
    if (player && !this.sockets(player.id).length) {
      player.offlineAt = Date.now();
      await this.save();
      this.broadcast();
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason); } catch { /* Already closed. */ }
    await this.disconnected(ws);
  }

  async webSocketError(ws: WebSocket) { await this.disconnected(ws); }

  async alarm() {
    if (!this.room) return;
    const expired = this.room.players
      .filter(p => p.offlineAt !== undefined && p.offlineAt + RECONNECT_MS <= Date.now())
      .sort((a, b) => a.offlineAt! - b.offlineAt!);
    for (const p of expired) {
      this.forfeit(p.id, "disconnect");
      this.room.players = this.room.players.filter(player => player.id !== p.id);
    }
    this.reassignHost();
    if (!this.room.players.length) { await this.destroy(); return; }
    await this.save();
    this.broadcast();
  }

  private async destroy() {
    this.room = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
