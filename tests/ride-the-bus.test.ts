import test from "node:test";
import assert from "node:assert/strict";
import { game, guessMatches, type RideBusState, type Card } from "../packages/games/ride-the-bus/rules";
import type { GameContext, GamePlayer } from "../packages/games/core";

const players: GamePlayer[] = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }];
const context = (now = 1_000): GameContext => ({ now, hostId: "a", randomInt: n => n - 1, roundNumber: 1 });
const create = (size = 2) => game.create(size === 2 ? players : Array.from({ length: size }, (_, i) => ({ id: `p${i}`, name: `玩家${i}` })), context()) as RideBusState;
const card = (rank: number, suit: Card["suit"] = "hearts"): Card => ({ rank, suit });
const current = (s: RideBusState) => s.stage === "bus" ? s.busRider! : s.playerIds[s.turnIndex];
function guess(s: RideBusState, answer: string) { game.act(s, current(s), { type: "guess", value: answer }, context()); }
function finishDeal(s: RideBusState) {
  while (s.stage === "deal") guess(s, ["red", "higher", "inside", "hearts"][s.dealStep]);
}
function finishPyramid(s: RideBusState) {
  while (s.stage === "pyramid") {
    for (const id of s.playerIds) game.act(s, id, { type: "match", value: "keep" }, context());
  }
}

test("高低和开区间严格处理边界，A最大", () => {
  assert.equal(guessMatches(1, "higher", card(14), [card(13)]), true);
  assert.equal(guessMatches(1, "higher", card(9), [card(9)]), false);
  assert.equal(guessMatches(1, "lower", card(9), [card(9)]), false);
  assert.equal(guessMatches(2, "inside", card(6), [card(5), card(10)]), true);
  for (const rank of [5, 10]) {
    assert.equal(guessMatches(2, "inside", card(rank), [card(5), card(10)]), false);
    assert.equal(guessMatches(2, "outside", card(rank), [card(5), card(10)]), false);
  }
  assert.equal(guessMatches(2, "outside", card(6), [card(5), card(5)]), true);
  assert.equal(guessMatches(2, "outside", card(5), [card(5), card(5)]), false);
});

test("八人全部获得四张无重复手牌，再切换独立金字塔牌堆", () => {
  const s = create(8);
  finishDeal(s);
  assert.equal(s.stage, "pyramid");
  assert.ok(Object.values(s.hands).every(hand => hand.length === 4));
  const dealt = Object.values(s.hands).flat().map(c => `${c.rank}:${c.suit}`);
  assert.equal(new Set(dealt).size, 32);
  assert.equal(s.pyramid.length, 15);
  assert.equal(new Set(s.pyramid.map(c => `${c.rank}:${c.suit}`)).size, 15);
});

test("投影视图不泄露牌堆、他人手牌或未翻金字塔", () => {
  const s = create();
  s.hands.a = [card(7, "diamonds")];
  s.hands.b = [card(11, "clubs")];
  const own = JSON.stringify(game.display(s, "a", context()));
  const stranger = JSON.stringify(game.display(s, "spectator", context()));
  assert.ok(own.includes("方块 7"));
  assert.ok(!own.includes("梅花 J"));
  assert.ok(!stranger.includes("方块 7"));
  assert.deepEqual(game.display(s, "spectator", context()).choices, []);
  finishDeal(create());
  const p = create();
  finishDeal(p);
  const view = game.display(p, "spectator", context());
  assert.equal(view.cards?.filter(label => label.startsWith("金字塔")).length, 1);
  assert.ok(!JSON.stringify(view).includes('"deck"'));
  assert.ok(!JSON.stringify(view).includes('"hands"'));
});

test("越权和无效输入不改变游戏；有效猜测由服务器结算", () => {
  const s = create();
  const before = structuredClone(s);
  assert.throws(() => game.act(s, "b", { type: "guess", value: "red" }, context()), /轮到/);
  assert.throws(() => game.act(s, "a", { type: "guess", value: "higher" }, context()), /有效答案/);
  assert.throws(() => game.act(s, "spectator", { type: "guess", value: "red" }, context()), /观战/);
  assert.deepEqual(s, before);
  s.deck[s.deck.length - 1] = card(4, "hearts");
  guess(s, "red");
  assert.equal(s.scores.a, 1);
  assert.equal(s.hands.a.length, 1);
  assert.equal(s.turnIndex, 1);
});

test("金字塔匹配全部同点数牌并按层计分，禁止重复或无牌配对", () => {
  const s = create();
  finishDeal(s);
  s.pyramidIndex = 12; // 第四层
  s.pyramid[12] = card(8);
  s.hands.a = [card(8), card(8, "spades"), card(4)];
  s.hands.b = [card(4)];
  const beforeScore = s.scores.a;
  game.act(s, "a", { type: "match", value: "discard" }, context());
  assert.equal(s.scores.a, beforeScore + 8);
  assert.deepEqual(s.hands.a, [card(4)]);
  assert.throws(() => game.act(s, "a", { type: "match", value: "keep" }, context()), /已经处理/);
  assert.throws(() => game.act(s, "b", { type: "match", value: "discard" }, context()), /没有相同/);
  game.act(s, "b", { type: "match", value: "keep" }, context());
  assert.equal(s.pyramidIndex, 13);
  assert.deepEqual(s.responses, {});
});

test("剩牌并列用最高点数及座位决定巴士挑战者，四次必定结束", () => {
  const s = create();
  finishDeal(s);
  s.hands.a = [card(4), card(10)];
  s.hands.b = [card(3), card(14)];
  finishPyramid(s);
  assert.equal(s.busRider, "b");
  assert.equal(s.stage, "bus");
  assert.throws(() => game.act(s, "a", { type: "guess", value: "red" }, context()), /轮到/);
  for (const answer of ["red", "higher", "inside", "hearts"]) guess(s, answer);
  assert.equal(s.busCards.length, 4);
  assert.equal(s.status, "finished");
  assert.equal(s.deadline, undefined);
  assert.equal(s.deck.length, 0);
  assert.match(game.display(s, "a", context()).result!, /巴士挑战答对/);
  assert.throws(() => guess(s, "red"), /已经结束/);
  const tied = create();
  finishDeal(tied);
  tied.hands.a = [];
  tied.hands.b = [];
  finishPyramid(tied);
  assert.equal(tied.busRider, "a");
});

test("全部玩家无操作时，服务器超时可从发牌完整推进至终局", () => {
  const s = create(8);
  let alarmCount = 0;
  while (s.status === "playing" && alarmCount < 100) {
    const deadline = s.deadline!;
    game.timeout!(s, context(deadline - 1));
    assert.equal(s.deadline, deadline);
    game.timeout!(s, context(deadline));
    assert.ok(s.status === "finished" || s.deadline! > deadline);
    alarmCount++;
  }
  assert.equal(s.status, "finished");
  assert.equal(alarmCount, 32 + 15 + 4);
  assert.equal(s.busCorrect, 0);
  assert.equal(s.deadline, undefined);
});

test("过期动作不能抢在闹钟处理前改变状态，人数范围严格", () => {
  const s = create();
  const before = structuredClone(s);
  assert.throws(() => game.act(s, "a", { type: "guess", value: "red" }, context(s.deadline!)), /超时/);
  assert.deepEqual(s, before);
  assert.throws(() => create(1), /2～8/);
  assert.throws(() => create(9), /2～8/);
});
