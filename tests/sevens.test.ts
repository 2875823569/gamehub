import assert from "node:assert/strict";
import test from "node:test";
import { game, mustPass, type SevensState } from "../packages/games/sevens/rules";
import type { GameContext } from "../packages/games/core";

const players = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "c", name: "丙" }];
const context = (now = 1_000, roundNumber = 1): GameContext => ({ now, roundNumber, hostId: "a", randomInt: () => 0 });
const create = (round = 1) => game.create(players, context(1_000, round)) as SevensState;

test("含7或7的倍数才过，不混入重复双位数", () => {
  for (const n of [7, 17, 49, 70, 77]) assert.equal(mustPass(n), true);
  for (const n of [1, 6, 8, 11, 22, 33, 100]) assert.equal(mustPass(n), false);
});

test("正确报数按座次推进，每步独立8秒；先手按局号轮换", () => {
  const state = create();
  game.act(state, "a", { type: "say" }, context(2_000));
  assert.equal(state.number, 2);
  assert.equal(state.turn, 1);
  assert.equal(state.deadline, 10_000);
  assert.equal(state.correct.a, 1);
  assert.equal(create(2).turn, 1);
  assert.equal(create(4).turn, 0);
  for (let n = 2; n <= 7; n++) {
    game.act(state, state.playerIds[state.turn], { type: n === 7 ? "pass" : "say" }, context(2_000 + n));
  }
  assert.equal(state.number, 8);
  assert.equal(state.status, "playing");
});

test("漏过7与普通数字误过均失败，终局显示正确原因并拒绝重复动作", () => {
  const state = create();
  for (let n = 1; n < 7; n++) game.act(state, state.playerIds[state.turn], { type: "say" }, context(2_000 + n));
  game.act(state, "a", { type: "say" }, context(2_100));
  assert.equal(state.status, "finished");
  assert.equal(state.loserId, "a");
  assert.equal(state.deadline, undefined);
  assert.match(game.display(state, "a", context()).result!, /应该喊/);
  assert.deepEqual(game.display(state, "a", context()).choices, []);
  assert.throws(() => game.act(state, "a", { type: "pass" }, context(2_101)), /结束/);
  const normal = create();
  game.act(normal, "a", { type: "pass" }, context(2_000));
  assert.equal(normal.reason, "wrong");
  assert.match(game.display(normal, "a", context()).result!, /正常报数/);
});

test("角色、未知动作、带值动作与迟到动作均拒绝且不改状态", () => {
  const state = create();
  const before = structuredClone(state);
  assert.throws(() => game.act(state, "b", { type: "say" }, context()), /轮到/);
  assert.throws(() => game.act(state, "spectator", { type: "say" }, context()), /观战/);
  assert.throws(() => game.act(state, "a", { type: "cheat" }, context()), /请选择/);
  assert.throws(() => game.act(state, "a", { type: "say", value: 1 }, context()), /请选择/);
  assert.throws(() => game.act(state, "a", { type: "say" }, context(9_000)), /超时/);
  assert.deepEqual(state, before);
  assert.deepEqual(game.display(state, "spectator", context()).choices, []);
  const view = game.display(state, "a", context());
  assert.equal(view.choices?.length, 2);
  assert.ok(view.choices?.every(choice => !choice.disabled));
  assert.equal("mustPass" in view, false);
});

test("8秒到期才结束，重复alarm不再次改变结果", () => {
  const state = create();
  game.timeout!(state, context(8_999));
  assert.equal(state.status, "playing");
  game.timeout!(state, context(9_000));
  assert.equal(state.status, "finished");
  assert.equal(state.reason, "timeout");
  assert.equal(state.loserId, "a");
  assert.equal(state.deadline, undefined);
  const ended = structuredClone(state);
  game.timeout!(state, context(12_000));
  assert.deepEqual(state, ended);
});

test("真实连续正确完成100，全员通关，不出现101", () => {
  const state = create();
  for (let n = 1; n <= 100; n++) {
    assert.equal(state.number, n);
    game.act(state, state.playerIds[state.turn], { type: mustPass(n) ? "pass" : "say" }, context(2_000 + n));
  }
  assert.equal(state.status, "finished");
  assert.equal(state.reason, "complete");
  assert.equal(state.loserId, undefined);
  assert.equal(state.deadline, undefined);
  assert.equal(state.number, 100);
  assert.equal(Object.values(state.correct).reduce((a, b) => a + b, 0), 100);
  assert.match(game.display(state, "a", context()).result!, /全员通关/);
  assert.equal(state.history.length, 20);
});

test("只接受3～10个不同玩家", () => {
  assert.throws(() => game.create(players.slice(0, 2), context()), /3～10/);
  assert.throws(() => game.create([players[0], players[0], players[1]], context()), /不同玩家/);
  assert.throws(() => game.create(Array.from({ length: 11 }, (_, i) => ({ id: String(i), name: String(i) })), context()), /3～10/);
});
