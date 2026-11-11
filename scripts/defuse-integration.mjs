import assert from "node:assert/strict";

const base = process.env.GAMEHUB_TEST_URL ?? "http://127.0.0.1:8787";
const sockets = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timeout: ${label}`);
    await pause(20);
  }
}
async function post(path, body) {
  const response = await fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  return result;
}
async function connect(session) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${session.code}/socket?token=${session.token}`);
  sockets.push(ws);
  const client = { ws, session, state: undefined, replies: new Map(), left: false };
  ws.addEventListener("message", event => {
    if (event.data === "pong") return;
    const message = JSON.parse(event.data);
    if (message.type === "state") client.state = message.state;
    if (message.requestId) client.replies.set(message.requestId, message);
    if (message.type === "left") client.left = true;
  });
  await until(() => client.state, "connection");
  return client;
}
async function send(client, action, error) {
  await pause(180);
  const requestId = crypto.randomUUID();
  client.ws.send(JSON.stringify({ ...action, requestId }));
  await until(() => client.replies.has(requestId) || client.left, "action response");
  if (client.left) return;
  const reply = client.replies.get(requestId);
  if (error) assert.match(reply.message, error);
  else assert.equal(reply.type, "ack", JSON.stringify(reply));
  return reply;
}
const display = client => client.state.party.display;
const permutations = items => items.length ? items.flatMap((item, i) =>
  permutations(items.filter((_, j) => i !== j)).map(rest => [item, ...rest])) : [[]];

// Solve from player-visible clues only; never read server state or its answers.
function solve(clients, stage) {
  const clues = clients.flatMap(client => display(client).rows);
  assert.equal(clues.length, 6);
  assert.equal(new Set(clues.map(clue => clue.label)).size, 6);
  const values = clues.map(clue => clue.value);
  const cards = display(clients[0]).cards;
  if (stage === 0) {
    const unsafe = values.filter(clue => clue.includes("不能剪")).map(clue => clue[0]);
    const safe = cards.filter(card => !unsafe.includes(card.split(" · ")[1][0]));
    assert.equal(safe.length, 1);
    return safe[0][0];
  }
  if (stage === 1) {
    const sum = prefix => Number(values.find(clue => clue.startsWith(prefix)).match(/\d+/)[0]);
    const ab = sum("第一位与第二位"), bc = sum("第二位与第三位"), ac = sum("第一位与第三位");
    const a = (ab + ac - bc) / 2, b = ab - a, c = ac - a;
    return `${a}${b}${c}`;
  }
  const names = cards.map(card => card.slice(4));
  const pairs = values.filter(clue => clue.includes("前面")).map(clue => clue.slice(0, -3).split("在"));
  const solutions = permutations(names).filter(order => pairs.every(([a, b]) => order.indexOf(a) < order.indexOf(b)));
  assert.equal(solutions.length, 1);
  return solutions[0].map(name => names.indexOf(name) + 1).join("");
}
async function play(clients) {
  for (let stage = 0; stage < 3; stage++) {
    for (const client of clients) {
      assert.ok(display(client).rows.length >= 1);
      assert.equal("modules" in display(client), false);
      assert.equal(client.state.party.state, undefined);
    }
    const reply = await send(clients[stage % clients.length], {
      type: "game", action: { type: `solve-${stage}`, value: solve(clients, stage) }
    });
    await until(() => clients.every(client => client.state.revision >= reply.revision), "shared progress");
  }
  for (const client of clients) {
    assert.equal(client.state.phase, "finished");
    assert.match(display(client).result, /炸弹已解除/);
  }
}

try {
  const health = await fetch(`${base}/api/health`).then(r => r.json());
  assert.ok(health.games.includes("defuse"));
  const solo = await connect(await post("/api/rooms", { name: "单人拆弹测试", gameId: "defuse" }));
  assert.equal(solo.state.minPlayers, 1);
  await send(solo, { type: "start" });
  await play([solo]);
  await send(solo, { type: "start" });
  assert.equal(solo.state.party.number, 2);
  const safe = solve([solo], 0);
  for (let i = 0; i < 3; i++) await send(solo, {
    type: "game", action: { type: "solve-0", value: safe === "1" ? "2" : "1" }
  });
  assert.equal(solo.state.phase, "finished");
  assert.match(display(solo).result, /三次警报/);
  await send(solo, { type: "leave" });
  console.log("PASS solo: one-player start, solve all modules from clues, rematch, three-strike failure");

  const host = await connect(await post("/api/rooms", { name: "合作拆弹甲", gameId: "defuse" }));
  const join = name => post(`/api/rooms/${host.session.code}/join`, { name });
  let guest = await connect(await join("合作拆弹乙"));
  const third = await connect(await join("合作拆弹丙"));
  await until(() => host.state.players.every(player => player.connected) && host.state.players.length === 3, "roster");
  await send(guest, { type: "start" }, /只有房主/);
  await send(host, { type: "start" });
  await until(() => [host, guest, third].every(client => client.state.phase === "playing"), "start");
  const spectator = await connect(await join("观战测试"));
  assert.equal(display(spectator).rows.length, 0);
  assert.equal(display(spectator).choices.length, 0);
  await send(spectator, { type: "game", action: { type: "solve-0", value: "1" } }, /观战/);
  await send(spectator, { type: "leave" });
  const priorClues = display(guest).rows;
  const deadline = display(guest).deadline;
  guest.ws.close();
  guest = await connect(guest.session);
  assert.deepEqual(display(guest).rows, priorClues);
  assert.equal(display(guest).deadline, deadline);
  const clients = [host, guest, third];
  await until(() => clients.every(client => client.state.players.length === 3 && client.state.players.every(player => player.connected)), "reconnect");
  // Two teammates race to solve the same module: exactly one succeeds.
  const answer = solve(clients, 0);
  const action = { type: "game", action: { type: "solve-0", value: answer } };
  await pause(180);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  host.ws.send(JSON.stringify({ ...action, requestId: ids[0] }));
  guest.ws.send(JSON.stringify({ ...action, requestId: ids[1] }));
  await until(() => host.replies.has(ids[0]) && guest.replies.has(ids[1]), "concurrent solves");
  assert.deepEqual([host.replies.get(ids[0]).type, guest.replies.get(ids[1]).type].sort(), ["ack", "error"]);
  await until(() => clients.every(client => display(client).title.includes("模块二")), "stage transition");
  assert.ok(clients.every(client => display(client).progress.includes("失误 0/3")));
  for (let stage = 1; stage < 3; stage++) {
    const reply = await send(clients[stage], { type: "game", action: { type: `solve-${stage}`, value: solve(clients, stage) } });
    await until(() => clients.every(client => client.state.revision >= reply.revision), "co-op progress");
  }
  assert.ok(clients.every(client => client.state.phase === "finished" && display(client).result.includes("炸弹已解除")));
  await send(host, { type: "start" });
  await send(guest, { type: "leave" });
  await until(() => host.state.phase === "finished" && host.state.party.interrupted, "leave interrupts round");
  await send(host, { type: "leave" });
  await send(third, { type: "leave" });
  console.log("PASS co-op: private clues, spectator isolation, reconnect, concurrent actions, team victory, rematch, leave");
} finally {
  for (const ws of sockets) if (ws.readyState < 2) ws.close();
}
