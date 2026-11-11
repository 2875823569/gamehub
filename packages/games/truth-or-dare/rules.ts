import { defineGame, requirePlayer, requireTurn, roster, shuffle, type GameContext, type GameState } from "../core";

const truths = [
  "最近哪件小事让你开心了一整天？", "如果明天不用工作或上课，你最想怎么过？",
  "你最拿手的一道家常菜是什么？", "小时候最想拥有的超能力是什么？",
  "你听过最有趣的一句口头禅是什么？", "有什么食物是你小时候不爱、现在喜欢的？",
  "最近发现的一首好歌叫什么？", "你最喜欢一天中的哪个时刻，为什么？",
  "如果只能带一本书去旅行，你会选哪本？", "你最近学会了什么新技能？",
  "你最想重温的动画片是什么？", "有没有一种天气会让你特别有灵感？",
  "你心里的理想周末早餐是什么？", "如果能开一家小店，你会卖什么？",
  "什么不起眼的小物件让你的生活更方便？", "哪种味道最容易让你想起童年？",
  "你想去但还没去过的一座城市是哪座？", "你最近一次忍不住笑出声是因为什么？",
  "你给自己取一个游戏称号，会叫什么？", "什么事你觉得慢慢做比赶着做更好？",
  "你最喜欢的一个汉字是什么？", "你有什么冷门但实用的小技巧？",
  "如果给今天取个电影名，会叫什么？", "你期待下个季节发生什么好事？"
];
const dares = [
  "想象你是一位天气主播，用一句话播报今天的心情。", "用三个词描述一只正在度假的猫。",
  "给身边一件普通物品取一个超级英雄名字。", "用一句话为“会唱歌的雨伞”设计广告词。",
  "用文字或声音模仿火车进站的播报。", "编一句含有“月亮”和“面条”的台词。",
  "为你最喜欢的水果想一个新名字。", "想象一条龙开了咖啡馆，替它写一句欢迎语。",
  "用三个表情符号概括你今天的心情。", "把自己的昵称编进一句押韵的话。",
  "用慢动作表情演出“发现今天放假了”，或用文字描述。", "给一只会做饭的企鹅设计招牌菜。",
  "现场编一个只有十个字以内的童话结尾。", "为今天的聚会取一个电影片名。",
  "想象你是机器人，用一句话介绍自己。", "说出三样蓝色物品，不能说天空和大海。",
  "把“欢迎来到游戏房间”换成古装剧里的说法。", "用一句话夸奖一种被忽略的日用品。",
  "给太空旅行设计一种奇怪但无害的纪念品。", "为一杯白开水编一段十字以内的推荐语。",
  "设计一个只有你知道的招呼动作，或用文字描述。", "用三个短词描绘一场糖果雨。",
  "想象你是一片云，告诉大家你今天要去哪里。", "为“迟到的闹钟”编一句道歉词。"
];

type Kind = "truth" | "dare";
export interface TruthDareState extends GameState {
  phase: "choose" | "task" | "reveal";
  turn: number;
  kind?: Kind;
  question?: string;
  redraws: number;
  decks: Record<Kind, string[]>;
  completed: Record<string, number>;
  skipped: Record<string, number>;
  history: string[];
  last?: string;
}

function pick(state: TruthDareState, kind: Kind, context: GameContext) {
  if (!state.decks[kind].length) {
    state.decks[kind] = shuffle(kind === "truth" ? truths : dares, context.randomInt);
    if (state.decks[kind].at(-1) === state.question) state.decks[kind].unshift(state.decks[kind].pop()!);
  }
  return state.decks[kind].pop()!;
}

function current(state: TruthDareState) { return state.playerIds[state.turn % state.playerIds.length]; }

function complete(state: TruthDareState, context: GameContext, answer?: string) {
  const playerId = current(state);
  const done = answer !== undefined;
  if (done) state.completed[playerId]++;
  else state.skipped[playerId]++;
  state.last = done
    ? `${state.names[playerId]} · ${state.question} → ${answer}`
    : `${state.names[playerId]} · 跳过了本回合`;
  state.history.push(state.last);
  state.phase = "reveal";
  state.deadline = context.now + 8_000;
}

function advance(state: TruthDareState, context: GameContext) {
  state.turn++;
  if (state.turn >= state.playerIds.length * 2) {
    state.status = "finished";
    delete state.deadline;
    return;
  }
  state.phase = "choose";
  delete state.kind;
  delete state.question;
  state.redraws = 0;
  state.deadline = context.now + 30_000;
}

