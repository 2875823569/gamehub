import assert from "node:assert/strict";
const base = process.env.GAMEHUB_TEST_URL ?? "http://127.0.0.1:8787";
const clients = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await pause(40);
  }
}
async function post(path, name) {
  const response = await fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(base).origin },
    body: JSON.stringify({ name })
  });
  assert.equal(response.status, 201);
  return response.json();
}
async function connect(session) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + `/api/rooms/${session.code}/socket?token=${session.token}`);
  const client = { ws, session, state: null, errors: [] };
  clients.push(client);
  ws.addEventListener("message", e => {
    if (e.data === "pong") return;
    const message = JSON.parse(e.data);
    if (message.type === "state") client.state = message.state;
    if (message.type === "error") client.errors.push(message.message);
  });
  await until(() => client.state, "connected");
  return client;
}
async function action(client, action) {
  await pause(180);
  client.ws.send(JSON.stringify(action));
}
async function denied(client, request, pattern) {
  const previous = client.errors.length;
  await action(client, request);
  await until(() => client.errors.length > previous, "invalid action rejected");
  assert.match(client.errors.at(-1), pattern);
}
let live = [];
try {
  assert.match((await fetch(base + "/api/health").then(r => r.json())).rulesVersion, /^2026-11-(?:09(?:-party)?|10-p2p)$/);
  const host = await connect(await post("/api/rooms", "规则房主"));
  const code = host.session.code;
  live = [host];
  for (let i = 2; i <= 3; i++) live.push(await connect(await post(`/api/rooms/${code}/join`, `规则玩家${i}`)));
  await action(host, { type: "start" });
  await until(() => live.every(c => c.state.phase === "playing"), "start");
  const current = () => live.find(c => c.session.playerId === host.state.round.turnId);
  const bid = async (count, face, mode) => {
    const length = host.state.round.bids.length;
    await action(current(), { type: "bid", count, face, mode });
    await until(() => live.every(c => c.state.round.bids.length === length + 1), "bid synchronized");
  };
  await denied(current(), { type: "bid", count: 2, face: 2 }, /加码/);
  await bid(5, 6, "normal");
  await bid(3, 6, "zhai");
  await bid(3, 1);
  assert.equal(host.state.round.bids.at(-1).mode, "zhai");
  await denied(current(), { type: "bid", count: 5, face: 2, mode: "fly" }, /加码/);
  await denied(current(), { type: "bid", count: 6, face: 1, mode: "fly" }, /加码/);
  await bid(6, 2, "fly");
  const bidder = live.find(c => c.session.playerId === host.state.round.bids.at(-1).playerId);
  const slasher = live.find(c => c !== bidder && c !== current());
  await action(slasher, { type: "slash" });
  await until(() => live.every(c => c.state.round.pendingSlash), "off-turn slash pending");
  assert.ok(live.every(c => !c.state.round.outcome && !c.state.round.revealedDice));
  await denied(current(), { type: "challenge" }, /等待/);
  await denied(slasher, { type: "respond-slash", counter: true }, /只有/);
  const savedHand = [...bidder.state.round.yourDice];
  bidder.ws.close();
  const restored = await connect(bidder.session);
  assert.deepEqual(restored.state.round.yourDice, savedHand);
  assert.equal(restored.state.round.pendingSlash.bidderId, bidder.session.playerId);
  live = live.map(c => c === bidder ? restored : c);
  await action(restored, { type: "respond-slash", counter: true });
  await until(() => live.every(c => c.state.phase === "finished"), "counter slash settles");
  assert.ok(live.every(c => c.state.round.outcome.multiplier === 4 && !c.state.round.pendingSlash));
  const loser = restored.state.round.outcome.loserId;
  const liveHost = live.find(c => c.session.playerId === host.session.playerId);
  await action(liveHost, { type: "start" });
  await until(() => live.every(c => c.state.phase === "playing" && c.state.round.number === 2), "rematch");
  assert.ok(live.every(c => c.state.round.turnId === loser));
  const starter = live.find(c => c.session.playerId === loser);
  await action(starter, { type: "bid", count: 3, face: 2 });
  await until(() => live.every(c => c.state.round.bids.length === 1), "new round bid");
  const challenger = live.find(c => c !== starter);
  await action(challenger, { type: "slash" });
  await until(() => starter.state.round.pendingSlash, "second slash");
  await action(starter, { type: "respond-slash", counter: false });
  await until(() => live.every(c => c.state.phase === "finished"), "accept slash");
  assert.ok(live.every(c => c.state.round.outcome.multiplier === 2));
  await denied(starter, { type: "respond-slash", counter: true }, /不在对局/);
  console.log("PASS: opening minimum, zhai, calling 1, fly validation, off-turn slash, hidden dice, response authorization, reconnect, x4/x2 settlement, loser starts");
  // End a pending slash through a real leave, verifying it cannot be settled twice.
  await action(liveHost, { type: "start" });
  await until(() => live.every(c => c.state.phase === "playing" && c.state.round.number === 3), "third round");
  const thirdStarter = live.find(c => c.session.playerId === liveHost.state.round.turnId);
  await action(thirdStarter, { type: "bid", count: 3, face: 2 });
  await until(() => live.every(c => c.state.round.bids.length === 1), "third bid");
  const thirdSlasher = live.find(c => c !== thirdStarter);
  await action(thirdSlasher, { type: "slash" });
  await until(() => thirdStarter.state.round.pendingSlash, "third slash");
  await action(thirdSlasher, { type: "leave" });
  const remaining = live.filter(c => c !== thirdSlasher);
  await until(() => remaining.every(c => c.state.phase === "finished"), "leave cancels pending slash");
  assert.ok(remaining.every(c => !c.state.round.pendingSlash && c.state.round.outcome.reason === "leave" && c.state.round.outcome.multiplier === 1));
  live = remaining;
  console.log("PASS: leaving during pending slash ends the round once and clears the pending response");
} finally {
  for (const c of live) {
    if (c.ws.readyState === WebSocket.OPEN) {
      await action(c, { type: "leave" });
    }
  }
  await pause(300);
  for (const c of clients) c.ws.close();
}
