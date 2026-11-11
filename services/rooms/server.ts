import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, statSync, createReadStream } from "node:fs";
import { resolve, join, extname, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { HostGame, type HostSnapshot } from "../../packages/host-game";
import { partyGames } from "../../packages/games/registry";
import { randomInt, RECONNECT_MS, MAX_PLAYERS } from "../../packages/games/liars-dice/rules";
import { MAX_PEER_MESSAGE, type PeerRoster, type PeerClientMessage } from "../../packages/peer-protocol";
import type { ClientAction } from "../../packages/protocol";

interface Member { id: string; name: string; token: string; offlineAt?: number }
interface SavedRoom {
  code: string; gameId: string; network: "server" | "p2p";
  hostId: string; epoch: number; revision: number; players: Member[]; snapshot?: HostSnapshot;
}
interface Connection { ws: WebSocket; connectionId: string; windowAt: number; count: number; alive: boolean }
const dataDir = resolve(process.env.GAMEHUB_DATA_DIR ?? "work/rooms");
const distDir = resolve("dist");
mkdirSync(dataDir, { recursive: true });
const rooms = new Map<string, Room>();
const send = (ws: WebSocket, message: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
class Room {
  connections = new Map<string, Connection>();
  engine?: HostGame;
  constructor(readonly data: SavedRoom) {
    if (data.network === "server") this.engine = new HostGame(this.roster(data.hostId), data.snapshot);
  }
  roster(you: string): PeerRoster {
    return { code: this.data.code, gameId: this.data.gameId, hostId: this.data.hostId, epoch: this.data.epoch,
      revision: this.data.revision, you, players: this.data.players.map(p => ({
        id: p.id, name: p.name, connected: this.connections.has(p.id),
        connectionId: this.connections.get(p.id)?.connectionId,
        disconnectAt: p.offlineAt === undefined ? undefined : p.offlineAt + RECONNECT_MS
      })) };
  }
  persist() {
    if (this.engine) this.data.snapshot = this.engine.snapshot();
    const file = join(dataDir, `${this.data.code}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  changed(reason: "leave" | "disconnect" = "leave") {
    if (!this.data.players.length) {
      rooms.delete(this.data.code);
      const file = join(dataDir, `${this.data.code}.json`);
      if (existsSync(file)) unlinkSync(file);
      return;
    }
    if (!this.data.players.some(p => p.id === this.data.hostId)) {
      this.data.hostId = (this.data.players.find(p => this.connections.has(p.id)) ?? this.data.players[0]).id;
      this.data.epoch++;
    }
    this.data.revision++;
    this.engine?.reconcile(this.roster(this.data.hostId), reason);
    this.persist();
    this.broadcast();
  }
  broadcast() {
    const members = [...this.data.players].sort((a, b) => Number(b.id === this.data.hostId) - Number(a.id === this.data.hostId));
    for (const p of members) {
      const c = this.connections.get(p.id);
      if (!c) continue;
      if (this.engine) send(c.ws, { type: "state", state: this.engine.view(p.id) });
      else send(c.ws, { type: "peer-roster", roster: this.roster(p.id),
        ...(p.id === this.data.hostId ? { snapshot: this.data.snapshot } : {}) });
    }
  }
  connect(player: Member, ws: WebSocket) {
    const old = this.connections.get(player.id);
    if (old) old.ws.close(4001, "已在另一个页面连接");
    const c: Connection = { ws, connectionId: crypto.randomUUID(), windowAt: 0, count: 0, alive: true };
    this.connections.set(player.id, c);
    player.offlineAt = undefined;
    ws.on("pong", () => { c.alive = true; });
    ws.on("message", (buffer, binary) => {
      if (this.connections.get(player.id) !== c) return;
      const text = buffer.toString();
      if (text === "ping") { c.alive = true; ws.send("pong"); return; }
      try {
        if (binary || text.length > MAX_PEER_MESSAGE) throw new Error("消息过大或格式不正确。");
        if (Date.now() - c.windowAt > 1000) { c.windowAt = Date.now(); c.count = 0; }
        if (++c.count > 100) throw new Error("消息过于频繁。");
        const m = JSON.parse(text) as PeerClientMessage | ClientAction;
        if (!m || typeof m !== "object") throw new Error("消息格式不正确。");
        if (m.type === "leave") {
          this.connections.delete(player.id);
          this.data.players = this.data.players.filter(p => p.id !== player.id);
          send(ws, { type: "left" });
          ws.close(1000, "已离开房间");
          this.changed();
          return;
        }
        if (this.engine) {
          if (text.length > 1024 || m.type.startsWith("peer-")) throw new Error("消息格式不正确。");
          const action = m as ClientAction;
          const reply = this.engine.act(player.id, { ...action, requestId: action.requestId ?? crypto.randomUUID() });
          this.persist();
          this.broadcast();
          if (action.requestId || reply.type === "error") send(ws, reply);
          return;
        }
        this.peerMessage(player.id, c, m as PeerClientMessage, text.length);
      } catch (error) {
        send(ws, { type: "error", message: error instanceof Error ? error.message : "操作失败。" });
      }
    });
    const disconnected = () => {
      if (this.connections.get(player.id) !== c) return;
      this.connections.delete(player.id);
      player.offlineAt = Date.now();
      this.changed();
    };
    ws.on("close", disconnected);
    ws.on("error", () => ws.terminate());
    this.changed();
  }
  private peerMessage(playerId: string, c: Connection, message: PeerClientMessage, length: number) {
    if (message.type === "leave") return;
    if (message.epoch !== this.data.epoch) throw new Error("房主已更换，请等待同步。");
    if (message.type === "peer-checkpoint") {
      if (playerId !== this.data.hostId) throw new Error("只有房主可以备份对局。");
      const s = message.snapshot;
      if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
          !["lobby", "playing", "finished"].includes(s.phase) || !Array.isArray(s.receipts) || s.receipts.length > 256) throw new Error("对局备份格式错误。");
      if (!this.data.snapshot || s.revision > this.data.snapshot.revision) {
        this.data.snapshot = s;
        this.persist();
      }
      send(c.ws, { type: "peer-saved", revision: this.data.snapshot!.revision });
      return;
    }
    if (message.type !== "peer-signal" && message.type !== "peer-relay") throw new Error("不支持的操作。");
    if (!this.data.players.some(p => p.id === message.to) || message.to === playerId ||
        (playerId !== this.data.hostId && message.to !== this.data.hostId)) throw new Error("只能与当前房主通信。");
    const target = this.connections.get(message.to);
    if (message.type === "peer-signal") {
      if (length > 32_768 || typeof message.negotiation !== "string" || message.negotiation.length > 80) throw new Error("连接协商格式错误。");
      if (target?.connectionId === message.connectionId) send(target.ws, {
        type: "peer-signal", from: playerId, connectionId: c.connectionId,
        epoch: this.data.epoch, negotiation: message.negotiation, signal: message.signal
      });
    } else {
      if (!message.payload || (playerId !== this.data.hostId &&
          !["action", "sync", "ping", "pong"].includes(message.payload.type))) throw new Error("不能伪造房主消息。");
      if (playerId !== this.data.hostId && length > 4096) throw new Error("操作消息过大。");
      if (target) send(target.ws, { type: "peer-relay", from: playerId, epoch: this.data.epoch, payload: message.payload });
    }
  }
  tick() {
    const now = Date.now();
    const expired = this.data.players.filter(p => p.offlineAt !== undefined && p.offlineAt + RECONNECT_MS <= now);
    if (expired.length) {
      this.data.players = this.data.players.filter(p => !expired.includes(p));
      this.changed("disconnect");
    }
    if (rooms.has(this.data.code) && this.engine?.tick(now)) { this.persist(); this.broadcast(); }
  }
}

// Persisted identities survive service restarts, with a fresh reconnect window.
for (const file of readdirSync(dataDir).filter(name => /^[A-HJ-NP-Z2-9]{6}\.json$/.test(name))) {
  const data = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as SavedRoom;
  for (const p of data.players) p.offlineAt = Date.now();
  const room = new Room(data);
  rooms.set(data.code, room);
  room.persist();
}
const reply = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
};
function sameOrigin(req: IncomingMessage) {
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    const forwarded = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
    return ["http:", "https:"].includes(origin.protocol) && [req.headers.host, forwarded].includes(origin.host);
  } catch { return false; }
}
async function registration(req: IncomingMessage) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new Error("请求过大。"); }
  const data = JSON.parse(body);
  const name = typeof data?.name === "string" ? data.name.trim().replace(/[\u0000-\u001f\u007f]/g, "") : "";
  if (!name || [...name].length > 12) throw new Error("昵称需要 1～12 个字。");
  const gameId = data.gameId ?? "liars-dice";
  if (gameId !== "liars-dice" && !partyGames.has(gameId)) throw new Error("这个游戏不存在。");
  if (data.network !== undefined && !["p2p", "server"].includes(data.network)) throw new Error("联机模式无效。");
  return { name, gameId, network: data.network === "p2p" ? "p2p" as const : "server" as const };
}
const newMember = (name: string): Member => ({ id: crypto.randomUUID(), token: crypto.randomUUID(), name, offlineAt: Date.now() });
const session = (code: string, player: Member) => ({ code, playerId: player.id, token: player.token });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (!sameOrigin(req)) return reply(res, 403, { error: "不允许跨站请求。" });
      if (url.pathname === "/api/health" && req.method === "GET") return reply(res, 200, {
        ok: true, game: "liars-dice", games: ["liars-dice", ...partyGames.keys()],
        rulesVersion: "2026-11-10-p2p", runtime: "node", networks: ["server", "p2p"]
      });
      if (url.pathname === "/api/rooms" && req.method === "POST") {
        const { name, gameId, network } = await registration(req);
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code: string;
        do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(""); } while (rooms.has(code));
        const p = newMember(name);
        const room = new Room({ code, gameId, network, players: [p], hostId: p.id, epoch: 1, revision: 0 });
        rooms.set(code, room);
        room.persist();
        return reply(res, 201, session(code, p));
      }
      const match = url.pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/(join|socket)$/);
      if (!match) return reply(res, 404, { error: "房间码无效，或接口不存在。" });
      const room = rooms.get(match[1]);
      if (!room) return reply(res, 404, { error: "房间不存在或已关闭，请检查房间码。" });
      if (match[2] === "socket") return reply(res, 426, { error: "需要 WebSocket 连接。" });
      if (req.method !== "POST") return reply(res, 405, { error: "请求方法不正确。" });
      const { name } = await registration(req);
      const max = partyGames.get(room.data.gameId)?.maxPlayers ?? MAX_PLAYERS;
      if (room.data.players.length >= max) return reply(res, 409, { error: `房间已满，最多 ${max} 位玩家。` });
      if (room.data.players.some(p => p.name === name)) return reply(res, 409, { error: "房间里已有这个昵称，换一个吧。" });
      const p = newMember(name);
      room.data.players.push(p);
      room.changed();
      return reply(res, 201, session(room.data.code, p));
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    let file = resolve(distDir, `.${decodeURIComponent(url.pathname)}`);
    if (file !== distDir && !file.startsWith(distDir + sep)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || !statSync(file).isFile()) file = join(distDir, "index.html");
    if (!existsSync(file)) return reply(res, 503, { error: "请先运行 npm run build。" });
    const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp" };
    res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    reply(res, 400, { error: error instanceof SyntaxError ? "请求内容格式错误。" : error instanceof Error ? error.message : "操作失败。" });
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PEER_MESSAGE, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/socket$/);
  const room = match ? rooms.get(match[1]) : undefined;
  const player = room?.data.players.find(p => p.token === url.searchParams.get("token"));
  const status = !sameOrigin(req) ? 403 : !room ? 404 : !player ? 401 : 101;
  if (status !== 101) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); return; }
  wss.handleUpgrade(req, socket, head, ws => room!.connect(player!, ws));
});
setInterval(() => { for (const room of rooms.values()) room.tick(); }, 250).unref();
setInterval(() => {
  for (const room of rooms.values()) for (const c of room.connections.values()) {
    if (!c.alive) c.ws.terminate();
    else { c.alive = false; c.ws.ping(); }
  }
}, 30_000).unref();
server.listen(Number(process.env.GAMEHUB_PORT ?? 8787), "127.0.0.1", () => {
  console.log(`PLAYROOM Node server: http://127.0.0.1:${process.env.GAMEHUB_PORT ?? 8787}`);
});
