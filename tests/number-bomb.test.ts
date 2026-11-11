import assert from "node:assert/strict";
import test from "node:test";
import { game, type NumberBombState } from "../packages/games/number-bomb/rules";
import type { GameContext } from "../packages/games/core";

const players = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "c", name: "丙" }];
const context = (secret = 42, now = 1000, roundNumber = 1): GameContext => ({
  now, hostId: "a", roundNumber, randomInt: () => secret - 1
});
const create = (secret = 42) => game.create(players, context(secret)) as NumberBombState;

test("闭区间两端1和100均能成为炸弹并正常结束", () => {
  for (const secret of [1, 100]) {
    const state = create(secret);
    game.act(state, "a", { type: "guess", value: secret }, context(secret));
    assert.equal(state.status, "finished");
    assert.equal(state.loserId, "a");
    assert.equal(state.reason, "bomb");
    assert.equal(state.deadline, undefined);
    assert.match(game.display(state, "b", context(secret)).result!, new RegExp(`炸弹是 ${secret}`));
  }
});

test("未命中排除已猜值，范围缩到一格后依然可合法命中", () => {
  const state = create();
  game.act(state, "a", { type: "guess", value: 41 }, context());
  assert.deepEqual([state.lower, state.upper, state.turn], [42, 100, 1]);
  game.act(state, "b", { type: "guess", value: 43 }, context(42, 2000));
  assert.deepEqual([state.lower, state.upper, state.turn], [42, 42, 2]);
  assert.equal(game.display(state, "c", context()).input?.min, 42);
  assert.equal(game.display(state, "c", context()).input?.max, 42);
  game.act(state, "c", { type: "guess", value: 42 }, context(42, 3000));
  assert.equal(state.loserId, "c");
  assert.equal(state.guesses.length, 3);
  assert.throws(() => game.act(state, "c", { type: "guess", value: 42 }, context()), /已经结束/);
});

test("猜中前隐藏秘密，只有当前玩家得到输入框", () => {
  const state = create(87);
  for (const viewer of ["a", "b", "spectator"]) {
    const display = game.display(state, viewer, context(87));
    assert.equal("secret" in display, false);
    assert.equal(JSON.stringify(display).includes("87"), false);
    assert.equal(Boolean(display.input), viewer === "a");
    assert.equal(display.result, undefined);
  }
});

test("拒绝错误回合、观战、无效动作与不合法数值，状态不变", () => {
  const state = create();
  const before = structuredClone(state);
  assert.throws(() => game.act(state, "b", { type: "guess", value: 50 }, context()), /轮到/);
  assert.throws(() => game.act(state, "spectator", { type: "guess", value: 50 }, context()), /观战/);
  assert.throws(() => game.act(state, "a", { type: "answer", value: 50 }, context()), /选择/);
  for (const value of [NaN, Infinity, -Infinity, 0, 101, 41.5, "42", null, undefined, {}]) {
    assert.throws(() => game.act(state, "a", { type: "guess", value }, context()), /整数/);
  }
  assert.deepEqual(state, before);
  game.act(state, "a", { type: "guess", value: 50 }, context());
  assert.throws(() => game.act(state, "b", { type: "guess", value: 50 }, context()), /整数/);
});

test("30秒截止严格执行，超时不代猜，重复alarm无副作用", () => {
  const state = create();
  const deadline = state.deadline!;
  game.timeout!(state, context(42, deadline - 1));
  assert.equal(state.status, "playing");
  assert.throws(() => game.act(state, "a", { type: "guess", value: 50 }, context(42, deadline)), /时间已到/);
  game.timeout!(state, context(42, deadline));
  assert.equal(state.status, "finished");
  assert.equal(state.reason, "timeout");
  assert.equal(state.loserId, "a");
  assert.equal(state.guesses.length, 0);
  assert.equal(state.deadline, undefined);
  const ended = structuredClone(state);
  game.timeout!(state, context(42, deadline + 1000));
  assert.deepEqual(state, ended);
  assert.match(game.display(state, "a", context()).prompt, /超时失败/);
});

test("开局人数和身份约束，首位随局数轮换", () => {
  assert.throws(() => game.create(players.slice(0, 1), context()), /2～10/);
  assert.throws(() => game.create(Array.from({ length: 11 }, (_, i) => ({ id: String(i), name: "甲" })), context()), /2～10/);
  assert.throws(() => game.create([players[0], players[0]], context()), /2～10/);
  for (let round = 1; round <= 7; round++) {
    const state = game.create(players, context(42, 1000, round)) as NumberBombState;
    assert.equal(state.turn, (round - 1) % players.length);
  }
});
