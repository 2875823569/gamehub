import assert from "node:assert/strict";
import test from "node:test";
import { game, QUESTION_BANK, type NeverHaveState } from "../packages/games/never-have-i-ever/rules";
import type { GameContext } from "../packages/games/core";

const players = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "c", name: "丙" }];
const context = (now = 1_000): GameContext => ({ now, hostId: "a", roundNumber: 1, randomInt: n => Math.floor(n / 2) });
const create = () => game.create(players, context()) as NeverHaveState;

test("8道不重复原创题，人数限制正确", () => {
  assert.ok(QUESTION_BANK.length >= 30);
  const state = create();
  assert.equal(new Set(state.questions).size, 8);
  assert.throws(() => game.create(players.slice(0, 2), context()), /3～10/);
});

test("未收齐前只展示自己选择，观战者不获知任何答案", () => {
  const state = create();
  game.act(state, "a", { type: "answer", value: "yes" }, context());
  assert.equal(game.display(state, "a", context()).rows![0].value, "做过");
  assert.equal(game.display(state, "b", context()).rows![0].value, "已提交");
  const spectator = game.display(state, "spectator", context());
  assert.equal(spectator.rows![0].value, "已提交");
  assert.deepEqual(spectator.choices, []);
  assert.equal(state.experiences.a, 0);
  assert.throws(() => game.act(state, "spectator", { type: "answer", value: "yes" }, context()), /观战/);
});

test("拒绝重复、非法和逾期答案，收齐时仅结算一次", () => {
  const state = create();
  assert.throws(() => game.act(state, "a", { type: "answer", value: "__proto__" }, context()), /请选择/);
  game.act(state, "a", { type: "answer", value: "yes" }, context());
  assert.throws(() => game.act(state, "a", { type: "answer", value: "no" }, context()), /已经提交/);
  assert.throws(() => game.act(state, "b", { type: "answer", value: "yes" }, context(state.deadline!)), /时间已到/);
  game.act(state, "b", { type: "answer", value: "no" }, context());
  game.act(state, "c", { type: "answer", value: "skip" }, context());
  assert.equal(state.stage, "reveal");
  assert.deepEqual(state.experiences, { a: 1, b: 0, c: 0 });
  assert.equal(state.skipped.c, 1);
  assert.match(game.display(state, "b", context()).rows![0].value, /^做过/);
  assert.throws(() => game.act(state, "a", { type: "answer", value: "yes" }, context()), /已揭晓/);
  assert.equal(state.experiences.a, 1);
});

test("房主只能在揭晓阶段提前推进，其他玩家无权限", () => {
  const state = create();
  assert.throws(() => game.act(state, "a", { type: "next" }, context()), /等待全员/);
  game.timeout!(state, context(state.deadline!));
  assert.throws(() => game.act(state, "b", { type: "next" }, context()), /房主/);
  game.act(state, "a", { type: "next" }, context(50_000));
  assert.equal(state.stage, "answer");
  assert.equal(state.questionIndex, 1);
  assert.deepEqual(state.answers, {});
});

test("全员不操作也能自动完成八轮，结束时无残留deadline", () => {
  const state = create();
  let calls = 0;
  while (state.status === "playing") {
    game.timeout!(state, context(state.deadline!));
    calls++;
    assert.ok(calls <= 15);
  }
  assert.equal(calls, 15);
  assert.equal(state.questionIndex, 7);
  assert.equal(state.deadline, undefined);
  assert.deepEqual(state.skipped, { a: 8, b: 8, c: 8 });
  assert.deepEqual(state.experiences, { a: 0, b: 0, c: 0 });
  assert.match(game.display(state, "a", context()).result!, /8轮/);
  game.timeout!(state, context(1_000_000));
  assert.equal(state.skipped.a, 8);
  assert.throws(() => game.act(state, "a", { type: "next" }, context()), /已经结束/);
});
