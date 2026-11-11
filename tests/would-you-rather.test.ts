import test from "node:test";
import assert from "node:assert/strict";
import { game, QUESTION_BANK, type WouldRatherState } from "../packages/games/would-you-rather/rules";
import type { GameContext } from "../packages/games/core";

const players = ["a", "b", "c", "d"].map((id, i) => ({ id, name: `玩家${i + 1}` }));
const context = (now = 1000): GameContext => ({ now, randomInt: max => max - 1, hostId: "a", roundNumber: 1 });
const create = (count = 3) => game.create(players.slice(0, count), context()) as WouldRatherState;
function vote(state: WouldRatherState, player: string, value: unknown) {
  game.act(state, player, { type: "vote", value }, context());
}

test("题库足够、每局8道不同题；人数边界严格", () => {
  assert.ok(QUESTION_BANK.length >= 30);
  const state = create();
  assert.equal(state.questions.length, 8);
  assert.equal(new Set(state.questions.map(question => question.a + question.b)).size, 8);
  assert.throws(() => game.create(players.slice(0, 2), context()), /3～10/);
  assert.throws(() => game.create(Array.from({ length: 11 }, (_, i) => ({ id: String(i), name: String(i) })), context()), /3～10/);
});

test("揭晓前其他人的展示与完全未投时相同，观战者也看不到答案及票数", () => {
  const state = create();
  const beforeGuest = game.display(state, "b", context());
  const beforeSpectator = game.display(state, "spectator", context());
  vote(state, "a", "A");
  assert.deepEqual(game.display(state, "b", context()), beforeGuest);
  assert.deepEqual(game.display(state, "spectator", context()), beforeSpectator);
  assert.match(game.display(state, "a", context()).rows![0].value, /A 阵营/);
  assert.equal(game.display(state, "spectator", context()).choices!.length, 0);
  assert.equal(state.scores.a, 0);
});

test("多数派加分，少数派不得分；收齐才揭晓", () => {
  const state = create();
  vote(state, "a", "A");
  vote(state, "b", "B");
  assert.equal(state.stage, "vote");
  vote(state, "c", "A");
  assert.equal(state.stage, "reveal");
  assert.deepEqual(state.scores, { a: 1, b: 0, c: 1 });
  assert.match(game.display(state, "b", context()).notice!, /A 2 人 · B 1 人/);
});

test("平票、全票同选、部分及全员跳过的计分", () => {
  const tie = create(4);
  ["A", "A", "B", "B"].forEach((choice, i) => vote(tie, players[i].id, choice));
  assert.deepEqual(tie.scores, { a: 0, b: 0, c: 0, d: 0 });
  const unanimous = create();
  ["A", "A", "skip"].forEach((choice, i) => vote(unanimous, players[i].id, choice));
  assert.deepEqual(unanimous.scores, { a: 1, b: 1, c: 0 });
  const skipped = create();
  players.slice(0, 3).forEach(player => vote(skipped, player.id, "skip"));
  assert.deepEqual(skipped.scores, { a: 0, b: 0, c: 0 });
});

test("拒绝越权、重复、非法、迟到输入，提前翻题受角色和阶段约束", () => {
  const state = create();
  assert.throws(() => vote(state, "spectator", "A"), /观战/);
  assert.throws(() => vote(state, "a", { A: true }), /请选择/);
  assert.throws(() => game.act(state, "a", { type: "next" }, context()), /揭晓/);
  vote(state, "a", "A");
  assert.throws(() => vote(state, "a", "B"), /已经/);
  assert.throws(() => game.act(state, "b", { type: "vote", value: "B" }, context(state.deadline)), /时间已到/);
  vote(state, "b", "B");
  vote(state, "c", "A");
  assert.throws(() => game.act(state, "b", { type: "next" }, context()), /房主/);
  game.act(state, "a", { type: "next" }, context());
  assert.equal(state.questionIndex, 1);
  assert.equal(state.stage, "vote");
  assert.deepEqual(state.votes, {});
});

test("8轮全部由期限推进可结束，超时当跳过，终局无倒计时和操作", () => {
  const state = create();
  for (let i = 0; i < 8; i++) {
    assert.equal(state.questionIndex, i);
    const deadline = state.deadline!;
    game.timeout!(state, context(deadline - 1));
    assert.equal(state.stage, "vote");
    game.timeout!(state, context(deadline));
    assert.equal(state.stage, "reveal");
    assert.deepEqual(state.votes, { a: "skip", b: "skip", c: "skip" });
    if (i < 7) game.timeout!(state, context(state.deadline));
  }
  assert.equal(state.status, "finished");
  assert.equal(state.deadline, undefined);
  assert.deepEqual(game.display(state, "a", context()).choices, []);
  assert.match(game.display(state, "a", context()).result!, /暂无积分赢家/);
  const snapshot = structuredClone(state);
  game.timeout!(state, context(99999999));
  assert.deepEqual(state, snapshot);
  assert.throws(() => vote(state, "a", "A"), /结束/);
});

test("8轮正常选择后显示并列胜者，累计积分只结算一次", () => {
  const state = create();
  for (let round = 0; round < 8; round++) {
    vote(state, "a", "A");
    vote(state, "b", "A");
    vote(state, "c", "B");
    if (round < 7) game.act(state, "a", { type: "next" }, context());
  }
  assert.deepEqual(state.scores, { a: 8, b: 8, c: 0 });
  assert.match(game.display(state, "a", context()).result!, /玩家1、玩家2以 8 分并列获胜/);
  game.timeout!(state, context(99999999));
  assert.deepEqual(state.scores, { a: 8, b: 8, c: 0 });
});
