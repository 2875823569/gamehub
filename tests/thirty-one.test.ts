import test from "node:test";
import assert from "node:assert/strict";
import { game, type ThirtyOneState } from "../packages/games/thirty-one/rules";
import type { GameContext } from "../packages/games/core";

const players = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "c", name: "丙" }];
const context = (now = 1000, roundNumber = 1): GameContext => ({ now, roundNumber, hostId: "a", randomInt: () => 0 });
const create = (roundNumber = 1) => game.create(players, context(1000, roundNumber)) as ThirtyOneState;
const current = (state: ThirtyOneState) => state.playerIds[state.turn];

test("28/29/30边界：合法选项逐步减少，恰好31结算", () => {
  for (const lastNumber of [28, 29, 30]) {
    const s = create();
    s.lastNumber = lastNumber;
    const choices = game.display(s, "a", context()).choices!;
    assert.deepEqual(choices.filter(c => !c.disabled).map(c => c.value), Array.from({ length: 31 - lastNumber }, (_, i) => i + 1));
    game.act(s, "a", { type: "count", value: 31 - lastNumber }, context());
    assert.equal(s.lastNumber, 31);
    assert.equal(s.status, "finished");
    assert.equal(s.loserId, "a");
    assert.equal(s.deadline, undefined);
    assert.deepEqual(s.counts[0].numbers, Array.from({ length: 31 - lastNumber }, (_, i) => lastNumber + i + 1));
  }
});

test("非法数量、越界和错误动作拒绝且不修改状态", () => {
  const s = create();
  s.lastNumber = 30;
  for (const value of [0, -1, 2, 3, 4, 1.5, NaN, Infinity, -Infinity, "1", null, undefined]) {
    const before = structuredClone(s);
    assert.throws(() => game.act(s, "a", { type: "count", value }, context()));
    assert.deepEqual(s, before);
  }
  assert.throws(() => game.act(s, "a", { type: "unknown", value: 1 }, context()));
  assert.equal(s.lastNumber, 30);
});

test("只能当前参赛者操作，旁观和其他玩家无选项", () => {
  const s = create();
  const before = structuredClone(s);
  assert.throws(() => game.act(s, "b", { type: "count", value: 1 }, context()), /轮到/);
  assert.throws(() => game.act(s, "watcher", { type: "count", value: 1 }, context()), /观战/);
  assert.deepEqual(s, before);
  assert.deepEqual(game.display(s, "watcher", context()).choices, []);
  assert.deepEqual(game.display(s, "b", context()).choices, []);
});

test("完整31次连续报数，每步同步序列并正确结束", () => {
  const s = create();
  for (let i = 1; i <= 31; i++) {
    const actor = current(s);
    game.act(s, actor, { type: "count", value: 1 }, context(1000 + i));
    assert.equal(s.lastNumber, i);
    assert.deepEqual(s.counts.at(-1)?.numbers, [i]);
    if (i < 31) {
      assert.equal(s.status, "playing");
      assert.equal(s.deadline, 31000 + i);
    }
  }
  assert.equal(s.status, "finished");
  assert.equal(s.loserId, "a");
  assert.equal(s.counts.length, 31);
  const view = game.display(s, "a", context());
  assert.match(view.result!, /甲报到31/);
  assert.equal(view.history?.length, 31);
  assert.deepEqual(view.choices, []);
  assert.throws(() => game.act(s, "a", { type: "count", value: 1 }, context()), /结束/);
});

test("服务器期限：提前timeout不生效，期限到达后判当前人失败并清理", () => {
  const s = create();
  game.act(s, "a", { type: "count", value: 3 }, context(2000));
  assert.equal(current(s), "b");
  game.timeout!(s, context(31999));
  assert.equal(s.status, "playing");
  assert.throws(() => game.act(s, "b", { type: "count", value: 1 }, context(32000)), /时间已到/);
  assert.equal(s.lastNumber, 3);
  game.timeout!(s, context(32000));
  assert.equal(s.reason, "timeout");
  assert.equal(s.loserId, "b");
  assert.equal(s.status, "finished");
  assert.equal(s.deadline, undefined);
  assert.match(game.display(s, "a", context()).result!, /乙超时/);
  const finished = structuredClone(s);
  game.timeout!(s, context(100000));
  assert.deepEqual(s, finished);
});

test("重开清空状态、按局数轮换先手，并校验人数", () => {
  for (const [round, actor] of [[1, "a"], [2, "b"], [3, "c"], [4, "a"]] as const) {
    const s = create(round);
    assert.equal(current(s), actor);
    assert.equal(s.lastNumber, 0);
    assert.deepEqual(s.counts, []);
    assert.equal(s.loserId, undefined);
  }
  assert.throws(() => game.create(players.slice(0, 1), context()));
  assert.throws(() => game.create([players[0], players[0]], context()));
  assert.throws(() => game.create(Array.from({ length: 11 }, (_, i) => ({ id: String(i), name: "玩家" })), context()));
});
