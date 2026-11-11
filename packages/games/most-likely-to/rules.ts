import { defineGame, requirePlayer, roster, shuffle, type GameContext, type GameDisplay, type GameState } from "../core";

export interface MostLikelyState extends GameState {
  stage: "vote" | "reveal";
  questions: string[];
  questionIndex: number;
  votes: Record<string, string | null>;
  counts: Record<string, number>;
  totalVotes: Record<string, number>;
  spotlights: Record<string, number>;
  leaders: string[];
}

export const QUESTION_BANK = [
  "谁最可能把一场普通散步变成城市探险？",
  "谁最可能给家里的每盆植物取名字？",
  "谁最可能在旅行前做一本详细攻略？",
  "谁最可能只听前奏就猜出歌名？",
  "谁最可能把冰箱里的剩菜做成新菜？",
  "谁最可能在游戏输掉以后立刻说再来一局？",
  "谁最可能为一次野餐准备整套餐具？",
  "谁最可能把冷笑话讲得自己先笑出来？",
  "谁最可能记得所有朋友喜欢的饮料？",
  "谁最可能为了拍到日出早起两小时？",
  "谁最可能在陌生地方迅速找到好吃的小店？",
  "谁最可能在聚会结束后还记得合照？",
  "谁最可能把一段排队时间变成新朋友见面会？",
  "谁最可能给一件普通礼物设计特别的包装？",
  "谁最可能在拼图时坚持找到最后一片？",
  "谁最可能为周末安排一场说走就走的短途旅行？",
  "谁最可能在购物清单旁边画小插画？",
  "谁最可能听一遍故事就记住所有细节？",
  "谁最可能把好看的落叶夹进书里？",
  "谁最可能把生日祝福写成一首打油诗？",
  "谁最可能给一只路过的小猫配上内心独白？",
  "谁最可能在桌游规则讲解时提出关键问题？",
  "谁最可能在大家犹豫吃什么时提出新选择？",
  "谁最可能把房间整理得像一家小展馆？",
  "谁最可能在朋友需要时带来一份热乎的晚餐？",
  "谁最可能把一场小比赛解说得像世界决赛？",
  "谁最可能在看完电影后认真讨论片尾彩蛋？",
  "谁最可能把一张合照做成表情包？",
  "谁最可能记住一家店播放的背景音乐？",
  "谁最可能用纸箱做出有趣的小装置？",
  "谁最可能为朋友策划一场没有剧透的惊喜？",
  "谁最可能在雨天想出一整套室内活动？",
  "谁最可能在做饭时给每道菜取新名字？",
  "谁最可能找到一条大家都没走过的小路？",
  "谁最可能把普通周一过得很有仪式感？",
  "谁最可能在比赛开始前给小队设计口号？",
  "谁最可能为一张明信片挑选最合适的邮票？",
  "谁最可能在博物馆里认真读完说明牌？",
  "谁最可能把一件旧衣服改造成新物件？",
  "谁最可能在聚会散场时说下次我来组局？"
] as const;

const VOTE_MS = 45_000;
const REVEAL_MS = 10_000;
const TOTAL = 8;

function reveal(state: MostLikelyState, context: GameContext) {
  state.counts = Object.fromEntries(state.playerIds.map(id => [id, 0]));
  for (const id of state.playerIds) {
    if (!Object.hasOwn(state.votes, id)) state.votes[id] = null;
    const target = state.votes[id];
    if (target !== null) state.counts[target]++;
  }
  const maximum = Math.max(...Object.values(state.counts));
  state.leaders = maximum > 0 ? state.playerIds.filter(id => state.counts[id] === maximum) : [];
  for (const id of state.playerIds) {
    state.totalVotes[id] += state.counts[id];
    if (state.leaders.includes(id)) state.spotlights[id]++;
  }
  state.stage = "reveal";
  if (state.questionIndex === TOTAL - 1) {
    state.status = "finished";
    delete state.deadline;
  } else state.deadline = context.now + REVEAL_MS;
}

function next(state: MostLikelyState, context: GameContext) {
  state.questionIndex++;
  state.stage = "vote";
  state.votes = {};
  state.counts = {};
  state.leaders = [];
  state.deadline = context.now + VOTE_MS;
}

