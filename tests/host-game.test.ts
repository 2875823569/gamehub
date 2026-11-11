import { test } from "node:test";
import assert from "node:assert/strict";
import { HostGame } from "../packages/host-game";
import { partyGames } from "../packages/games/registry";
import type { PeerRoster } from "../packages/peer-protocol";

const roster = (gameId = "liars-dice", count = 3): PeerRoster => ({
  code: "ABC234", hostId: "p0", you: "p0", gameId, epoch: 1, revision: 1,
  players: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `玩家${i}`, connected: true, connectionId: `c${i}` }))
});
test("P2P host enforces permissions, private hands and exactly-once relay retries across recovery", () => {
  const r = roster();
  const game = new HostGame(r, undefined, () => 0);
  assert.equal(game.act("p1", { type: "start", requestId: "bad" }, 1000).type, "error");
  assert.equal(game.act("p0", { type: "start", requestId: "start" }, 1000).type, "ack");
  assert.equal(game.view("p1").round?.yourDice.length, 5);
  assert.equal(game.view("p1").round?.revealedDice, undefined);
  assert.equal("dice" in game.view("p1").round!, false);
  const action = { type: "bid", count: 3, face: 2, requestId: "bid" } as const;
  const ack = game.act("p0", action, 1200);
  assert.equal(ack.type, "ack");
  assert.deepEqual(game.act("p0", action, 1201), ack);
  const restored = new HostGame(r, game.snapshot());
  assert.deepEqual(restored.act("p0", action, 1500), ack);
  assert.equal(restored.view("p1").round?.bids.length, 1);
  assert.equal(restored.act("p2", { type: "bid", count: 4, face: 2, requestId: "wrong-turn" }, 2000).type, "error");
  assert.equal(restored.view("p1").round?.bids.length, 1);
});
test("P2P reconnect preserves a round; leaving or host migration ends it without exposing active hands", () => {
  const r = roster();
  const game = new HostGame(r, undefined, () => 0);
  game.act("p0", { type: "start", requestId: "s" }, 1000);
  const before = game.view("p1").round?.yourDice;
  r.players[1].connected = false;
  game.reconcile(r);
  assert.equal(game.view("p0").phase, "playing");
  r.players[1].connected = true;
  const refreshed = new HostGame(r, JSON.parse(JSON.stringify(game.snapshot())));
  assert.deepEqual(refreshed.view("p1").round?.yourDice, before);
  const migrated = { ...r, hostId: "p1", you: "p1", epoch: 2, players: r.players.slice(1) };
  const next = new HostGame(migrated, refreshed.snapshot());
  assert.equal(next.view("p1").phase, "finished");
  assert.equal(next.view("p1").round?.outcome?.loserId, "p0");
  assert.equal(next.act("p0", { type: "start", requestId: "old-host" }, 3000).type, "error");
  assert.equal(next.act("p1", { type: "start", requestId: "new-host" }, 3000).type, "ack");
});
test("all party games run and recover in host mode; overdue actions cannot beat the deadline", () => {
  for (const definition of partyGames.values()) {
    const r = roster(definition.id, Math.max(3, definition.minPlayers));
    const game = new HostGame(r);
    assert.equal(game.act("p0", { type: "start", requestId: "start" }, 1000).type, "ack", definition.id);
    const saved = game.snapshot();
    const restored = new HostGame(r, saved);
    for (const p of r.players) assert.deepEqual(restored.view(p.id, 1001).party, game.view(p.id, 1001).party);
    const deadline = saved.party?.state.deadline;
    if (deadline !== undefined) {
      const reply = restored.act("p1", { type: "game", action: { type: "invalid" }, requestId: "late" }, deadline);
      assert.equal(reply.type, "error");
      if (reply.type === "error") assert.match(reply.message, /时间已到/);
      assert.ok(restored.snapshot().party?.state.deadline !== deadline);
    }
  }
});
