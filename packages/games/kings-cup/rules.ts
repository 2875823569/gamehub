import { defineGame, requirePlayer, requireTurn, roster, shuffle, type GameContext, type GameDisplay, type GamePlayer, type GameState } from "../core";

interface Card { rank: number; suit: string }
export interface KingsState extends GameState {
  deck: Card[];
  drawn: Card[];
  turn: number;
  stage: "draw" | "target" | "category" | "task" | "chain";
  kings: number;
  scores: Record<string, number>;
  pending: string[];
  answers: Record<string, string>;
  chain: string[];
  words: string[];
  category: string;
  houseRules: string[];
  history: string[];
  crowned?: string;
}

const names = ["", "全场打招呼", "点名夸夸", "我的趣事", "双人默契", "奇数座选择", "偶数座选择", "隔空击掌", "今日搭档", "押韵接龙", "今日心情", "临时口头约定", "分类接龙", "国王心愿"];
const ranks = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const groups: Record<number, string[]> = {
  1: ["你好呀", "今晚开心", "好久不见"],
  5: ["清晨", "夜晚"],
  6: ["山野", "海边"],
  7: ["已击掌"],
  10: ["充满能量", "放松一下", "期待惊喜"]
};
const current = (s: KingsState) => s.playerIds[s.turn];
const rank = (s: KingsState) => s.drawn.at(-1)?.rank ?? 0;
const textKey = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase();
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("请输入文字。");
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > 60 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error("请输入1～60字，不包含控制字符。");
  return trimmed;
}
function log(s: KingsState, entry: string) {
  s.history.push(entry);
  if (s.history.length > 16) s.history.shift();
}
function next(s: KingsState, ctx: GameContext) {
  s.pending = [];
  s.answers = {};
  s.chain = [];
  s.words = [];
  s.category = "";
  s.turn = (s.turn + 1) % s.playerIds.length;
  s.stage = "draw";
  s.deadline = ctx.now + 30_000;
}
function task(s: KingsState, ids: string[], ctx: GameContext) {
  s.stage = "task";
  s.pending = ids;
  s.answers = {};
  s.deadline = ctx.now + (groups[rank(s)] ? 45_000 : 60_000);
}
function startChain(s: KingsState, ctx: GameContext) {
  s.stage = "chain";
  s.chain = [...s.playerIds.slice(s.turn), ...s.playerIds.slice(0, s.turn)];
  s.words = [];
  s.deadline = ctx.now + 30_000;
}
function draw(s: KingsState, ctx: GameContext) {
  const id = current(s);
  const card = s.deck.pop()!;
  s.drawn.push(card);
  log(s, `${s.names[id]}抽到${card.suit}${ranks[card.rank]} · ${names[card.rank]}`);
  s.answers = {};
  if (card.rank === 13) {
    s.kings++;
    if (s.kings === 4) {
      s.status = "finished";
      s.crowned = id;
      delete s.deadline;
      return;
    }
  }
  if ([2, 4, 8].includes(card.rank)) {
    s.stage = "target";
    s.deadline = ctx.now + 30_000;
  } else if (card.rank === 12) {
    s.stage = "category";
    s.deadline = ctx.now + 30_000;
  } else if (card.rank === 9) startChain(s, ctx);
  else {
    const ids = [1, 7, 10].includes(card.rank) ? s.playerIds
      : card.rank === 5 ? s.playerIds.filter((_, i) => i % 2 === 0)
      : card.rank === 6 ? s.playerIds.filter((_, i) => i % 2 === 1) : [id];
    task(s, [...ids], ctx);
  }
}
function recordAnswer(s: KingsState, id: string, value: string, skipped: boolean, ctx: GameContext) {
  if (!s.pending.includes(id) || Object.hasOwn(s.answers, id)) throw new Error("你已提交，或本轮无需回答。");
  s.answers[id] = skipped ? "跳过" : value;
  if (!skipped) {
    s.scores[id]++;
    if (rank(s) === 11) s.houseRules = [...s.houseRules, value].slice(-3);
  }
  if (s.pending.every(p => Object.hasOwn(s.answers, p))) {
    log(s, `${names[rank(s)]}：${s.pending.map(p => `${s.names[p]}「${s.answers[p]}」`).join(" · ")}`);
    next(s, ctx);
  }
}
function chainAnswer(s: KingsState, id: string, value: string | undefined, ctx: GameContext) {
  requireTurn(s, id, s.chain[0]);
  if (value !== undefined) {
    if (s.words.some(word => textKey(word) === textKey(value))) throw new Error("这个词已经出现过，换一个吧。");
    s.words.push(value);
    s.scores[id]++;
    log(s, `${s.names[id]}：${value}`);
  } else log(s, `${s.names[id]}跳过本次接龙。`);
  s.chain.shift();
  if (!s.chain.length) next(s, ctx);
  else s.deadline = ctx.now + 30_000;
}
function prompt(s: KingsState): string {
  if (s.status === "finished") return `第四张K出现！${s.names[s.crowned!]}成为终局国王。`;
  if (s.stage === "draw") return `轮到${s.names[current(s)]}抽一张牌。`;
  if (s.stage === "target") return "选择另一位玩家，开启这张牌的互动。";
  if (s.stage === "category") return "选择本轮接龙类别。";
  if (s.stage === "chain") return rank(s) === 9
    ? `${s.names[s.chain[0]]}来接一个押韵的词${s.words.length ? `，首词是「${s.words[0]}」` : "，你来定第一个词"}。`
    : `${s.names[s.chain[0]]}说一个${s.category}，不能和已有词重复。`;
  return ({
    1: "给全场送上一个问候。",
    2: "给朋友写一句真诚的夸奖。",
    3: "分享你最近遇到的一件小趣事。",
    4: "两位搭档各写一个想一起去的地方，看看有没有默契。",
    5: "奇数座玩家选择：你更喜欢清晨还是夜晚？",
    6: "偶数座玩家选择：你更喜欢山野还是海边？",
    7: "和朋友隔空击掌，然后点击确认。",
    8: "两位搭档各写一句送给彼此的祝福。",
    10: "选择你此刻的心情。",
    11: "写一条轻松的口头约定，例如“称呼别人时加个老师”。",
    13: "国王许愿：写下一个最近想实现的小愿望。"
  } as Record<number, string>)[rank(s)] ?? "完成本轮互动。";
}
function create(players: GamePlayer[], ctx: GameContext): KingsState {
  if (players.length < 3 || players.length > 10 || new Set(players.map(p => p.id)).size !== players.length) throw new Error("国王杯需要3～10位不同玩家。");
  const deck = ["♠", "♥", "♣", "♦"].flatMap(suit => Array.from({ length: 13 }, (_, i) => ({ suit, rank: i + 1 })));
  return {
    ...roster(players), status: "playing", deadline: ctx.now + 30_000,
    deck: shuffle(deck, ctx.randomInt), drawn: [], turn: Math.max(0, ctx.roundNumber - 1) % players.length,
    stage: "draw", kings: 0, scores: Object.fromEntries(players.map(p => [p.id, 0])),
    pending: [], answers: {}, chain: [], words: [], category: "", houseRules: [], history: []
  };
}

