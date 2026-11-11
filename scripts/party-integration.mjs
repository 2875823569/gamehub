import assert from "node:assert/strict";

const base = process.env.GAMEHUB_TEST_URL ?? "http://127.0.0.1:8787";
const ids = ["kings-cup", "never-have-i-ever", "truth-or-dare", "most-likely-to", "would-you-rather", "ride-the-bus", "number-bomb", "sevens", "categories", "thirty-one"];
const selectedIds = process.env.GAMEHUB_TEST_GAMES?.split(",") ?? ids;
assert.ok(selectedIds.length && selectedIds.every(id => ids.includes(id)), "Unknown GAMEHUB_TEST_GAMES");
const sockets = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timeout: ${label}`);
    await pause(20);
  }
}
async function post(path, body, status = 201) {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await r.json();
  assert.equal(r.status, status, JSON.stringify(value));
  return value;
}
async function connect(session) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${session.code}/socket?token=${session.token}`);
  sockets.push(ws);
  const client = { ws, session, state: undefined, errors: [], messages: 0, lastSent: 0, raw: [], replies: new Map(), left: false, closed: "" };
  const heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send("ping"); }, 15000);
  ws.addEventListener("close", event => { client.closed = `${event.code} ${event.reason}`; clearInterval(heartbeat); });
  ws.addEventListener("error", () => { clearInterval(heartbeat); });
  ws.addEventListener("message", e => {
    if (e.data === "pong") return;
    const msg = JSON.parse(e.data);
    client.messages++;
    client.raw.push(msg);
    if (msg.type === "state") client.state = msg.state;
    if (msg.type === "error") client.errors.push(msg.message);
    if (msg.requestId) client.replies.set(msg.requestId, msg);
    if (msg.type === "left") client.left = true;
  });
  await until(() => client.state, "connect");
  return client;
}
async function send(client, action, expectedError = false) {
  await pause(Math.max(0, 180 - (Date.now() - client.lastSent)));
  const errors = client.errors.length;
  const requestId = crypto.randomUUID();
  client.ws.send(JSON.stringify({ ...action, requestId }));
  client.lastSent = Date.now();
  await until(() => client.replies.has(requestId) || action.type === "leave" && client.left || client.closed, JSON.stringify(action));
  if (client.closed && !client.left && !client.replies.has(requestId)) throw new Error(`WebSocket closed before response: ${client.closed}`);
  if (expectedError) assert.ok(client.errors.length > errors, `Expected rejection: ${JSON.stringify(action)}`);
  else assert.equal(client.errors.length, errors, `${JSON.stringify(action)}: ${client.errors.at(-1)}`);
  return client.replies.get(requestId)?.revision ?? client.state.revision;
}
function choose(display) {
  if (display.input) return undefined;
  const choices = (display.choices ?? []).filter(c => !c.disabled);
  // Exercise real gameplay and scoring, including text submission where offered.
  return choices.find(c => c.id === "draw")
    ?? choices.find(c => c.id === "next")
    ?? choices.find(c => c.id === "choose")
    ?? choices.find(c => c.id === "done")
    ?? choices.find(c => c.id !== "skip" && c.id !== "redraw" && c.value !== "skip")
    ?? choices[0];
}
async function drive(clients, id) {
  const started = Date.now();
  let wordCount = 0;
  for (let n = 0; n < 450; n++) {
    if (clients[0].state.phase === "finished") return n;
    if (Date.now() - started > 120000) throw new Error(`${id}: game did not finish in two minutes`);
    let acted = false;
    for (const client of clients) {
      const display = client.state.party?.display;
      if (!display || client.state.phase === "finished") continue;
      const choice = choose(display);
      if (choice) {
        const revision = await send(client, { type: "game", action: { type: choice.id, ...(choice.value === undefined ? {} : { value: choice.value }) } });
        await until(() => clients.every(c => c.state.revision >= revision), `${id}: broadcast action to all players`);
        acted = true;
        break;
      }
      if (display.input) {
        const field = display.input;
        const value = field.type === "number" ? Math.floor(((field.min ?? 1) + (field.max ?? 100)) / 2)
          : id === "categories" ? ["苹果", "香蕉", "葡萄", "西瓜", "橙子", "草莓", "芒果", "梨", "桃子"][wordCount++]
          : `测试回答${n}`;
        const revision = await send(client, { type: "game", action: { type: field.id, value } });
        await until(() => clients.every(c => c.state.revision >= revision), `${id}: broadcast input to all players`);
        acted = true;
        break;
      }
    }
    if (!acted) await pause(150);
  }
  throw new Error(`${id}: too many actions`);
}

