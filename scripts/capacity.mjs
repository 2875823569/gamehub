import assert from "node:assert/strict";
const base = process.env.GAMEHUB_TEST_URL ?? "http://127.0.0.1:8787";
const clients = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(label); await pause(25); }
}
async function post(path, name) {
  const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  return { status: response.status, data: await response.json() };
}
async function connect(session) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + `/api/rooms/${session.code}/socket?token=${session.token}`);
  const client = { ws, session, state: null };
  clients.push(client);
  ws.addEventListener("message", e => { const data = JSON.parse(e.data); if (data.type === "state") client.state = data.state; });
  await until(() => client.state, "connect");
  return client;
}
try {
  const { data: session } = await post("/api/rooms", "六人房主");
  const host = await connect(session);
  for (let i = 2; i <= 6; i++) await connect((await post(`/api/rooms/${session.code}/join`, `朋友${i}`)).data);
  assert.equal((await post(`/api/rooms/${session.code}/join`, "第七位")).status, 409);
  host.ws.send(JSON.stringify({ type: "start" }));
  await until(() => clients.every(c => c.state.phase === "playing"), "six players started");
  for (const c of clients) {
    assert.equal(c.state.players.length, 6);
    assert.equal(c.state.round.playerIds.length, 6);
    assert.equal(c.state.round.yourDice.length, 5);
    assert.equal(c.state.round.revealedDice, undefined);
  }
  await pause(200);
  host.ws.send(JSON.stringify({ type: "leave" }));
  await until(() => clients.slice(1).every(c => c.state.phase === "finished"), "host leaves");
  assert.notEqual(clients[1].state.hostId, session.playerId);
  assert.equal(clients[1].state.round.outcome.loserId, session.playerId);
  for (const c of clients.slice(1)) {
    await pause(180);
    c.ws.send(JSON.stringify({ type: "leave" }));
  }
  console.log("PASS: six simultaneous players, room capacity, private hands, host forfeiture and ownership transfer");
} finally {
  for (const c of clients) c.ws.close();
}
