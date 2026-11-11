import assert from "node:assert/strict";
import test from "node:test";
import { game, type DefuseState } from "../packages/games/defuse/rules";
import type { GameContext } from "../packages/games/core";
import { randomInt } from "node:crypto";

const players = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `队员${i}` }));
const context = (now = 1000): GameContext => ({ now, hostId: "p0", roundNumber: 1, randomInt });
const create = (count = 1) => game.create(players.slice(0, count), context()) as DefuseState;
const submit = (state: DefuseState, value: unknown, playerId = "p0", now = 2000) =>
  game.act(state, playerId, { type: `solve-${state.stage}`, value }, context(now));

test("1～6人都可完整通关，线索恰好分发一次，任意队员可以提交，JSON恢复保留进度", () => {
  for (let count = 1; count <= 6; count++) {
    let state = create(count);
    for (let stage = 0; stage < 3; stage++) {
      const clues = players.slice(0, count).flatMap(player => {
        const view = game.display(state, player.id, context());
        assert.ok(view.rows!.length >= 1);
        assert.equal(view.deadline, 181000);
        assert.equal("modules" in view, false);
        return view.rows!.map(row => row.label);
      });
      assert.equal(clues.length, 6);
      assert.equal(new Set(clues).size, 6);
      const spectator = game.display(state, "spectator", context());
      assert.equal(spectator.rows!.length, 0);
      assert.equal(spectator.choices!.length, 0);
      assert.equal(spectator.input, undefined);
      submit(state, state.modules[stage].answer, players[stage % count].id);
      state = JSON.parse(JSON.stringify(state));
      assert.equal(state.stage, stage + 1);
    }
    assert.equal(state.status, "finished");
    assert.equal(state.outcome, "success");
    assert.equal(state.deadline, undefined);
    assert.match(game.display(state, "p0", context()).result!, /炸弹已解除/);
    assert.throws(() => submit(state, "123"), /已经结束/);
  }
});

test("随机谜题始终可由线索唯一解出，独立推导结果与服务端答案一致", () => {
  for (let run = 0; run < 100; run++) {
    const state = create();
    const wire = state.modules[0];
    const excluded = wire.clues.filter(clue => clue.includes("不能剪")).map(clue => clue[0]);
    const safe = wire.cards.filter(card => !excluded.includes(card.split(" · ")[1][0]));
    assert.equal(safe.length, 1);
    assert.equal(safe[0][0], wire.answer);
    const keypad = state.modules[1];
    const sum = (prefix: string) => Number(keypad.clues.find(clue => clue.startsWith(prefix))!.match(/\d+/)![0]);
    const ab = sum("第一位与第二位");
    const bc = sum("第二位与第三位");
    const ac = sum("第一位与第三位");
    const a = (ab + ac - bc) / 2;
    const b = ab - a;
    const c = ac - a;
    assert.equal(`${a}${b}${c}`, keypad.answer);
    assert.ok([a, b, c].every(digit => digit >= 1 && digit <= 9 && Number.isInteger(digit)));
    assert.equal(new Set([a, b, c]).size, 3);
    const symbols = state.modules[2];
    const before = symbols.clues.filter(clue => clue.includes("前面")).map(clue => clue.slice(0, -3).split("在"));
    const names = symbols.cards.map(card => card.slice(4));
    const permutations = (items: string[]): string[][] => items.length === 0 ? [[]] : items.flatMap((item, i) =>
      permutations(items.filter((_, j) => i !== j)).map(rest => [item, ...rest]));
    const solutions = permutations(names).filter(order => before.every(([left, right]) => order.indexOf(left) < order.indexOf(right)));
    assert.equal(solutions.length, 1);
    assert.equal(solutions[0].map(name => names.indexOf(name) + 1).join(""), symbols.answer);
  }
});

test("格式错误、观战及过期模块操作不扣机会也不改变状态", () => {
  const state = create(2);
  const before = structuredClone(state);
  for (const value of [null, 1, {}, "", "0", "7", "11"]) assert.throws(() => submit(state, value), /按要求/);
  assert.throws(() => submit(state, "1", "spectator"), /观战/);
  assert.throws(() => game.act(state, "p0", { type: "solve-1", value: "123" }, context()), /模块已切换/);
  assert.deepEqual(state, before);
  submit(state, state.modules[0].answer);
  const after = structuredClone(state);
  assert.throws(() => game.act(state, "p1", { type: "solve-0", value: "1" }, context()), /模块已切换/);
  for (const value of ["112", "012", "1234", "abc"]) assert.throws(() => submit(state, value), /按要求/);
  assert.deepEqual(state, after);
  submit(state, state.modules[1].answer);
  for (const value of ["1123", "1235", "123"]) assert.throws(() => submit(state, value), /按要求/);
});

test("三个模块共享失误机会，第三次错误失败，不延长截止时间", () => {
  const state = create();
  submit(state, state.modules[0].answer === "1" ? "2" : "1");
  assert.equal(state.deadline, 181000);
  submit(state, state.modules[0].answer);
  submit(state, state.modules[1].answer === "123" ? "321" : "123");
  submit(state, state.modules[1].answer);
  submit(state, state.modules[2].answer === "1234" ? "4321" : "1234");
  assert.equal(state.status, "finished");
  assert.equal(state.outcome, "mistakes");
  assert.equal(state.stage, 2);
  assert.equal(state.mistakes, 3);
  assert.equal(state.deadline, undefined);
});

test("截止时刻禁止答题，超时幂等，失败后不再提供操作", () => {
  const state = create();
  game.timeout!(state, context(180999));
  assert.equal(state.status, "playing");
  assert.throws(() => submit(state, state.modules[0].answer, "p0", 181000), /时间已到/);
  game.timeout!(state, context(185000));
  assert.equal(state.outcome, "timeout");
  assert.equal(state.endedAt, 181000);
  const ended = structuredClone(state);
  game.timeout!(state, context(190000));
  assert.deepEqual(state, ended);
  const view = game.display(state, "p0", context());
  assert.equal(view.choices!.length, 0);
  assert.equal(view.input, undefined);
  assert.match(view.result!, /用时 180 秒/);
});

test("人数与身份校验", () => {
  for (const roster of [[], [players[0], players[0]], [...players, { id: "extra", name: "额外" }]]) {
    assert.throws(() => game.create(roster, context()), /1～6/);
  }
});
