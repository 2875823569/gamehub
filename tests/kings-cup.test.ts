import test from "node:test";
import assert from "node:assert/strict";
import { game, type KingsState } from "../packages/games/kings-cup/rules";
import type { GameContext } from "../packages/games/core";

const players = ["a", "b", "c"].map(id => ({ id, name: id.toUpperCase() }));
const ctx: GameContext = { now: 100, randomInt: max => max - 1, hostId: "a", roundNumber: 1 };
function fresh(): KingsState { return game.create(players, ctx) as KingsState; }
function prepare(rank: number) {
  const s = fresh();
  s.deck = [{ suit: "♠", rank }];
  game.act(s, "a", { type: "draw" }, ctx);
  return s;
}

test("standard deck has 52 distinct cards and display never leaks undealt deck", () => {
  const s = fresh();
  assert.equal(s.deck.length, 52);
  assert.equal(new Set(s.deck.map(c => `${c.suit}${c.rank}`)).size, 52);
  const view = game.display(s, "a", ctx);
  assert.equal("deck" in view, false);
  assert.deepEqual(view.cards, []);
  assert.throws(() => game.act(s, "b", { type: "draw" }, ctx), /轮到/);
  assert.throws(() => game.act(s, "spectator", { type: "draw" }, ctx), /观战/);
});

test("fourth king ends immediately, crowns drawer and removes deadline", () => {
  const s = fresh();
  s.deck = Array.from({ length: 4 }, (_, i) => ({ suit: String(i), rank: 13 }));
  for (let i = 0; i < 4; i++) {
    const id = s.playerIds[s.turn];
    game.act(s, id, { type: "draw" }, ctx);
    if (i < 3) game.act(s, id, { type: "answer", value: "希望朋友开心" }, ctx);
  }
  assert.equal(s.status, "finished");
  assert.equal(s.kings, 4);
  assert.equal(s.deck.length, 0);
  assert.equal(s.deadline, undefined);
  assert.equal(s.crowned, "a");
  assert.match(game.display(s, "b", ctx).result!, /终局国王：A/);
  assert.throws(() => game.act(s, "a", { type: "draw" }, ctx), /已经结束/);
});

test("target selection forbids self or outsider; selected player owns answer", () => {
  const s = prepare(2);
  assert.throws(() => game.act(s, "a", { type: "target", value: "a" }, ctx), /另一位/);
  assert.throws(() => game.act(s, "a", { type: "target", value: "outsider" }, ctx), /另一位/);
  game.act(s, "a", { type: "target", value: "b" }, ctx);
  assert.throws(() => game.act(s, "a", { type: "answer", value: "真棒" }, ctx), /无需回答/);
  game.act(s, "b", { type: "answer", value: "你很会照顾朋友" }, ctx);
  assert.equal(s.scores.b, 1);
  assert.equal(s.stage, "draw");
  assert.equal(s.turn, 1);
  assert.throws(() => game.act(s, "b", { type: "answer", value: "重复加分" }, ctx), /当前阶段/);
});

test("simultaneous answers stay private until everyone responds", () => {
  const s = prepare(4);
  game.act(s, "a", { type: "target", value: "b" }, ctx);
  game.act(s, "a", { type: "answer", value: "秘密目的地" }, ctx);
  assert.equal(JSON.stringify(game.display(s, "b", ctx)).includes("秘密目的地"), false);
  assert.equal(JSON.stringify(game.display(s, "outsider", ctx)).includes("秘密目的地"), false);
  assert.throws(() => game.act(s, "a", { type: "answer", value: "改答案" }, ctx), /已提交/);
  game.act(s, "b", { type: "skip" }, ctx);
  assert.match(game.display(s, "b", ctx).history!.join(" "), /秘密目的地/);
  assert.equal(s.scores.a, 1);
  assert.equal(s.scores.b, 0);
});

test("chain checks turns and normalized duplicates then completes one lap", () => {
  const s = prepare(12);
  game.act(s, "a", { type: "category", value: "城市" }, ctx);
  assert.throws(() => game.act(s, "b", { type: "answer", value: "北京" }, ctx), /轮到/);
  game.act(s, "a", { type: "answer", value: "Paris" }, ctx);
  assert.throws(() => game.act(s, "b", { type: "answer", value: "ＰＡＲＩＳ" }, ctx), /已经出现/);
  game.act(s, "b", { type: "answer", value: "北京" }, ctx);
  game.act(s, "c", { type: "skip" }, ctx);
  assert.equal(s.stage, "draw");
  assert.equal(s.turn, 1);
  assert.deepEqual(s.scores, { a: 1, b: 1, c: 0 });
});

