import { defineGame, requireTurn, roster, type GameState } from "../core";

export interface ThirtyOneState extends GameState {
  lastNumber: number;
  turn: number;
  counts: { playerId: string; numbers: number[] }[];
  loserId?: string;
  reason?: "thirty-one" | "timeout";
}

const TURN_MS = 30_000;
const current = (state: ThirtyOneState) => state.playerIds[state.turn];

function finish(state: ThirtyOneState, reason: "thirty-one" | "timeout") {
  state.loserId = current(state);
  state.reason = reason;
  state.status = "finished";
  delete state.deadline;
}

export const game = defineGame<ThirtyOneState>({
  id: "thirty-one",
  minPlayers: 2,
  maxPlayers: 10,
  create(players, context) {
    if (players.length < 2 || players.length > 10 || new Set(players.map(p => p.id)).size !== players.length) {
      throw new Error("别数到31需要2～10位不同玩家。");
    }
    return {
      ...roster(players),
      status: "playing",
      lastNumber: 0,
      turn: Math.max(0, context.roundNumber - 1) % players.length,
      counts: [],
      deadline: context.now + TURN_MS
    };
  },
  act(state, playerId, action, context) {
    requireTurn(state, playerId, current(state));
    if (context.now >= state.deadline!) throw new Error("本回合时间已到，请等待结算。");
    if (action.type !== "count") throw new Error("请选择本次报几个数。");
    const count = action.value;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 3) {
      throw new Error("每次只能连续报1、2或3个数字。");
    }
    if (state.lastNumber + count > 31) throw new Error("不能越过31，请减少报数数量。");
    const numbers = Array.from({ length: count }, (_, i) => state.lastNumber + i + 1);
    state.counts.push({ playerId, numbers });
    state.lastNumber += count;
    if (state.lastNumber === 31) {
      finish(state, "thirty-one");
      return;
    }
    state.turn = (state.turn + 1) % state.playerIds.length;
    state.deadline = context.now + TURN_MS;
  },
  timeout(state, context) {
    if (state.status === "playing" && state.deadline !== undefined && context.now >= state.deadline) finish(state, "timeout");
  },
  display(state, viewerId) {
    const active = state.status === "playing";
    const turnId = current(state);
    const canCount = active && viewerId === turnId && state.playerIds.includes(viewerId);
    const last = state.counts.at(-1);
    const loser = state.names[state.loserId ?? turnId];
    return {
      title: active ? "步步为营，别碰到31。" : "本局报数结束",
      subtitle: "一次接报1～3个数字，下一步留给朋友。",
      prompt: active
        ? `${state.names[turnId]}，从 ${state.lastNumber + 1} 开始，你要连续报几个数字？`
        : state.reason === "timeout" ? `${loser}超过30秒没有报数，本局超时失败。` : `${loser}报到了31，本局失败。`,
      turnId,
      progress: `已报到 ${state.lastNumber} / 31`,
      cards: [active ? String(state.lastNumber + 1) : state.reason === "thirty-one" ? "31" : "超时"],
      notice: last
        ? `刚才${state.names[last.playerId]}报了：${last.numbers.join("、")}。${active && state.lastNumber === 30 ? "只剩31，必须报1个。" : ""}`
        : "还没有人报数。每回合30秒，报到31的人输。",
      choices: canCount ? [1, 2, 3].map(count => ({
        id: "count",
        value: count,
        label: `报${count}个${state.lastNumber + count <= 31 ? `：${Array.from({ length: count }, (_, i) => state.lastNumber + i + 1).join("、")}` : "（超出31）"}`,
        disabled: state.lastNumber + count > 31
      })) : [],
      deadline: active ? state.deadline : undefined,
      result: active ? undefined : `${loser}${state.reason === "timeout" ? "超时" : "报到31"}，本局失败。其他玩家获胜。`,
      history: state.counts.map((entry, index) => `${index + 1}. ${state.names[entry.playerId]}：${entry.numbers.join("、")}`)
    };
  }
});
