import assert from "node:assert/strict";

const base = process.env.GAMEHUB_TEST_URL ?? "http://127.0.0.1:8787";
const sockets = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function post(path, body, expected = 201) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}
async function connect(session) {
  const url = base.replace(/^http/, "ws") + `/api/rooms/${session.code}/socket?token=${session.token}`;
  const socket = new WebSocket(url);
  sockets.push(socket);
  const client = { socket, session, state: undefined, errors: [], raw: [] };
  socket.addEventListener("message", event => {
    if (event.data === "pong") return;
    const message = JSON.parse(event.data);
    client.raw.push(message);
    if (message.type === "state") client.state = message.state;
    if (message.type === "error") client.errors.push(message.message);
  });
  await until(() => client.state, "WebSocket initial state");
  return client;
}
async function until(predicate, label, timeout = 7000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await pause(30);
  }
}
async function action(client, data) {
  await pause(180);
  client.socket.send(JSON.stringify(data));
}

try {
  assert.equal((await fetch(`${base}/api/health`).then(r => r.json())).ok, true);
  const hostSession = await post("/api/rooms", { name: "测试房主" });
  const host = await connect(hostSession);
  const guestSession = await post(`/api/rooms/${hostSession.code}/join`, { name: "测试朋友" });
  const guest = await connect(guestSession);
  await until(() => host.state.players.length === 2, "two players");
  await post(`/api/rooms/${hostSession.code}/join`, { name: "测试朋友" }, 409);
  const originResponse = await fetch(`${base}/api/rooms`, {
    method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" })
  });
  assert.equal(originResponse.status, 403);
  const invalidSocket = new WebSocket(base.replace(/^http/, "ws") + `/api/rooms/${hostSession.code}/socket?token=wrong`);
  sockets.push(invalidSocket);
  let invalidRejected = false;
  invalidSocket.addEventListener("error", () => { invalidRejected = true; });
  invalidSocket.addEventListener("open", () => assert.fail("Invalid identity must not connect"));
  await until(() => invalidRejected, "invalid identity rejected");
  await action(guest, { type: "start" });
  await until(() => guest.errors.length === 1, "host-only start");
  assert.match(guest.errors[0], /房主/);
  await action(host, { type: "start" });
  await until(() => host.state.phase === "playing" && guest.state.phase === "playing", "start round");
  for (const client of [host, guest]) {
    assert.equal(client.state.round.yourDice.length, 5);
    assert.equal(client.state.round.revealedDice, undefined);
    assert.equal(client.state.round.dice, undefined);
    assert.ok(client.state.players.every(p => !("token" in p)));
    assert.equal(JSON.stringify(client.raw).includes(hostSession.token), false);
    assert.equal(JSON.stringify(client.raw).includes(guestSession.token), false);
  }
  const first = host.state.round.turnId === hostSession.playerId ? host : guest;
  const second = first === host ? guest : host;
  await action(second, { type: "bid", count: 1, face: 2 });
  await until(() => second.errors.some(e => /还没轮到/.test(e)), "out of turn denied");
  await action(first, { type: "bid", count: 1, face: 2 });
  await until(() => second.state.round.bids.length === 1, "bid broadcast");
  await action(second, { type: "bid", count: 1, face: 2 });
  await until(() => second.errors.some(e => /加码/.test(e)), "invalid raise denied");
  await action(second, { type: "challenge" });
  await until(() => host.state.phase === "finished" && guest.state.phase === "finished", "round finishes once challenged");
  const outcome = host.state.round.outcome;
  const actual = Object.values(host.state.round.revealedDice).flat().filter(v => v === 1 || v === 2).length;
  assert.equal(outcome.actualCount, actual);
  assert.equal(outcome.loserId, actual >= 1 ? second.session.playerId : first.session.playerId);
  assert.equal(Object.keys(host.state.round.revealedDice).length, 2);
  console.log("PASS: room creation, invitations, identity, private dice, turn enforcement, challenge and final reveal");

  await action(host, { type: "start" });
  await until(() => guest.state.phase === "playing" && guest.state.round.number === 2, "rematch");
  assert.equal(guest.state.round.bids.length, 0);
  const originalDice = [...guest.state.round.yourDice];
  guest.socket.close();
  await until(() => host.state.players.find(p => p.id === guestSession.playerId)?.connected === false, "disconnect detected");
  const reconnected = await connect(guestSession);
  assert.deepEqual(reconnected.state.round.yourDice, originalDice);
  assert.equal(reconnected.state.round.number, 2);
  assert.equal(reconnected.state.phase, "playing");
  console.log("PASS: rematch and reconnect restore the same private hand");

  const lateSession = await post(`/api/rooms/${hostSession.code}/join`, { name: "后来朋友" });
  const late = await connect(lateSession);
  assert.deepEqual(late.state.round.yourDice, []);
  assert.equal(late.state.round.playerIds.includes(lateSession.playerId), false);
  await action(late, { type: "challenge" });
  await until(() => late.errors.length > 0, "spectator cannot play");
  await action(reconnected, { type: "leave" });
  await until(() => host.state.phase === "finished", "leave ends round");
  assert.equal(host.state.round.outcome.loserId, guestSession.playerId);
  assert.equal(host.state.round.outcome.reason, "leave");
  await action(host, { type: "start" });
  await until(() => late.state.phase === "playing" && late.state.round.number === 3, "late joiner plays next round");
  assert.equal(late.state.round.yourDice.length, 5);
  console.log("PASS: late join waits, leaving forfeits immediately, next round includes waiting players");

  // Real Durable Object alarm, not a mocked client timer.
  late.socket.close();
  await until(() => host.state.players.find(p => p.id === lateSession.playerId)?.connected === false, "offline grace period");
  await pause(1200);
  assert.equal(host.state.phase, "playing");
  console.log("Checking the real 60-second disconnect alarm…");
  await until(() => host.state.phase === "finished", "60-second disconnect forfeit", 66_000);
  assert.equal(host.state.round.outcome.reason, "disconnect");
  assert.equal(host.state.round.outcome.loserId, lateSession.playerId);
  console.log("PASS: disconnect grace period and server alarm settle exactly one loser");
  await action(host, { type: "leave" });
  await pause(300);
  await post(`/api/rooms/${hostSession.code}/join`, { name: "房间已清理" }, 404);
  console.log("PASS: empty rooms clean up stored player identities and game state");
} finally {
  for (const ws of sockets) ws.close();
}