test("timeouts advance correctly without repeated past deadlines", () => {
  const s = prepare(9);
  const firstDeadline = s.deadline!;
  game.timeout!(s, { ...ctx, now: firstDeadline - 1 });
  assert.equal(s.chain[0], "a");
  game.timeout!(s, { ...ctx, now: firstDeadline });
  assert.equal(s.chain[0], "b");
  assert.ok(s.deadline! > firstDeadline);
  game.timeout!(s, { ...ctx, now: s.deadline! });
  game.timeout!(s, { ...ctx, now: s.deadline! });
  assert.equal(s.stage, "draw");
  assert.equal(s.turn, 1);
});

test("choice input, text bounds and expired actions are rejected", () => {
  const group = prepare(1);
  assert.throws(() => game.act(group, "a", { type: "answer", value: "伪造选项" }, ctx), /列出的选项/);
  const s = prepare(3);
  for (const value of [" ", "字".repeat(61), "a\u0000b", 42]) {
    assert.throws(() => game.act(s, "a", { type: "answer", value }, ctx));
  }
  assert.throws(() => game.act(s, "a", { type: "answer", value: "有效文字" }, { ...ctx, now: s.deadline! }), /超时/);
});

test("all ranks offer a finite task and spectator never receives controls", () => {
  for (let rank = 1; rank <= 13; rank++) {
    const s = prepare(rank);
    assert.equal(s.drawn.length, 1);
    assert.ok(s.deadline! > ctx.now);
    const view = game.display(s, "outsider", ctx);
    assert.deepEqual(view.choices, []);
    assert.equal(view.input, undefined);
  }
});

test("a complete game traverses all ranks, never repeats a card and always terminates", () => {
  const s = fresh();
  let actions = 0;
  while (s.status === "playing" && actions < 400) {
    let acted = false;
    for (const id of s.playerIds) {
      const view = game.display(s, id, ctx);
      if (view.input) {
        game.act(s, id, { type: view.input.id, value: `贡献${actions}` }, ctx);
        acted = true;
      } else {
        const choice = view.choices?.find(c => c.id !== "skip");
        if (choice) {
          game.act(s, id, { type: choice.id, value: choice.value }, ctx);
          acted = true;
        }
      }
      if (acted) break;
    }
    assert.ok(acted, `No legal control at ${s.stage}, rank ${s.drawn.at(-1)?.rank}`);
    actions++;
  }
  assert.equal(s.status, "finished");
  assert.equal(new Set(s.drawn.map(c => `${c.suit}${c.rank}`)).size, s.drawn.length);
  assert.equal(s.kings, 4);
  assert.ok(s.drawn.length <= 52);
});

test("draw timeout uses the normal card effect without inventing a personal response", () => {
  const s = fresh();
  s.deck = [{ suit: "♠", rank: 3 }];
  const now = s.deadline!;
  game.timeout!(s, { ...ctx, now });
  assert.equal(s.stage, "task");
  assert.deepEqual(s.pending, ["a"]);
  assert.deepEqual(s.answers, {});
  assert.equal(s.scores.a, 0);
  assert.equal(s.drawn.length, 1);
  assert.equal(s.deadline, now + 60_000);
  game.timeout!(s, { ...ctx, now: s.deadline! });
  assert.equal(s.stage, "draw");
  assert.equal(s.scores.a, 0);
});

test("an entirely idle game consumes its deck and ends at the fourth king", () => {
  const maxPlayers = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `玩家${i}` }));
  let s = game.create(maxPlayers, ctx) as KingsState;
  let alarms = 0;
  while (s.status === "playing" && alarms < 200) {
    assert.ok(Number.isFinite(s.deadline));
    const now = s.deadline!;
    game.timeout!(s, { ...ctx, now });
    s = JSON.parse(JSON.stringify(s)) as KingsState;
    if (s.status === "playing") assert.ok(s.deadline! > now);
    alarms++;
  }
  assert.equal(s.status, "finished");
  assert.equal(s.kings, 4);
  assert.equal(s.deadline, undefined);
  assert.ok(s.drawn.length <= 52);
  assert.equal(s.drawn.length + s.deck.length, 52);
  assert.equal(new Set(s.drawn.map(c => `${c.suit}${c.rank}`)).size, s.drawn.length);
  assert.ok(Object.values(s.scores).every(score => score === 0));
  assert.ok(game.display(s, maxPlayers[0].id, ctx).result);
});
