import { defineGame, requireTurn, roster, type GameContext, type GameState } from "../core";

export interface NumberBombState extends GameState {
  secret: number;
  lower: number;
  upper: number;
  turn: number;
  guesses: { playerId: string; value: number; lower: number; upper: number }[];
  loserId?: string;
  reason?: "bomb" | "timeout";
}

const TURN_MS = 30_000;
const current = (state: NumberBombState) => state.playerIds[state.turn];

function finish(state: NumberBombState, reason: "bomb" | "timeout") {
  state.loserId = current(state);
  state.reason = reason;
  state.status = "finished";
  delete state.deadline;
}

export const game = defineGame<NumberBombState>({
  id: "number-bomb",
  minPlayers: 2,
  maxPlayers: 10,
  create(players, context) {
    if (players.length < 2 || players.length > 10 || new Set(players.map(p => p.id)).size !== players.length) {
      throw new Error("数字炸弹需要2～10位不同玩家。");
    }
    return {
      ...roster(players),
      status: "playing",
      secret: context.randomInt(100) + 1,
      lower: 1,
      upper: 100,
      turn: Math.max(0, context.roundNumber - 1) % players.length,
      guesses: [],
      deadline: context.now + TURN_MS
    };
  },
  act(state, playerId, action, context) {
    requireTurn(state, playerId, current(state));
    if (context.now >= state.deadline!) throw new Error("本回合时间已到，请等待结算。");
    if (action.type !== "guess") throw new Error("请选择一个数字。");
    const value = action.value;
    if (typeof value !== "number" || !Number.isInteger(value) || value < state.lower || value > state.upper) {
      throw new Error(`请输入${state.lower}～${state.upper}之间的整数。`);
    }
    if (value === state.secret) {
      state.guesses.push({ playerId, value, lower: state.lower, upper: state.upper });
      finish(state, "bomb");
      return;
    }
    if (value < state.secret) state.lower = value + 1;
    else state.upper = value - 1;
    state.guesses.push({ playerId, value, lower: state.lower, upper: state.upper });
    state.turn = (state.turn + 1) % state.playerIds.length;
    state.deadline = context.now + TURN_MS;
  },
  timeout(state, context) {
    if (state.status === "playing" && state.deadline !== undefined && context.now >= state.deadline) finish(state, "timeout");
  },
  display(state, viewerId, _context: GameContext) {
    const active = state.status === "playing";
    const turnId = current(state);
    const canGuess = active && viewerId === turnId && state.playerIds.includes(viewerId);
    const reason = state.reason === "timeout" ? "超过30秒未提交，超时失败" : "踩中了数字炸弹";
    return {
      title: active ? "小心，炸弹就在其中。" : "炸弹揭晓",
      subtitle: "缩小范围，避开那个数字。",
      prompt: active
        ? `${state.names[turnId]}，请选择 ${state.lower}～${state.upper} 之间的整数。`
        : `${state.names[state.loserId ?? turnId]}${reason}。`,
      turnId,
      progress: `已猜 ${state.guesses.length} 次`,
      cards: active ? [`${state.lower} ～ ${state.upper}`] : [`💣 ${state.secret}`],
      notice: active
        ? state.lower === state.upper ? "范围只剩一个数字，它也是唯一合法选择。" : "两端都可以选。每次安全猜数都会缩小范围。"
        : "本局结束，房主可以再开一局。",
      input: canGuess ? {
        id: "guess",
        label: "你要猜的数字",
        type: "number",
        min: state.lower,
        max: state.upper,
        placeholder: `${state.lower}～${state.upper}`
      } : undefined,
      choices: [],
      deadline: active ? state.deadline : undefined,
      result: active ? undefined : `${state.names[state.loserId ?? turnId]}本局失败；炸弹是 ${state.secret}。其他玩家成功避开。`,
      history: state.guesses.map((guess, index) =>
        `${index + 1}. ${state.names[guess.playerId]}猜了${guess.value}${!active && state.reason === "bomb" && index === state.guesses.length - 1 ? "，踩中炸弹" : `，范围变为${guess.lower}～${guess.upper}`}`
      )
    };
  }
});