export const game = defineGame<KingsState>({
  id: "kings-cup", minPlayers: 3, maxPlayers: 10, create,
  act(s, id, action, ctx) {
    requirePlayer(s, id);
    if (s.deadline !== undefined && ctx.now >= s.deadline) throw new Error("本次操作已超时，请等待游戏更新。");
    if (action.type === "skip") {
      if (s.stage === "task") recordAnswer(s, id, "", true, ctx);
      else if (s.stage === "chain") chainAnswer(s, id, undefined, ctx);
      else {
        requireTurn(s, id, current(s));
        if (s.stage === "draw") throw new Error("请抽取一张牌。");
        log(s, `${s.names[id]}跳过了${names[rank(s)]}。`);
        next(s, ctx);
      }
      return;
    }
    if (s.stage === "draw" && action.type === "draw") {
      requireTurn(s, id, current(s));
      draw(s, ctx);
    } else if (s.stage === "target" && action.type === "target") {
      requireTurn(s, id, current(s));
      if (typeof action.value !== "string" || action.value === id || !s.playerIds.includes(action.value)) throw new Error("请选择另一位本局玩家。");
      task(s, rank(s) === 2 ? [action.value] : [id, action.value], ctx);
    } else if (s.stage === "category" && action.type === "category") {
      requireTurn(s, id, current(s));
      if (typeof action.value !== "string" || !["水果", "城市", "电影"].includes(action.value)) throw new Error("请选择列出的类别。");
      s.category = action.value;
      startChain(s, ctx);
    } else if (s.stage === "task" && action.type === "answer") {
      const options = groups[rank(s)];
      const answer = options
        ? (typeof action.value === "string" && options.includes(action.value) ? action.value : undefined)
        : text(action.value);
      if (answer === undefined) throw new Error("请选择列出的选项。");
      recordAnswer(s, id, answer, false, ctx);
    } else if (s.stage === "chain" && action.type === "answer") chainAnswer(s, id, text(action.value), ctx);
    else throw new Error("当前阶段不能执行该操作。");
  },
  display(s, viewer): GameDisplay {
    const card = s.drawn.at(-1);
    const d: GameDisplay = {
      title: s.stage === "draw" ? "国王杯" : names[rank(s)],
      prompt: prompt(s),
      subtitle: "抽一张牌，打开一个新话题。",
      progress: `已抽 ${s.drawn.length}/52 张 · 国王 ${s.kings}/4`,
      turnId: s.status === "finished" ? undefined : s.stage === "chain" ? s.chain[0] : current(s),
      cards: card ? [`${card.suit}${ranks[card.rank]}`] : [],
      rows: s.playerIds.map(id => ({ label: s.names[id], value: `${s.scores[id]} 点`, highlight: id === viewer })),
      history: [...s.history],
      deadline: s.deadline,
      choices: [],
      notice: s.houseRules.length ? `当前口头约定：${s.houseRules.join("；")}` : "任务可跳过，完成互动得1点。"
    };
    if (s.status === "finished") {
      const top = Math.max(...Object.values(s.scores));
      d.result = `终局国王：${s.names[s.crowned!]}。互动积分领先：${s.playerIds.filter(id => s.scores[id] === top).map(id => s.names[id]).join("、")}（${top}点）。`;
      return d;
    }
    if (!s.playerIds.includes(viewer)) { d.notice += " 你正在观战，下一局即可参与。"; return d; }
    if (s.stage === "draw" && viewer === current(s)) d.choices = [{ id: "draw", label: "抽一张牌" }];
    if (s.stage === "target" && viewer === current(s)) d.choices = [
      ...s.playerIds.filter(id => id !== viewer).map(id => ({ id: "target", label: s.names[id], value: id })),
      { id: "skip", label: "跳过这张牌" }
    ];
    if (s.stage === "category" && viewer === current(s)) d.choices = [
      ...["水果", "城市", "电影"].map(value => ({ id: "category", label: value, value })),
      { id: "skip", label: "跳过这张牌" }
    ];
    if (s.stage === "task") {
      d.progress += ` · 已回应 ${Object.keys(s.answers).length}/${s.pending.length}`;
      if (s.pending.includes(viewer) && !Object.hasOwn(s.answers, viewer)) {
        d.choices = groups[rank(s)]?.map(value => ({ id: "answer", label: value === "已击掌" ? "击掌完成 ✋" : value, value })) ?? [];
        if (!groups[rank(s)]) d.input = { id: "answer", label: "写下你的回应", type: "text", maxLength: 60, placeholder: "1～60字" };
        d.choices.push({ id: "skip", label: "这次跳过" });
      } else d.notice += Object.hasOwn(s.answers, viewer) ? " 你的回应已提交，等待其他玩家。" : " 等待本轮玩家回应。";
    }
    if (s.stage === "chain") {
      d.cards = [...(d.cards ?? []), ...s.words];
      d.notice += " 服务器检查重复；押韵或类别归属请大家自觉核对。";
      if (viewer === s.chain[0]) {
        d.input = { id: "answer", label: "接一个词", type: "text", maxLength: 60, placeholder: s.category || "与首词押韵" };
        d.choices = [{ id: "skip", label: "这次跳过" }];
      }
    }
    return d;
  },
  timeout(s, ctx) {
    if (s.status !== "playing" || s.deadline === undefined || ctx.now < s.deadline) return;
    if (s.stage === "draw") {
      log(s, `${s.names[current(s)]}抽牌超时，自动抽取一张。`);
      draw(s, ctx);
      return;
    }
    if (s.stage === "chain") {
      chainAnswer(s, s.chain[0], undefined, ctx);
      return;
    }
    if (s.stage === "task") {
      for (const id of [...s.pending]) if (!Object.hasOwn(s.answers, id)) s.answers[id] = "超时跳过";
      log(s, `${names[rank(s)]}：${s.pending.map(id => `${s.names[id]}「${s.answers[id]}」`).join(" · ")}`);
    } else log(s, `${s.names[current(s)]}操作超时，轮到下一位。`);
    next(s, ctx);
  }
});
