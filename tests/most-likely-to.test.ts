import assert from "node:assert/strict";
import test from "node:test";
import { game, QUESTION_BANK, type MostLikelyState } from "../packages/games/most-likely-to/rules";
import type { GameContext } from "../packages/games/core";

const players = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "c", name: "丙" }];
const context = (now = 1000): GameContext => ({ now, hostId: "a", roundNumber: 1, randomInt: n => Math.floor(n / 2) });
const create = () => game.create(players, context()) as MostLikelyState;

test("题库足够且一局8题不重复，拒绝不支持人数", () => {
  assert.ok(QUESTION_BANK.length >= 30);
  assert.equal(new Set(create().questions).size, 8);
  assert.throws(() => game.create(players.slice(0, 2), context()), /3～10/);
});

test("秘密投票仅本人可见，观战者及其他人只见提交总数", () => {
  const state = create();
  game.act(state, "a", { type: "vote", value: "b" }, context());
  assert.match(game.display(state, "a", context()).notice!, /你已选择「乙」/);
  const before = game.display(state, "c", context());
  const spectator = game.display(state, "spectator", context());
  assert.deepEqual(before.rows, [{ label: "提交进度", value: "1 / 3" }]);
  assert.deepEqual(spectator.rows, before.rows);
  assert.deepEqual(spectator.choices, []);
  assert.equal(JSON.stringify(before).includes('"votes"'), false);
  assert.deepEqual(state.totalVotes, { a: 0, b: 0, c: 0 });
  assert.throws(() => game.act(state, "spectator", { type: "vote", value: "a" }, context()), /观战/);
});

test("拒绝非法目标、重复选择和超时投票，允许自投", () => {
  const state = create();
  for (const value of ["outsider", "__proto__", null, 1]) {
    assert.throws(() => game.act(state, "a", { type: "vote", value }, context()), /请选择/);
  }
  game.act(state, "a", { type: "vote", value: "a" }, context());
  assert.equal(state.votes.a, "a");
  assert.throws(() => game.act(state, "a", { type: "skip" }, context()), /已经提交/);
  assert.throws(() => game.act(state, "b", { type: "vote", value: "a" }, context(state.deadline!)), /时间已到/);
  assert.deepEqual(state.votes, { a: "a" });
});

test("并列最高票一起成为聚光灯，揭晓不公开投票关系", () => {
  const state = create();
  game.act(state, "a", { type: "vote", value: "b" }, context());
  game.act(state, "b", { type: "vote", value: "a" }, context());
  game.act(state, "c", { type: "skip" }, context());
  assert.equal(state.stage, "reveal");
  assert.deepEqual(state.counts, { a: 1, b: 1, c: 0 });
  assert.deepEqual(state.leaders, ["a", "b"]);
  assert.deepEqual(state.spotlights, { a: 1, b: 1, c: 0 });
  const display = game.display(state, "c", context());
  assert.deepEqual(display.rows?.map(row => row.value), ["1 票", "1 票", "0 票"]);
  assert.match(display.notice!, /甲、乙/);
  assert.equal(JSON.stringify(display).includes('"votes"'), false);
  assert.throws(() => game.act(state, "a", { type: "vote", value: "c" }, context()), /已揭晓/);
  assert.equal(state.totalVotes.a, 1);
});

test("只有房主能在揭晓阶段推进，下一题清空秘密投票", () => {
  const state = create();
  assert.throws(() => game.act(state, "a", { type: "next" }, context()), /等待全员/);
  game.timeout!(state, context(state.deadline!));
  assert.deepEqual(state.leaders, []);
  assert.match(game.display(state, "a", context()).notice!, /都选择跳过/);
  assert.throws(() => game.act(state, "b", { type: "next" }, context()), /房主/);
  game.act(state, "a", { type: "next" }, context(50_000));
  assert.equal(state.questionIndex, 1);
  assert.equal(state.stage, "vote");
  assert.deepEqual(state.votes, {});
  assert.deepEqual(state.counts, {});
});

test("完整8题按真实投票结束，累计只结算一次", () => {
  const state = create();
  for (let round = 0; round < 8; round++) {
    const now = state.deadline! - 1000;
    for (const p of players) game.act(state, p.id, { type: "vote", value: "a" }, context(now));
    if (round < 7) game.act(state, "a", { type: "next" }, context(now + 1));
  }
  assert.equal(state.status, "finished");
  assert.equal(state.deadline, undefined);
  assert.deepEqual(state.totalVotes, { a: 24, b: 0, c: 0 });
  assert.equal(state.spotlights.a, 8);
  assert.match(game.display(state, "a", context()).rows![0].value, /累计 24 票/);
  game.timeout!(state, context(999_999));
  assert.equal(state.totalVotes.a, 24);
  assert.throws(() => game.act(state, "a", { type: "next" }, context()), /已经结束/);
});

test("完全无操作时15次alarm完成8题，不残留截止时间", () => {
  const state = create();
  let calls = 0;
  while (state.status === "playing") {
    game.timeout!(state, context(state.deadline!));
    assert.ok(++calls <= 15);
  }
  assert.equal(calls, 15);
  assert.equal(state.deadline, undefined);
  assert.deepEqual(state.totalVotes, { a: 0, b: 0, c: 0 });
  assert.deepEqual(state.spotlights, { a: 0, b: 0, c: 0 });
});
