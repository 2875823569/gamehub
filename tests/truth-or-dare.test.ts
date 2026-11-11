import test from "node:test";
import assert from "node:assert/strict";
import { game, type TruthDareState } from "../packages/games/truth-or-dare/rules";
import type { GameContext } from "../packages/games/core";

const players = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }];
const context = (now = 1_000): GameContext => ({ now, hostId: "a", roundNumber: 1, randomInt: max => max - 1 });
const create = () => game.create(players, context()) as TruthDareState;

test("真心话答案全场展示，未抽题库不泄露，只有当前玩家有操作", () => {
  const state = create();
  assert.equal(game.display(state, "b", context()).choices?.length, 0);
  assert.throws(() => game.act(state, "b", { type: "choose", value: "truth" }, context()), /轮到/);
  game.act(state, "a", { type: "choose", value: "truth" }, context());
  assert.ok(game.display(state, "a", context()).input);
  assert.equal(game.display(state, "b", context()).input, undefined);
  assert.ok(!JSON.stringify(game.display(state, "b", context())).includes("decks"));
  game.act(state, "a", { type: "answer", value: "看见了晚霞" }, context());
  assert.match(game.display(state, "b", context()).prompt, /看见了晚霞/);
  assert.equal(state.completed.a, 1);
  assert.throws(() => game.act(state, "a", { type: "answer", value: "重复" }, context()), /展示中/);
});

test("限制换题且不延长时限；非法答案与错误操作不计分", () => {
  const state = create();
  game.act(state, "a", { type: "choose", value: "truth" }, context());
  const deadline = state.deadline;
  const first = state.question;
  game.act(state, "a", { type: "redraw" }, context(2_000));
  assert.notEqual(state.question, first);
  game.act(state, "a", { type: "redraw" }, context(3_000));
  assert.equal(state.deadline, deadline);
  assert.throws(() => game.act(state, "a", { type: "redraw" }, context(4_000)), /次数/);
  for (const value of ["", " ", "a".repeat(121), 7, "a\nb"]) {
    assert.throws(() => game.act(state, "a", { type: "answer", value }, context()));
  }
  assert.throws(() => game.act(state, "a", { type: "done" }, context()), /不支持/);
  assert.equal(state.completed.a, 0);
  game.act(state, "a", { type: "skip" }, context());
  assert.equal(state.skipped.a, 1);
});

test("大冒险完成、房主推进和两轮终局可完整游玩", () => {
  const state = create();
  for (let turn = 0; turn < 4; turn++) {
    const player = players[turn % 2].id;
    game.act(state, player, { type: "choose", value: "dare" }, context());
    assert.throws(() => game.act(state, player, { type: "answer", value: "文字" }, context()), /不支持/);
    game.act(state, player, { type: "done" }, context());
    assert.throws(() => game.act(state, "b", { type: "next" }, context()), /房主/);
    game.act(state, "a", { type: "next" }, context());
  }
  assert.equal(state.status, "finished");
  assert.equal(state.completed.a, 2);
  assert.equal(state.completed.b, 2);
  assert.equal(state.deadline, undefined);
  assert.match(game.display(state, "a", context()).result!, /4/);
  assert.equal(game.display(state, "a", context()).choices?.length, 0);
  assert.throws(() => game.act(state, "a", { type: "skip" }, context()), /结束/);
});

test("倒计时自动跳过并能推进整局；旁观与迟到操作拒绝", () => {
  const state = create();
  assert.throws(() => game.act(state, "spectator", { type: "skip" }, context()), /观战/);
  assert.equal(game.display(state, "spectator", context()).choices?.length, 0);
  assert.throws(() => game.act(state, "a", { type: "choose", value: "truth" }, context(state.deadline!)), /时间/);
  game.timeout!(state, context(state.deadline! - 1));
  assert.equal(state.skipped.a, 0);
  let now = state.deadline!;
  for (let i = 0; i < 8; i++) {
    now = state.deadline!;
    game.timeout!(state, context(now));
  }
  assert.equal(state.status, "finished");
  assert.equal(state.skipped.a, 2);
  assert.equal(state.skipped.b, 2);
  assert.equal(state.completed.a, 0);
  assert.equal(state.history.length, 4);
  game.timeout!(state, context(now + 100_000));
  assert.equal(state.history.length, 4);
});

test("只接受2～10个不同玩家，抽题种类严格校验", () => {
  assert.throws(() => game.create(players.slice(0, 1), context()), /2～10/);
  assert.throws(() => game.create([players[0], players[0]], context()), /不同玩家/);
  const state = create();
  assert.throws(() => game.act(state, "a", { type: "choose", value: "other" }, context()), /请选择/);
  assert.throws(() => game.act(state, "a", { type: "answer", value: "提前答" }, context()), /请选择/);
  assert.equal(state.phase, "choose");
});
