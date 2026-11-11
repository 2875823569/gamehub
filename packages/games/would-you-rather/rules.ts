import { defineGame, requirePlayer, roster, shuffle, type GameContext, type GameDisplay, type GameState } from "../core";

type Vote = "A" | "B" | "skip";
interface Question { a: string; b: string }
export interface WouldRatherState extends GameState {
  stage: "vote" | "reveal";
  questions: Question[];
  questionIndex: number;
  votes: Record<string, Vote>;
  scores: Record<string, number>;
  earned: Record<string, number>;
}

export const QUESTION_BANK: readonly Question[] = [
  { a: "每次旅行都去海边", b: "每次旅行都去山里" },
  { a: "能和家里的植物聊天", b: "能听懂路边动物的想法" },
  { a: "永远不需要排队", b: "永远不需要找停车位" },
  { a: "有一间装满书的阁楼", b: "有一间可以看星星的阳光房" },
  { a: "每周收到一束陌生花", b: "每周收到一份神秘甜点" },
  { a: "旅行只带一个小背包", b: "旅行带齐所有可能用上的东西" },
  { a: "住在每天都有日出的海边", b: "住在每天都有晚霞的山坡" },
  { a: "一听前奏就知道歌名", b: "看一眼就能认出所有植物" },
  { a: "所有衣服都只有黑白灰", b: "每天必须穿一种亮色" },
  { a: "做一场热闹聚会的主持人", b: "做一顿朋友都爱吃的大餐" },
  { a: "在云层上建一个花园", b: "在海底开一间咖啡馆" },
  { a: "每天早起两小时自由安排", b: "每天晚上多两小时自由安排" },
  { a: "所有快递都当天到", b: "所有外卖都免配送费" },
  { a: "只能拍照片记录旅行", b: "只能写文字记录旅行" },
  { a: "在火车上度过一个悠闲周末", b: "在船上度过一个悠闲周末" },
  { a: "随时能做出完美的煎蛋", b: "随时能泡出完美的咖啡" },
  { a: "有会自动整理的衣柜", b: "有会自动清洗的厨房" },
  { a: "电影永远猜不到结尾", b: "电影开场就知道所有伏笔" },
  { a: "一年只去一家最喜欢的餐厅", b: "一年每次都尝试新餐厅" },
  { a: "和朋友一起通关合作游戏", b: "和朋友一起完成巨幅拼图" },
  { a: "拥有一张无限次博物馆门票", b: "拥有一张无限次音乐会门票" },
  { a: "下雨时会响起专属背景音乐", b: "晴天时身边会飘出淡淡花香" },
  { a: "每件东西都有固定位置", b: "随处摆放但总能立刻找到" },
  { a: "收到一本朋友写的旅行手册", b: "收到一张朋友录制的歌单" },
  { a: "成为一家小书店的店主", b: "成为一家小面包店的店主" },
  { a: "能记住每一次美梦", b: "能随时重看一段开心回忆" },
  { a: "所有家务自动完成", b: "每天通勤只需要一分钟" },
  { a: "在大城市拥有安静的小院", b: "在小镇拥有热闹的大客厅" },
  { a: "每次出门都遇到好天气", b: "每次拍照都遇到好光线" },
  { a: "听懂所有方言", b: "一学就会所有舞步" },
  { a: "一整天不用看时间", b: "一整天不用看手机" },
  { a: "成为朋友们的旅行规划师", b: "成为朋友们的聚餐推荐官" },
  { a: "生日收到惊喜派对", b: "生日拥有完全自由的一天" },
  { a: "每本书都附赠作者讲解", b: "每部电影都附赠幕后探班" },
  { a: "随身有一张舒服的躺椅", b: "随身有一盏温暖的阅读灯" },
  { a: "吃火锅只配冰饮", b: "吃火锅只配热茶" }
];

const TOTAL = 8;
const VOTE_MS = 45_000;
const REVEAL_MS = 10_000;
const labels: Record<Vote, string> = { A: "A 阵营", B: "B 阵营", skip: "跳过" };

function tally(state: WouldRatherState) {
  return state.playerIds.reduce((count, id) => {
    if (state.votes[id] === "A") count.A++;
    if (state.votes[id] === "B") count.B++;
    return count;
  }, { A: 0, B: 0 });
}

function reveal(state: WouldRatherState, context: GameContext) {
  for (const id of state.playerIds) state.votes[id] ??= "skip";
  const counts = tally(state);
  const winner = counts.A === counts.B ? undefined : counts.A > counts.B ? "A" : "B";
  for (const id of state.playerIds) {
    state.earned[id] = winner !== undefined && state.votes[id] === winner ? 1 : 0;
    state.scores[id] += state.earned[id];
  }
  state.stage = "reveal";
  if (state.questionIndex === TOTAL - 1) {
    state.status = "finished";
    delete state.deadline;
  } else state.deadline = context.now + REVEAL_MS;
}

