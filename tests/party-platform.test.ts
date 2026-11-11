import assert from "node:assert/strict";
import test from "node:test";
import { partyGames } from "../packages/games/registry";
import { games } from "../apps/web/src/platform/catalog";
import { partyRoomView } from "../apps/web/src/games/party/view";
import type { GameContext } from "../packages/games/core";
import type { RoomView } from "../packages/protocol";

test("all registered games match their public player limits and survive persisted timeout progression", () => {
  assert.equal(partyGames.size, 11);
  assert.equal(games.length, 12);
  assert.deepEqual([...new Set(games.map(game => game.category))], ["行酒令", "其他"]);
  assert.equal(games.filter(game => game.category === "行酒令").length, 11);
  assert.equal(games.find(game => game.id === "defuse")?.category, "其他");
  for (const [id, game] of partyGames) {
    const meta = games.find(g => g.id === id)!;
    assert.ok(meta, id);
    assert.equal(meta.minPlayers, game.minPlayers, id);
    assert.equal(meta.maxPlayers, game.maxPlayers, id);
    const players = Array.from({ length: game.maxPlayers }, (_, i) => ({ id: `p${i}`, name: `朋友${i}` }));
    const ctx: GameContext = { now: 1000, randomInt: max => max - 1, hostId: players[0].id, roundNumber: 1 };
    let state = game.create(players, ctx);
    let alarms = 0;
    while (state.status === "playing" && alarms++ < 1000) {
      const saved = JSON.stringify(state);
      for (const viewer of [players[0].id, players.at(-1)!.id, "spectator"]) {
        const view = game.display(state, viewer, ctx);
        assert.ok(view.title && view.prompt, `${id}: no usable display`);
        if (viewer === "spectator") {
          assert.equal((view.choices ?? []).length, 0, id);
          assert.equal(view.input, undefined, id);
        }
      }
      assert.equal(JSON.stringify(state), saved, `${id}: display mutates persisted state`);
      assert.ok(state.deadline !== undefined && Number.isFinite(state.deadline), `${id}: idle round cannot advance`);
      ctx.now = state.deadline!;
      game.timeout!(state, ctx);
      // Persisted room recovery restores JSON data, not object prototypes.
      state = JSON.parse(JSON.stringify(state));
    }
    assert.equal(state.status, "finished", `${id}: never terminates`);
    assert.equal(state.deadline, undefined, `${id}: ended round still schedules alarms`);
    assert.ok(game.display(state, players[0].id, ctx).result, `${id}: missing outcome`);
  }
});

test("shared room renderer escapes nicknames, submitted text, controls and results", () => {
  const hostile = '<img src=x onerror="bad">';
  const room: RoomView = {
    revision: 1,
    gameId: "truth-or-dare", minPlayers: 2, maxPlayers: 10,
    code: "ABC234", phase: "playing", hostId: "p1", you: "p1",
    players: [{ id: "p1", name: hostile, connected: true }],
    party: {
      number: 1, playerIds: ["p1"],
      display: {
        title: hostile, prompt: hostile, notice: hostile,
        cards: [hostile], history: [hostile],
        rows: [{ label: hostile, value: hostile }],
        choices: [{ id: hostile, label: hostile, value: hostile }],
        input: { id: "answer", label: hostile, type: "text", placeholder: hostile }
      }
    }
  };
  const html = partyRoomView(room, { connected: true, connectionLabel: "已连接", pending: false });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes('data-value=""'));
  room.phase = "finished";
  room.party!.interrupted = hostile;
  assert.ok(!partyRoomView(room, { connected: true, connectionLabel: "已连接", pending: false }).includes("<img"));
});