try {
  const health = await fetch(`${base}/api/health`).then(r => r.json());
  assert.equal(health.games.length, 12);
  await post("/api/rooms", { name: "错误游戏", gameId: "not-a-game" }, 400);
  await post("/api/rooms", null, 400);
  for (const id of selectedIds) {
    const hostSession = await post("/api/rooms", { name: "联机甲", gameId: id });
    const host = await connect(hostSession);
    const guest = await connect(await post(`/api/rooms/${hostSession.code}/join`, { name: "联机乙" }));
    let third = await connect(await post(`/api/rooms/${hostSession.code}/join`, { name: "联机丙" }));
    await until(() => [host, guest, third].every(c => c.state.players.length === 3 && c.state.players.every(p => p.connected)), "roster");
    assert.equal(host.state.gameId, id);
    await send(guest, { type: "start" }, true);
    await send(host, { type: "start" });
    await until(() => [host, guest, third].every(c => c.state.phase === "playing"), "game start");
    assert.equal(host.state.party.playerIds.length, 3);
    assert.equal(host.state.round, undefined);
    assert.ok(host.state.party.display.prompt);
    for (const client of [host, guest, third]) {
      assert.equal(client.state.party.state, undefined, "Raw game state must never leave server");
      assert.ok(client.state.players.every(p => !("token" in p)));
      assert.ok(!JSON.stringify(client.raw).includes(hostSession.token));
    }
    await send(guest, { type: "game", action: { type: "__invalid__" } }, true);
    const spectator = await connect(await post(`/api/rooms/${hostSession.code}/join`, { name: "迟到朋友" }));
    assert.ok(!spectator.state.party.playerIds.includes(spectator.session.playerId));
    assert.equal(spectator.state.party.display.input, undefined);
    assert.equal((spectator.state.party.display.choices ?? []).length, 0);
    await send(spectator, { type: "game", action: { type: "skip" } }, true);
    await send(spectator, { type: "leave" });
    await until(() => [host, guest, third].every(c => c.state.players.length === 3), "spectator leave broadcast");
    assert.equal(host.state.phase, "playing");
    // Reconnect a non-host during the running game using the same session.
    third.ws.close();
    third = await connect(third.session);
    await until(() => [host, guest, third].every(c => c.state.players.every(p => p.connected)), "reconnect broadcast");
    assert.equal(third.state.you, third.session.playerId);
    assert.equal(third.state.party.number, 1);
    const moves = await drive([host, guest, third], id);
    await until(() => [host, guest, third].every(c => c.state.phase === "finished"), "broadcast finish");
    assert.ok(host.state.party.display.result, `${id} must show result`);
    await send(host, { type: "start" });
    await until(() => host.state.party.number === 2 && host.state.phase === "playing", "rematch");
    await send(guest, { type: "leave" });
    await until(() => host.state.phase === "finished" && host.state.party.interrupted, "participant leave stops round");
    await send(host, { type: "leave" });
    await send(third, { type: "leave" });
    console.log(`PASS ${id}: create, host permission, private view, spectator, reconnect, full game (${moves} moves), rematch, leave`);
  }
  // Verify a real server timer, not merely a unit-level timeout call.
  const hs = await post("/api/rooms", { name: "计时甲", gameId: "sevens" });
  const host = await connect(hs);
  const a = await connect(await post(`/api/rooms/${hs.code}/join`, { name: "计时乙" }));
  const b = await connect(await post(`/api/rooms/${hs.code}/join`, { name: "计时丙" }));
  await until(() => host.state.players.length === 3, "alarm roster");
  await send(host, { type: "start" });
  await until(() => host.state.phase === "finished", "real server deadline", 15000);
  assert.match(host.state.party.display.result, /超时|时间|秒内/);
  for (const client of [host, a, b]) await send(client, { type: "leave" });
  console.log("PASS server alarm: sevens timeout persisted and broadcast");
  console.log(`PASS ${selectedIds.length} selected real multiplayer games`);
} finally {
  for (const ws of sockets) if (ws.readyState < 2) ws.close();
}