export const game = defineGame<TruthDareState>({
  id: "truth-or-dare",
  minPlayers: 2,
  maxPlayers: 10,
  create(players, context) {
    if (players.length < 2 || players.length > 10 || new Set(players.map(p => p.id)).size !== players.length) throw new Error("需要2～10位不同玩家。");
    return {
      ...roster(players), status: "playing", phase: "choose", turn: 0, redraws: 0,
      decks: { truth: shuffle(truths, context.randomInt), dare: shuffle(dares, context.randomInt) },
      completed: Object.fromEntries(players.map(p => [p.id, 0])),
      skipped: Object.fromEntries(players.map(p => [p.id, 0])),
      history: [], deadline: context.now + 30_000
    };
  },
  act(state, playerId, action, context) {
    requirePlayer(state, playerId);
    if (state.deadline !== undefined && context.now >= state.deadline) throw new Error("时间已到，请等待画面更新。");
    if (state.phase === "reveal") {
      if (action.type !== "next" || playerId !== context.hostId) throw new Error("展示中，只有房主可以提前进入下一位。");
      advance(state, context);
      return;
    }
    requireTurn(state, playerId, current(state));
    if (action.type === "skip") { complete(state, context); return; }
    if (state.phase === "choose") {
      if (action.type !== "choose" || (action.value !== "truth" && action.value !== "dare")) throw new Error("请选择真心话或大冒险。");
      state.kind = action.value;
      state.question = pick(state, state.kind, context);
      state.phase = "task";
      state.deadline = context.now + 90_000;
      return;
    }
    if (action.type === "redraw") {
      if (state.redraws >= 2) throw new Error("本回合换题次数已用完，还可以跳过。");
      state.question = pick(state, state.kind!, context);
      state.redraws++;
      return;
    }
    if (state.kind === "truth" && action.type === "answer") {
      if (typeof action.value !== "string") throw new Error("请填写文字答案。");
      const answer = action.value.trim();
      if (!answer || [...answer].length > 120 || /[\u0000-\u001f\u007f]/u.test(answer)) throw new Error("答案需要1～120字，不含控制字符。");
      complete(state, context, answer);
      return;
    }
    if (state.kind === "dare" && action.type === "done") { complete(state, context, "已完成"); return; }
    throw new Error("当前阶段不支持这个操作。");
  },
  display(state, viewerId, context) {
    const finished = state.status === "finished";
    const playerId = current(state);
    const mine = !finished && state.playerIds.includes(viewerId) && viewerId === playerId;
    const rows = state.playerIds.map(id => ({ label: state.names[id], value: `完成 ${state.completed[id]} · 跳过 ${state.skipped[id]}`, highlight: !finished && id === playerId }));
    const display = {
      title: "真心话大冒险",
      prompt: finished ? "每个人的两轮都结束了，感谢你分享今天的小故事。" :
        state.phase === "choose" ? `${state.names[playerId]}，这一轮选真心话，还是大冒险？` :
        state.phase === "reveal" ? state.last! : state.question!,
      subtitle: finished ? "尽兴就好，下一局再见" : state.phase === "task" ? state.kind === "truth" ? "真心话 · 文字答案会展示给房间内所有人" : "大冒险 · 完成后由本人确认" : "每人两轮 · 可自由跳过",
      turnId: finished ? undefined : playerId,
      progress: `第 ${Math.min(state.turn + 1, state.playerIds.length * 2)} / ${state.playerIds.length * 2} 回合`,
      deadline: finished ? undefined : state.deadline,
      rows,
      history: [...state.history],
      choices: [] as { id: string; label: string; value?: string; disabled?: boolean }[],
      input: undefined as { id: string; label: string; type: "text"; maxLength: number; placeholder: string } | undefined,
      notice: "不想分享或完成的内容可以直接跳过。",
      result: finished ? `本局共完成 ${Object.values(state.completed).reduce((sum, n) => sum + n, 0)} 次互动。` : undefined
    };
    if (finished) return display;
    if (state.phase === "reveal") {
      if (viewerId === context.hostId && state.playerIds.includes(viewerId)) display.choices.push({ id: "next", label: state.turn + 1 >= state.playerIds.length * 2 ? "查看本局总结" : "下一位 →" });
      return display;
    }
    if (!mine) { display.notice = `等待 ${state.names[playerId]} 操作。`; return display; }
    if (state.phase === "choose") {
      display.choices.push({ id: "choose", label: "真心话", value: "truth" }, { id: "choose", label: "大冒险", value: "dare" });
    } else {
      if (state.kind === "truth") display.input = { id: "answer", label: "分享你的回答（全房间可见）", type: "text", maxLength: 120, placeholder: "写下愿意分享的答案…" };
      else display.choices.push({ id: "done", label: "已完成 ✓" });
      display.choices.push({ id: "redraw", label: `换一道题 · 剩余 ${2 - state.redraws} 次`, disabled: state.redraws >= 2 });
    }
    display.choices.push({ id: "skip", label: "跳过这一轮" });
    return display;
  },
  timeout(state, context) {
    if (state.status !== "playing" || state.deadline === undefined || context.now < state.deadline) return;
    if (state.phase === "reveal") advance(state, context);
    else complete(state, context);
  }
});