export const game = defineGame<MostLikelyState>({
  id: "most-likely-to",
  minPlayers: 3,
  maxPlayers: 10,
  create(players, context) {
    if (players.length < 3 || players.length > 10) throw new Error("谁最可能需要3～10人。");
    return {
      ...roster(players), status: "playing", stage: "vote",
      questions: shuffle(QUESTION_BANK, context.randomInt).slice(0, TOTAL),
      questionIndex: 0, votes: {}, counts: {}, leaders: [],
      totalVotes: Object.fromEntries(players.map(p => [p.id, 0])),
      spotlights: Object.fromEntries(players.map(p => [p.id, 0])),
      deadline: context.now + VOTE_MS
    };
  },
  act(state, playerId, action, context) {
    requirePlayer(state, playerId);
    if (action.type === "vote" || action.type === "skip") {
      if (state.stage !== "vote") throw new Error("本题已揭晓，请等待下一题。");
      if (context.now >= state.deadline!) throw new Error("投票时间已到。");
      if (Object.hasOwn(state.votes, playerId)) throw new Error("你已经提交过本题选择。");
      if (action.type === "vote" && (typeof action.value !== "string" || !state.playerIds.includes(action.value))) {
        throw new Error("请选择本局的一位玩家。");
      }
      state.votes[playerId] = action.type === "skip" ? null : action.value as string;
      if (state.playerIds.every(id => Object.hasOwn(state.votes, id))) reveal(state, context);
      return;
    }
    if (action.type === "next") {
      if (playerId !== context.hostId) throw new Error("只有房主可以提前进入下一题。");
      if (state.stage !== "reveal") throw new Error("请等待全员提交或倒计时结束。");
      next(state, context);
      return;
    }
    throw new Error("不支持的游戏操作。");
  },
  display(state, viewerId, context): GameDisplay {
    const participating = state.playerIds.includes(viewerId);
    const revealed = state.stage === "reveal";
    const submitted = participating && Object.hasOwn(state.votes, viewerId);
    const own = state.votes[viewerId];
    const display: GameDisplay = {
      title: "谁最可能",
      subtitle: revealed ? "聚光灯揭晓 · 只公布票数，不公布投票人" : "秘密选择一位朋友，也可以选自己",
      prompt: state.questions[state.questionIndex],
      progress: `第 ${state.questionIndex + 1} / ${TOTAL} 题`,
      deadline: state.deadline,
      notice: revealed ? state.leaders.length ? `本轮聚光灯：${state.leaders.map(id => state.names[id]).join("、")}` : "本轮大家都选择跳过，没有聚光灯玩家。" :
        submitted ? own === null ? "你已跳过，等待大家提交。" : `你已选择「${state.names[own!]}」，等待大家提交。` :
        participating ? "投票只用于轻松互动，不想选也可以跳过。" : "你正在观战，本题选择暂不公开。",
      rows: revealed ? state.playerIds.map(id => ({
        label: state.names[id],
        value: state.status === "finished"
          ? `本题 ${state.counts[id]} 票 · 累计 ${state.totalVotes[id]} 票 · 聚光灯 ${state.spotlights[id]} 次`
          : `${state.counts[id]} 票`,
        highlight: state.leaders.includes(id)
      })) : [{ label: "提交进度", value: `${Object.keys(state.votes).length} / ${state.playerIds.length}` }],
      choices: []
    };
    if (state.status === "finished") {
      display.result = "8轮聚光灯已揭晓！看看朋友眼中的你，获票只是趣味记录。";
    } else if (!revealed && participating && !submitted && context.now < state.deadline!) {
      display.choices = [
        ...state.playerIds.map(id => ({ id: "vote", label: `${state.names[id]}${id === viewerId ? "（我）" : ""}`, value: id })),
        { id: "skip", label: "跳过这题" }
      ];
    } else if (revealed && participating && viewerId === context.hostId) {
      display.choices = [{ id: "next", label: "下一题" }];
    }
    return display;
  },
  timeout(state, context) {
    if (state.status !== "playing" || state.deadline === undefined || context.now < state.deadline) return;
    if (state.stage === "vote") reveal(state, context);
    else next(state, context);
  }
});
