import { defineGame, requireTurn, roster, type GameContext, type GameState } from "../core";

export interface SevensState extends GameState {
  number: number;
  turn: number;
  correct: Record<string, number>;
  history: string[];
  loserId?: string;
  reason?: "wrong" | "timeout" | "complete";
}

const TURN_MS = 8_000;
export function mustPass(value: number): boolean {
  return value % 7 === 0 || String(value).includes("7");
}
function current(state: SevensState) { return state.playerIds[state.turn]; }
function log(state: SevensState, text: string) {
  state.history.push(text);
  if (state.history.length > 20) state.history.shift();
}
function finish(state: SevensState, reason: SevensState["reason"]) {
  state.status = "finished";
  state.reason = reason;
  if (reason !== "complete") state.loserId = current(state);
  delete state.deadline;
}
function result(state: SevensState): string {
  if (state.reason === "complete") return "全员通关！大家一口气完成了1～100。";
  if (state.reason === "timeout") return `${state.names[state.loserId!]}没有在8秒内作答，本局失败。`;
  if (state.reason === "wrong") return `${state.names[state.loserId!]}在${state.number}答错了；这里应该${mustPass(state.number) ? "喊“过”" : "正常报数"}。`;
  return "本局已结束。";
}

export const game = defineGame<SevensState>({
  id: "sevens", minPlayers: 3, maxPlayers: 10,
  create(players, context) {
    if (players.length < 3 || players.length > 10 || new Set(players.map(p => p.id)).size !== players.length) {
      throw new Error("逢七过需要3～10位不同玩家。");
    }
    return {
      ...roster(players), status: "playing", number: 1,
      turn: Math.max(0, context.roundNumber - 1) % players.length,
      correct: Object.fromEntries(players.map(p => [p.id, 0])),
      history: [], deadline: context.now + TURN_MS
    };
  },
  act(state, playerId, action, context) {
    requireTurn(state, playerId, current(state));
    if (context.now >= state.deadline!) throw new Error("本回合已经超时，请等待结算。");
    if ((action.type !== "say" && action.type !== "pass") || action.value !== undefined) {
      throw new Error("请选择报数或过。");
    }
    const passed = action.type === "pass";
    log(state, `${state.names[playerId]} · ${state.number}：${passed ? "过" : state.number}`);
    if (passed !== mustPass(state.number)) { finish(state, "wrong"); return; }
    state.correct[playerId]++;
    if (state.number === 100) { finish(state, "complete"); return; }
    state.number++;
    state.turn = (state.turn + 1) % state.playerIds.length;
    state.deadline = context.now + TURN_MS;
  },
  timeout(state, context: GameContext) {
    if (state.status !== "playing" || state.deadline === undefined || context.now < state.deadline) return;
    log(state, `${state.names[current(state)]} · ${state.number}：超时`);
    finish(state, "timeout");
  },
  display(state, viewerId) {
    const active = state.status === "playing";
    return {
      title: active ? "反应跟上，逢七就过。" : "这一轮，数完了。",
      subtitle: "7的倍数，或数字中含7，就选“过”。其他数字选“报数”。",
      progress: `${state.number} / 100`,
      prompt: active ? `轮到${state.names[current(state)]}，当前数字是 ${state.number}。` : result(state),
      cards: [String(state.number)],
      turnId: active ? current(state) : undefined,
      deadline: active ? state.deadline : undefined,
      choices: active && viewerId === current(state)
        ? [{ id: "say", label: "报数" }, { id: "pass", label: "过" }] : [],
      notice: active
        ? viewerId === current(state) ? "8秒内做出选择。" : "看好数字，马上轮到下一位。"
        : "房主可以开启新的一局。",
      result: active ? undefined : result(state),
      rows: state.playerIds.map(id => ({
        label: state.names[id],
        value: `${state.correct[id]}次正确${state.loserId === id ? " · 本局失败" : ""}`,
        highlight: state.reason === "complete"
      })),
      history: [...state.history]
    };
  }
});
