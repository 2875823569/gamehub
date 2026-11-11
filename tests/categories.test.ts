import assert from "node:assert/strict";
import test from "node:test";
import { game, wordKey, type CategoriesState } from "../packages/games/categories/rules";
import type { GameContext } from "../packages/games/core";

const players = [{ id: "a", name: "小甲" }, { id: "b", name: "小乙" }, { id: "c", name: "小丙" }];
const context = (now = 1000): GameContext => ({ now, hostId: "a", randomInt: () => 0, roundNumber: 1 });
function create(): CategoriesState { return game.create(players, context()) as CategoriesState; }
function choose(s: CategoriesState) { game.act(s, "a", { type: "category", value: "水果" }, context()); }

test("分类选择、审核仅房主；观战无按钮且不能操作", () => {
  const s = create();
  const before = structuredClone(s);
  assert.throws(() => game.act(s, "b", { type: "category", value: "水果" }, context()), /房主/);
  assert.throws(() => game.act(s, "a", { type: "category", value: "自定义" }, context()), /列表/);
  assert.deepEqual(s, before);
  assert.deepEqual(game.display(s, "spectator", context()).choices, []);
  assert.throws(() => game.act(s, "spectator", { type: "category", value: "水果" }, context()), /观战/);
  choose(s);
  assert.throws(() => game.act(s, "b", { type: "word", value: "苹果" }, context()), /轮到/);
  game.act(s, "a", { type: "word", value: "苹果" }, context());
  assert.equal(s.stage, "review");
  assert.throws(() => game.act(s, "b", { type: "judge", value: "accept" }, context()), /房主/);
  assert.throws(() => game.act(s, "a", { type: "word", value: "香蕉" }, context()), /阶段/);
  game.act(s, "a", { type: "judge", value: "accept" }, context());
  assert.equal(s.scores.a, 1);
  assert.equal(s.turn, 1);
});

test("NFKC、空格和大小写归一化重复立即判负，不给重复词加分", () => {
  assert.equal(wordKey(" ＡpＰle "), "apple");
  assert.equal(wordKey("a p p l e"), "apple");
  const s = create();
  choose(s);
  game.act(s, "a", { type: "word", value: "ＡpＰle" }, context());
  game.act(s, "a", { type: "judge", value: "accept" }, context());
  game.act(s, "b", { type: "word", value: "a p p l e" }, context());
  assert.equal(s.status, "finished");
  assert.equal(s.loserId, "b");
  assert.equal(s.entries.length, 1);
  assert.equal(s.scores.b, 0);
  assert.equal(s.deadline, undefined);
});

test("拒绝空白、非字符串、控制字符和过长输入且不推进回合", () => {
  const s = create();
  choose(s);
  const before = structuredClone(s);
  for (const value of ["  ", "\u200b", "苹果\n", "果".repeat(21), 123, null]) {
    assert.throws(() => game.act(s, "a", { type: "word", value }, context()));
    assert.deepEqual(s, before);
  }
  assert.throws(() => game.act(s, "a", { type: "unknown" }, context()), /不支持/);
  assert.deepEqual(s, before);
});

test("房主可判自己答案不符类别，终局公开原因且无法继续", () => {
  const s = create();
  choose(s);
  game.act(s, "a", { type: "word", value: "足球" }, context());
  assert.throws(() => game.act(s, "a", { type: "judge", value: true }, context()), /有效/);
  game.act(s, "a", { type: "judge", value: "reject" }, context());
  assert.equal(s.loserId, "a");
  assert.equal(s.status, "finished");
  assert.match(game.display(s, "b", context()).result!, /足球.*不符/);
  assert.equal(s.entries.length, 0);
  assert.deepEqual(game.display(s, "a", context()).choices, []);
  assert.throws(() => game.act(s, "a", { type: "skip" }, context()), /结束/);
});

test("各阶段超时：默认水果、审核自动接受、输入超时判负，提前alarm不影响状态", () => {
  const s = create();
  const before = structuredClone(s);
  game.timeout!(s, context(2000));
  assert.deepEqual(s, before);
  game.timeout!(s, context(s.deadline));
  assert.equal(s.category, "水果");
  assert.equal(s.stage, "answer");
  assert.equal(s.deadline, 61000);
  game.act(s, "a", { type: "word", value: "苹果" }, context(32000));
  assert.equal(s.deadline, 47000);
  game.timeout!(s, context(s.deadline));
  assert.equal(s.stage, "answer");
  assert.equal(s.scores.a, 1);
  assert.equal(s.deadline, 77000);
  assert.throws(() => game.act(s, "b", { type: "word", value: "香蕉" }, context(77000)), /超时/);
  game.timeout!(s, context(s.deadline));
  assert.equal(s.status, "finished");
  assert.equal(s.loserId, "b");
  assert.equal(s.deadline, undefined);
});

test("完整三圈可全员通关，之后没有操作；下一局首位轮换", () => {
  const s = create();
  choose(s);
  const words = ["苹果", "香蕉", "葡萄", "草莓", "橙子", "西瓜", "桃子", "梨", "芒果"];
  for (const word of words) {
    const id = s.playerIds[s.turn];
    game.act(s, id, { type: "word", value: word }, context());
    game.act(s, "a", { type: "judge", value: "accept" }, context());
  }
  assert.equal(s.status, "finished");
  assert.equal(s.loserId, undefined);
  assert.equal(s.entries.length, 9);
  assert.deepEqual(s.scores, { a: 3, b: 3, c: 3 });
  assert.match(s.result!, /全员通关/);
  assert.equal(s.deadline, undefined);
  const next = game.create(players, { ...context(), roundNumber: 2 }) as CategoriesState;
  assert.equal(next.turn, 1);
});

test("当前玩家认输可终止，其他玩家和审核阶段不能抢先认输", () => {
  const s = create();
  choose(s);
  assert.throws(() => game.act(s, "b", { type: "skip" }, context()), /轮到/);
  game.act(s, "a", { type: "skip" }, context());
  assert.equal(s.loserId, "a");
  assert.match(s.result!, /认输/);
  assert.equal(s.deadline, undefined);
});
