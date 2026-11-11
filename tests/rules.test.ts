import { test } from "node:test";
import assert from "node:assert/strict";
import { challenge, createRound, handCount, isStraight, minimumBid, nextStarter, placeBid, respondSlash, slash, validBid, type Bid, type Round } from "../packages/games/liars-dice/rules.ts";

function round(): Round {
  return {
    number: 1, playerIds: ["a", "b"], names: { a: "甲", b: "乙" },
    dice: { a: [1, 2, 3, 4, 4], b: [1, 2, 2, 6, 6] },
    turnIndex: 0, bids: []
  };
}

test("1 点为万能点：达到叫数时开骰者输，整局立即结束", () => {
  const r = round();
  placeBid(r, "a", 5, 2);
  const result = challenge(r, "b");
  assert.equal(result.actualCount, 5);
  assert.equal(result.loserId, "b");
  assert.throws(() => placeBid(r, "a", 6, 3), /已经结束/);
  assert.throws(() => challenge(r, "b"), /已经结束/);
});

test("不足叫数时上一位叫点者输，没有后续减骰轮", () => {
  const r = round();
  placeBid(r, "a", 6, 2);
  assert.equal(challenge(r, "b").loserId, "a");
  assert.equal(r.dice.a.length, 5);
  assert.equal(r.dice.b.length, 5);
});

test("轮流叫点，数量或同数量点数必须增加", () => {
  const r = round();
  assert.throws(() => placeBid(r, "b", 1, 2), /还没轮到/);
  placeBid(r, "a", 3, 4);
  assert.throws(() => placeBid(r, "b", 3, 3), /加码/);
  placeBid(r, "b", 3, 5);
  placeBid(r, "a", 4, 2);
  assert.equal(r.turnIndex, 1);
  assert.equal(r.bids.length, 3);
});

test("首叫至少人数，拒绝非法点数和数量，最多人数乘 7", () => {
  for (const [count, face] of [[1, 1], [0, 2], [-1, 2], [15, 2], [1.5, 3], [2, 7], [NaN, 2], [2, 2.3]]) {
    assert.equal(validBid(count, face, undefined, 2), false);
  }
  assert.equal(validBid(2, 1, undefined, 2), true);
  assert.equal(validBid(14, 6, undefined, 2), true);
  assert.throws(() => challenge(round(), "a"), /还没有人/);
});

test("上一局输家下一局先喊；输家离开按原座次顺延", () => {
  const previous = round();
  previous.outcome = { loserId: "b", reason: "challenge" };
  assert.equal(createRound([{ id: "a", name: "甲" }, { id: "b", name: "乙" }], 2, () => 0, previous).turnIndex, 1);
  previous.playerIds = ["a", "b", "c", "d"];
  assert.equal(nextStarter([{ id: "a" }, { id: "d" }, { id: "new" }], previous), "d");
  assert.equal(nextStarter([{ id: "a" }, { id: "new" }], previous), "a");
  assert.equal(nextStarter([{ id: "new" }], previous), "new");
});

test("六种五颗互异手牌都为顺子，顺序不影响，1 也不计数", () => {
  for (let omitted = 1; omitted <= 6; omitted++) {
    const hand = [6, 5, 4, 3, 2, 1].filter(v => v !== omitted);
    assert.equal(isStraight(hand), true);
    for (let face = 1; face <= 6; face++) {
      assert.equal(handCount(hand, { playerId: "a", count: 2, face, mode: "normal" }), 0);
      assert.equal(handCount(hand, { playerId: "a", count: 2, face, mode: "zhai" }), 0);
    }
  }
  assert.equal(isStraight([1, 2, 3, 4, 4]), false);
});

test("顺子影响实际输赢，而非仅显示牌型", () => {
  const r = round();
  r.dice = { a: [1, 3, 4, 5, 6], b: [2, 2, 3, 3, 4] };
  placeBid(r, "a", 2, 6);
  assert.equal(challenge(r, "b").actualCount, 0);
  assert.equal(r.outcome?.loserId, "a");
});

