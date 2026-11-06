import { test } from "node:test";
import assert from "node:assert/strict";
import { challenge, createRound, placeBid, validBid, type Round } from "../packages/games/liars-dice/rules.ts";

function round(): Round {
  return {
    number: 1, playerIds: ["a", "b"], names: { a: "甲", b: "乙" },
    dice: { a: [1, 2, 3, 4, 5], b: [1, 2, 2, 6, 6] },
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

test("禁止叫 1、非整数、超过总骰数，第一手不能直接开", () => {
  for (const [count, face] of [[1, 1], [0, 2], [-1, 2], [11, 2], [1.5, 3], [1, 7], [NaN, 2], [1, 2.3]]) {
    assert.equal(validBid(count, face, undefined, 10), false);
  }
  assert.throws(() => challenge(round(), "a"), /还没有人/);
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
