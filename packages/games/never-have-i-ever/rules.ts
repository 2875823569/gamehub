import { defineGame, requirePlayer, roster, shuffle, type GameContext, type GameDisplay, type GameState } from "../core";

type Answer = "yes" | "no" | "skip";
export interface NeverHaveState extends GameState {
  stage: "answer" | "reveal";
  questions: string[];
  questionIndex: number;
  answers: Record<string, Answer>;
  experiences: Record<string, number>;
  skipped: Record<string, number>;
}

export const QUESTION_BANK = [
  "我从来没有在找手机时，发现手机就握在手里。",
  "我从来没有把一首歌循环听了一整天。",
  "我从来没有为了看日出特意早起。",
  "我从来没有把盐和糖认错。",
  "我从来没有在电梯里按错楼层。",
  "我从来没有给一棵植物取名字。",
  "我从来没有把想说的话忘在嘴边。",
  "我从来没有独自去电影院看电影。",
  "我从来没有在陌生城市迷路后发现一家好店。",
  "我从来没有因为一本书而熬夜。",
  "我从来没有学会过一种乐器。",
  "我从来没有为了拍照等过很久的光线。",
  "我从来没有在雨天专门出门散步。",
  "我从来没有做过一份外形奇怪但好吃的饭。",
  "我从来没有在聊天时用错过表情。",
  "我从来没有把歌词记成完全不同的意思。",
  "我从来没有给朋友写过手写信。",
  "我从来没有在家里搭过帐篷。",
  "我从来没有完成过一千片拼图。",
  "我从来没有在旅行时寄过明信片。",
  "我从来没有对着镜子练习过演讲。",
  "我从来没有在醒来后记得一场特别离奇的梦。",
  "我从来没有把周末误以为工作日。",
  "我从来没有在吃饭前拍过食物照片。",
  "我从来没有试着模仿过动画角色的声音。",
  "我从来没有用过纸质地图找路。",
  "我从来没有为一场球赛或比赛欢呼到嗓子哑。",
  "我从来没有参加过志愿服务。",
  "我从来没有收藏过电影票或车票。",
  "我从来没有做过属于自己的表情包。",
  "我从来没有在下雪时堆过雪人。",
  "我从来没有看到过清楚的流星。",
  "我从来没有为了一个游戏研究过攻略。",
  "我从来没有发现自己和朋友穿了同款衣服。",
  "我从来没有在超市忘记自己要买什么。",
  "我从来没有学做过一道家乡菜。",
  "我从来没有把礼物藏得连自己都找不到。",
  "我从来没有在公园野餐过。",
  "我从来没有坐过夜间长途火车。",
  "我从来没有在歌的前奏响起时就猜对歌名。"
] as const;

const ANSWER_MS = 45_000;
const REVEAL_MS = 10_000;
const TOTAL = 8;
const labels: Record<Answer, string> = { yes: "做过", no: "没做过", skip: "跳过" };

function reveal(state: NeverHaveState, context: GameContext) {
  for (const id of state.playerIds) {
    const answer = state.answers[id] ?? "skip";
    state.answers[id] = answer;
    if (answer === "yes") state.experiences[id]++;
    if (answer === "skip") state.skipped[id]++;
  }
  state.stage = "reveal";
  if (state.questionIndex === TOTAL - 1) {
    state.status = "finished";
    delete state.deadline;
  } else {
    state.deadline = context.now + REVEAL_MS;
  }
}

function next(state: NeverHaveState, context: GameContext) {
  state.questionIndex++;
  state.answers = {};
  state.stage = "answer";
  state.deadline = context.now + ANSWER_MS;
}

export const game = defineGame<NeverHaveState>({
  id: "never-have-i-ever",
  minPlayers: 3,
  maxPlayers: 10,
  create(players, context) {
    if (players.length < 3 || players.length > 10) throw new Error("我从来没有需要3～10人。");
    return {
      ...roster(players),
      status: "playing",
      stage: "answer",
      questions: shuffle(QUESTION_BANK, context.randomInt).slice(0, TOTAL),
      questionIndex: 0,
      answers: {},
      experiences: Object.fromEntries(players.map(p => [p.id, 0])),
      skipped: Object.fromEntries(players.map(p => [p.id, 0])),
      deadline: context.now + ANSWER_MS
    };
  },
  act(state, playerId, action, context) {
    requirePlayer(state, playerId);
    if (action.type === "answer") {
      if (state.stage !== "answer") throw new Error("本题已揭晓，请等待下一题。");
      if (context.now >= state.deadline!) throw new Error("本题回答时间已到。");
      if (state.answers[playerId] !== undefined) throw new Error("你已经提交过本题答案。");
      if (action.value !== "yes" && action.value !== "no" && action.value !== "skip") throw new Error("请选择做过、没做过或跳过。");
      state.answers[playerId] = action.value;
      if (state.playerIds.every(id => state.answers[id] !== undefined)) reveal(state, context);
      return;
    }
    if (action.type === "next") {
      if (playerId !== context.hostId) throw new Error("只有房主可以提前进入下一题。");
      if (state.stage !== "reveal") throw new Error("请等待全员回答或倒计时结束。");
      next(state, context);
      return;
    }
    throw new Error("不支持的游戏操作。");
  },
  display(state, viewerId, context): GameDisplay {
    const participating = state.playerIds.includes(viewerId);
    const answered = state.answers[viewerId];
    const revealed = state.stage === "reveal";
    const display: GameDisplay = {
      title: "我从来没有",
      subtitle: revealed ? "答案揭晓 · 聊聊你们的故事" : "独立选择，全员提交后一起揭晓",
      prompt: state.questions[state.questionIndex],
      progress: `第 ${state.questionIndex + 1} / ${TOTAL} 题`,
      deadline: state.deadline,
      notice: !participating ? "你正在观战，下一局可加入。" : revealed ? "经历不分高低，愿意分享就说，不想分享可以跳过。" :
        answered ? `你已选择「${labels[answered]}」，正在等待大家。` : "做过这件事选「做过」，不想回答可以跳过。",
      rows: state.playerIds.map(id => ({
        label: state.names[id],
        value: revealed
          ? `${labels[state.answers[id]]} · 经历 ${state.experiences[id]} · 跳过 ${state.skipped[id]}`
          : id === viewerId && answered
            ? labels[answered]
            : state.answers[id] !== undefined ? "已提交" : "等待回答",
        highlight: id === viewerId
      })),
      choices: []
    };
    if (state.status === "finished") {
      display.result = "8轮故事已收集完成！经历数仅作趣味记录，感谢每个人的分享。";
    } else if (!revealed && participating && !answered && context.now < state.deadline!) {
      display.choices = [
        { id: "answer", label: "做过", value: "yes" },
        { id: "answer", label: "没做过", value: "no" },
        { id: "answer", label: "跳过这题", value: "skip" }
      ];
    } else if (revealed && participating && viewerId === context.hostId) {
      display.choices = [{ id: "next", label: "下一题" }];
    }
    return display;
  },
  timeout(state, context) {
    if (state.status !== "playing" || state.deadline === undefined || context.now < state.deadline) return;
    if (state.stage === "answer") reveal(state, context);
    else next(state, context);
  }
});