test("围骰、全围和全 1 在普通/斋下的有效贡献", () => {
  const bid: Bid = { playerId: "a", count: 2, face: 2, mode: "normal" };
  assert.equal(handCount([2, 2, 2, 2, 1], bid), 6);
  assert.equal(handCount([2, 2, 2, 1, 1], bid), 6);
  assert.equal(handCount([2, 2, 2, 2, 2], bid), 7);
  assert.equal(handCount([1, 1, 1, 1, 1], bid), 7);
  assert.equal(handCount([3, 3, 3, 3, 3], bid), 0);
  const zhai: Bid = { ...bid, mode: "zhai" };
  assert.equal(handCount([2, 2, 2, 2, 1], zhai), 4);
  assert.equal(handCount([2, 2, 2, 2, 2], zhai), 7);
  assert.equal(handCount([1, 1, 1, 1, 1], zhai), 0);
  assert.equal(handCount([1, 1, 1, 1, 1], { ...zhai, face: 1 }), 7);
});

test("4 个 6 斋可以接 4 个 1；叫 1 自动斋且 1 最大", () => {
  const r = round();
  placeBid(r, "a", 4, 6, "zhai");
  placeBid(r, "b", 4, 1);
  assert.equal(r.bids[1].mode, "zhai");
  assert.throws(() => placeBid(r, "a", 4, 6, "zhai"), /加码/);
  placeBid(r, "a", 5, 2, "zhai");
});

test("转斋半数向上取整；飞必须翻倍，不能叫 1 或偷切普通模式", () => {
  const r = round();
  placeBid(r, "a", 5, 6);
  assert.throws(() => placeBid(r, "b", 2, 2, "zhai"), /加码/);
  placeBid(r, "b", 3, 2, "zhai");
  assert.throws(() => placeBid(r, "a", 5, 6, "fly"), /加码/);
  assert.throws(() => placeBid(r, "a", 6, 1, "fly"), /加码/);
  assert.throws(() => placeBid(r, "a", 6, 2, "normal"), /加码/);
  placeBid(r, "a", 6, 2, "fly");
  placeBid(r, "b", 6, 3);
  assert.equal(r.bids.at(-1)?.mode, "normal");
  assert.equal(validBid(4, 3, undefined, 2, "fly"), false);
  assert.equal(validBid(4, 3, undefined, 2, "invalid" as never), false);
  assert.equal(minimumBid(1, { playerId: "a", count: 14, face: 1, mode: "zhai" }, 2, "zhai"), undefined);
});

test("劈可跨回合但不能自劈/旁观劈；等待中冻结操作且不提前结算", () => {
  const r = round();
  r.playerIds.push("c");
  r.dice.c = [3, 3, 4, 4, 5];
  placeBid(r, "a", 3, 2);
  assert.throws(() => slash(r, "a"), /自己/);
  assert.throws(() => slash(r, "outsider"), /旁观/);
  slash(r, "c");
  assert.equal(r.outcome, undefined);
  assert.deepEqual(r.pendingSlash, { challengerId: "c", bidderId: "a" });
  assert.throws(() => placeBid(r, "b", 4, 2), /等待/);
  assert.throws(() => challenge(r, "b"), /等待/);
  assert.throws(() => slash(r, "b"), /等待/);
  assert.throws(() => respondSlash(r, "c", true), /只有/);
  assert.throws(() => respondSlash(r, "a", "true" as never), /格式/);
  const result = respondSlash(r, "a", true);
  assert.equal(result.multiplier, 4);
  assert.equal(result.loserId, "c");
  assert.equal(r.pendingSlash, undefined);
  assert.throws(() => respondSlash(r, "a", true), /结束/);
});

test("接受劈按 2 倍；普通开按 1 倍；叫点不足时仍是叫点者输", () => {
  const r = round();
  placeBid(r, "a", 14, 6);
  slash(r, "b");
  assert.equal(respondSlash(r, "a", false).multiplier, 2);
  assert.equal(r.outcome?.loserId, "a");
  const regular = round();
  placeBid(regular, "a", 14, 6);
  assert.equal(challenge(regular, "b").multiplier, 1);
  assert.throws(() => slash(round(), "a"), /还没有/);
});

test("每局重置骰子、叫点记录和起始玩家", () => {
  const r = createRound([{ id: "a", name: "甲" }, { id: "b", name: "乙" }], 2, max => max - 1);
  assert.equal(r.number, 2);
  assert.equal(r.turnIndex, 1);
  assert.deepEqual(r.dice, { a: [6, 6, 6, 6, 6], b: [6, 6, 6, 6, 6] });
  assert.deepEqual(r.bids, []);
  assert.equal(r.outcome, undefined);
  assert.throws(() => createRound([{ id: "a", name: "甲" }], 1, () => 0), /2～6/);
});
