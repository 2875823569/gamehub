import { defineGame, requirePlayer, requireTurn, roster, type GameContext, type GameDisplay, type GameState } from "../core";

export const CATEGORIES = ["水果", "动物", "城市", "电影", "歌曲", "运动", "食物", "职业"] as const;
interface Entry { playerId: string; word: string; key: string }
export interface CategoriesState extends GameState {
  stage: "select" | "answer" | "review";
  category: string;
  turn: number;
  entries: Entry[];
  pending?: Entry;
  scores: Record<string, number>;
  history: string[];
  loserId?: string;
  result?: string;
}

const ANSWER_MS = 30_000;
const REVIEW_MS = 15_000;
const current = (s: CategoriesState) => s.playerIds[s.turn];
export const wordKey = (word: string) => word.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

function readWord(value: unknown): { word: string; key: string } {
  if (typeof value !== "string") throw new Error("请输入词语。");
  if (/[\u0000-\u001f\u007f]|\p{Cf}/u.test(value)) throw new Error("词语不能包含控制字符或零宽字符。");
  const word = value.trim().normalize("NFKC");
  const key = wordKey(word);
  if (!key || [...word].length > 20 || [...value.trim()].length > 20) throw new Error("请输入1～20字的词语。");
  return { word, key };
}

function finish(s: CategoriesState, result: string, loserId?: string) {
  s.status = "finished";
  s.result = result;
  s.loserId = loserId;
  delete s.deadline;
  delete s.pending;
}

function selectCategory(s: CategoriesState, category: string, ctx: GameContext) {
  s.category = category;
  s.stage = "answer";
  s.deadline = ctx.now + ANSWER_MS;
  s.history.push(`本局类别：${category}。`);
}

function accept(s: CategoriesState, ctx: GameContext, automatic = false) {
  const entry = s.pending!;
  s.entries.push(entry);
  s.scores[entry.playerId]++;
  s.history.push(`${s.names[entry.playerId]}：${entry.word}${automatic ? "（审核超时，自动接受）" : ""}`);
  delete s.pending;
  if (s.entries.length >= s.playerIds.length * 3) {
    finish(s, `三圈接龙完成！全员通关，共说出${s.entries.length}个${s.category}词语。`);
  } else {
    s.turn = (s.turn + 1) % s.playerIds.length;
    s.stage = "answer";
    s.deadline = ctx.now + ANSWER_MS;
  }
}

export const game = defineGame<CategoriesState>({
  id: "categories",
  minPlayers: 3,
  maxPlayers: 10,
  create(players, ctx) {
    if (players.length < 3 || players.length > 10 || new Set(players.map(p => p.id)).size !== players.length) throw new Error("分类接龙需要3～10位不同玩家。");
    return {
      ...roster(players), status: "playing", stage: "select", category: "",
      turn: Math.max(0, ctx.roundNumber - 1) % players.length,
      entries: [], scores: Object.fromEntries(players.map(p => [p.id, 0])), history: [],
      deadline: ctx.now + ANSWER_MS
    };
  },
  act(s, id, action, ctx) {
    requirePlayer(s, id);
    if (s.deadline !== undefined && ctx.now >= s.deadline) throw new Error("本次操作已超时，请等待游戏更新。");
    switch (action.type) {
      case "category":
        if (s.stage !== "select") throw new Error("本局类别已经确定。");
        if (id !== ctx.hostId) throw new Error("只有房主可以选择类别。");
        if (typeof action.value !== "string" || !CATEGORIES.includes(action.value as typeof CATEGORIES[number])) throw new Error("请选择列表中的类别。");
        selectCategory(s, action.value, ctx);
        return;
      case "word": {
        if (s.stage !== "answer") throw new Error("当前不是提交词语的阶段。");
        requireTurn(s, id, current(s));
        const value = readWord(action.value);
        if (s.entries.some(entry => entry.key === value.key)) {
          s.history.push(`${s.names[id]}重复了「${value.word}」。`);
          finish(s, `${s.names[id]}重复了「${value.word}」，本局失败。`, id);
          return;
        }
        s.pending = { playerId: id, ...value };
        s.stage = "review";
        s.deadline = ctx.now + REVIEW_MS;
        return;
      }
      case "judge":
        if (s.stage !== "review" || !s.pending) throw new Error("当前没有待审核的词语。");
        if (id !== ctx.hostId) throw new Error("请讨论后由房主裁定。");
        if (action.value !== "accept" && action.value !== "reject") throw new Error("请选择有效或不符类别。");
        if (action.value === "accept") accept(s, ctx);
        else {
          const entry = s.pending;
          s.history.push(`${s.names[entry.playerId]}的「${entry.word}」被判不符类别。`);
          finish(s, `${s.names[entry.playerId]}的「${entry.word}」被房主判为不符「${s.category}」，本局失败。`, entry.playerId);
        }
        return;
      case "skip":
        if (s.stage !== "answer") throw new Error("只能在自己的输入回合认输。");
        requireTurn(s, id, current(s));
        finish(s, `${s.names[id]}暂时想不出来，主动认输。`, id);
        return;
      default:
        throw new Error("不支持的分类接龙操作。");
    }
  },
  timeout(s, ctx) {
    if (s.status !== "playing" || s.deadline === undefined || ctx.now < s.deadline) return;
    if (s.stage === "select") selectCategory(s, CATEGORIES[0], ctx);
    else if (s.stage === "review") accept(s, ctx, true);
    else finish(s, `${s.names[current(s)]}未在30秒内提交词语，本局失败。`, current(s));
  },
  display(s, viewerId, ctx) {
    const done = s.status === "finished";
    const participant = s.playerIds.includes(viewerId);
    const d: GameDisplay = {
      title: "分类接龙",
      subtitle: s.category ? `本局类别：${s.category} · 每人每次一个词` : "选定类别，让词语接力。",
      prompt: done ? s.result ?? "本局结束。" : s.stage === "select" ? "等房主选择一个类别。"
        : s.stage === "review" ? `${s.names[s.pending!.playerId]}提交了「${s.pending!.word}」。这个词属于${s.category}吗？`
          : `轮到${s.names[current(s)]}，说一个还没有出现过的${s.category}词语。`,
      progress: `${s.entries.length} / ${s.playerIds.length * 3} 个有效词 · 共3圈`,
      turnId: s.stage === "select" || s.stage === "review" ? ctx.hostId : current(s),
      deadline: done ? undefined : s.deadline,
      notice: s.stage === "review" && !done ? "大家讨论，房主裁定；15秒未裁定将自动接受。系统只检查文字重复，不自动判断词义。" : "相同词语会判负；空格、全角和大小写差异不算新词。",
      history: [...s.history],
      rows: s.playerIds.map(id => ({ label: s.names[id], value: `${s.scores[id]} 个有效词${id === s.loserId ? " · 本局失败" : ""}`, highlight: id === s.loserId })),
      result: done ? s.result : undefined,
      choices: []
    };
    if (done || !participant) return d;
    if (s.stage === "select" && viewerId === ctx.hostId) {
      d.choices = CATEGORIES.map(category => ({ id: "category", label: category, value: category }));
    } else if (s.stage === "review" && viewerId === ctx.hostId) {
      d.choices = [{ id: "judge", label: "有效，继续", value: "accept" }, { id: "judge", label: "不符类别", value: "reject" }];
    } else if (s.stage === "answer" && viewerId === current(s)) {
      d.input = { id: "word", label: `输入一个${s.category}词语`, type: "text", maxLength: 20, placeholder: "不能和已接受的词重复" };
      d.choices = [{ id: "skip", label: "想不出来，认输" }];
    }
    return d;
  }
});
