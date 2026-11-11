import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { HostGame } from "../packages/host-game.ts";

const port = process.env.GAMEHUB_PROTOCOL_PORT ?? "18971";
const base = `http://127.0.0.1:${port}`;
const directory = resolve("work", `protocol-${Date.now()}`);
mkdirSync(directory, { recursive: true });
let server;
const clients = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 7000;
  while (!(await fn())) { if (Date.now() > end) throw new Error(label); await pause(30); }
}
async function start() {
  server = spawn(process.execPath, ["--import", "tsx", "services/rooms/server.ts"], {
    env: { ...process.env, GAMEHUB_PORT: port, GAMEHUB_DATA_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  let output = "";
  server.stdout.on("data", b => { output += b; });
  server.stderr.on("data", b => { output += b; });
  await until(() => {
    if (server.exitCode !== null) throw new Error(`Test server failed: ${output}`);
    return output.includes("PLAYROOM Node server:");
  }, "server starts");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise(r => server.once("exit", r));
  server.kill();
  await done;
}
async function post(path, body) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 201);
  return res.json();
}
async function connect(session) {
  const ws = new WebSocket(base.replace("http:", "ws:") + `/api/rooms/${session.code}/socket?token=${session.token}`);
  const c = { ws, session, messages: [], roster: undefined, snapshot: undefined };
  clients.push(c);
  ws.onmessage = event => {
    if (event.data === "pong") return;
    const m = JSON.parse(event.data);
    c.messages.push(m);
    if (m.type === "peer-roster") { c.roster = m.roster; c.snapshot = m.snapshot; }
  };
  await until(() => c.roster, "roster received");
  return c;
}
function send(c, m) { c.ws.send(JSON.stringify(m)); }
async function rejected(c, m, pattern) {
  const before = c.messages.length;
  send(c, m);
  await until(() => c.messages.slice(before).some(m => m.type === "error"), "malicious frame rejected");
  assert.match(c.messages.slice(before).find(m => m.type === "error").message, pattern);
}
try {
  await start();
  const h = await post("/api/rooms", { name: "协议房主", network: "p2p" });
  let host = await connect(h);
  const a = await post(`/api/rooms/${h.code}/join`, { name: "协议甲" });
  const b = await post(`/api/rooms/${h.code}/join`, { name: "协议乙" });
  let guest = await connect(a);
  const third = await connect(b);
  await until(() => host.roster.players.every(p => p.connected), "all members connected");
  const engine = new HostGame(host.roster, undefined, () => 0);
  engine.act(h.playerId, { type: "start", requestId: "start" }, 1000);
  const snapshot = engine.snapshot();
  send(host, { type: "peer-checkpoint", epoch: 1, snapshot });
  await until(() => host.messages.some(m => m.type === "peer-saved" && m.revision === snapshot.revision), "checkpoint committed");
  await rejected(guest, { type: "peer-checkpoint", epoch: 1, snapshot }, /只有房主/);
  await rejected(guest, { type: "peer-relay", epoch: 1, to: b.playerId, payload: { type: "sync" } }, /只能/);
  await rejected(guest, { type: "peer-relay", epoch: 1, to: h.playerId, payload: { type: "message", message: { type: "left" } } }, /伪造/);
  await rejected(guest, { type: "peer-relay", epoch: 0, to: h.playerId, payload: { type: "sync" } }, /更换/);
  send(guest, { type: "peer-relay", from: h.playerId, epoch: 1, to: h.playerId, payload: { type: "sync" } });
  await until(() => host.messages.some(m => m.type === "peer-relay"), "authenticated relay delivered");
  assert.equal(host.messages.find(m => m.type === "peer-relay").from, a.playerId);
  assert.ok(guest.messages.every(m => m.type !== "peer-roster" || !m.snapshot));
  assert.equal(JSON.stringify(guest.messages).includes(h.token), false);
  const staleTarget = guest.roster.players.find(p => p.id === a.playerId).connectionId;
  const old = guest;
  guest = await connect(a);
  await until(() => old.ws.readyState === WebSocket.CLOSED, "duplicate identity replaces old socket");
  assert.notEqual(guest.roster.players.find(p => p.id === a.playerId).connectionId, staleTarget);
  send(host, { type: "peer-signal", to: a.playerId, epoch: 1, connectionId: staleTarget, negotiation: "old", signal: { description: { type: "offer", sdp: "old" } } });
  await pause(100);
  assert.ok(!guest.messages.some(m => m.type === "peer-signal"));
  console.log("PASS relay identity, membership ACL, private checkpoint, stale epoch and replaced connection isolation");

  await stop();
  await start();
  host = await connect(h);
  guest = await connect(a);
  assert.deepEqual(host.snapshot.round.dice, snapshot.round.dice);
  assert.equal(host.snapshot.receipts[0].requestId, "start");
  assert.equal(guest.snapshot, undefined);
  send(host, { type: "leave" });
  await until(() => guest.roster.hostId === a.playerId && guest.roster.epoch === 2, "new host elected");
  assert.deepEqual(guest.snapshot.round.dice, snapshot.round.dice);
  const next = new HostGame(guest.roster, guest.snapshot);
  assert.equal(next.view(a.playerId).phase, "finished");
  console.log("PASS service restart restores identities/checkpoint; host migration ends the interrupted round");
} finally {
  for (const c of clients) c.ws.close();
  await stop();
}