function next(state: WouldRatherState, context: GameContext) {
  state.questionIndex++;
  state.votes = {};
  state.earned = {};
  state.stage = "vote";
  state.deadline = context.now + VOTE_MS;
}

export const game = defineGame<WouldRatherState>({
  id: "would-you-rather",
  minPlayers: 3,
  maxPlayers: 10,
  create(players, context) {
    if (players.length < 3 || players.length > 10) throw new Error("你宁愿选哪个需要3～10人。");
    return {
      ...roster(players), status: "playing", stage: "vote",
      questions: shuffle(QUESTION_BANK, context.randomInt).slice(0, TOTAL),
      questionIndex: 0, votes: {}, earned: {},
      scores: Object.fromEntries(players.map(player => [player.id, 0])),
      deadline: context.now + VOTE_MS
    };
  },
  act(state, playerId, action, context) {
    requirePlayer(state, playerId);
    if (state.deadline !== undefined && context.now >= state.deadline) throw new Error("本轮时间已到，请等待最新画面。");
    if (action.type === "vote") {
      if (state.stage !== "vote") throw new Error("本题已揭晓，请等待下一题。");
      if (state.votes[playerId] !== undefined) throw new Error("你已经提交过本题选择。");
      if (action.value !== "A" && action.value !== "B" && action.value !== "skip") throw new Error("请选择A、B或跳过。");
      state.votes[playerId] = action.value;
      if (state.playerIds.every(id => state.votes[id] !== undefined)) reveal(state, context);
      return;
    }
    if (action.type === "next") {
      if (playerId !== context.hostId) throw new Error("只有房主可以提前进入下一题。");
      if (state.stage !== "reveal") throw new Error("需要等待本题揭晓。");
      next(state, context);
      return;
    }
    throw new Error("不支持的游戏操作。");
  },
  display(state, viewerId, context): GameDisplay {
    const revealed = state.stage === "reveal";
    const participating = state.playerIds.includes(viewerId);
    const ownVote = state.votes[viewerId];
    const question = state.questions[state.questionIndex];
    const display: GameDisplay = {
      title: "你宁愿选哪个",
      subtitle: revealed ? "选择已揭晓 · 原来你们是这样想的" : "凭直觉选一边，全员提交后一起揭晓",
      prompt: `A · ${question.a}\n还是\nB · ${question.b}？`,
      progress: `第 ${state.questionIndex + 1} / ${TOTAL} 题`,
      deadline: state.deadline,
      rows: state.playerIds.map(id => ({
        label: state.names[id],
        value: revealed ? `${labels[state.votes[id]]} · 本轮 +${state.earned[id]} · 总分 ${state.scores[id]}` :
          id === viewerId && ownVote ? `你选了${labels[ownVote]}` : "答案未揭晓",
        highlight: revealed ? state.earned[id] > 0 : id === viewerId
      })),
      notice: !participating ? "你正在观战，下一局可加入。" : !revealed ?
        ownVote ? "选择已锁定，等待大家一起揭晓。" : "选择没有标准答案，也可以跳过这题。" : "",
      choices: []
    };
    if (revealed) {
      const counts = tally(state);
      const total = counts.A + counts.B;
      display.notice = total === 0 ? "大家都跳过了，本轮无人得分。" :
        counts.A === counts.B ? `A ${counts.A} 人 · B ${counts.B} 人，平票，本轮无人得分。` :
        `A ${counts.A} 人 · B ${counts.B} 人，${counts.A > counts.B ? "A" : "B"}阵营每人 +1 分。`;
    }
    if (state.status === "finished") {
      const best = Math.max(...state.playerIds.map(id => state.scores[id]));
      const winners = state.playerIds.filter(id => state.scores[id] === best).map(id => state.names[id]);
      display.result = best === 0 ? "8轮结束，本局暂无积分赢家。不同选择也很精彩！" :
        `8轮结束！${winners.join("、")}以 ${best} 分${winners.length > 1 ? "并列获胜" : "获胜"}。`;
    } else if (!revealed && participating && !ownVote && context.now < state.deadline!) {
      display.choices = [
        { id: "vote", label: `A · ${question.a}`, value: "A" },
        { id: "vote", label: `B · ${question.b}`, value: "B" },
        { id: "vote", label: "跳过这题", value: "skip" }
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
