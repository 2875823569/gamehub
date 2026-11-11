/** The authority (room server or P2P host) owns state; guests only receive display(). */
export interface GamePlayer { id: string; name: string }
export interface GameContext {
  now: number;
  randomInt: (maxExclusive: number) => number;
  hostId: string;
  roundNumber: number;
}
export interface GameState {
  playerIds: string[];
  names: Record<string, string>;
  status: "playing" | "finished";
  deadline?: number;
}
export interface GameAction { type: string; value?: unknown }
export interface GameChoice {
  id: string;
  label: string;
  value?: string | number | boolean;
  disabled?: boolean;
}
export interface GameDisplay {
  title: string;
  prompt: string;
  subtitle?: string;
  notice?: string;
  turnId?: string;
  progress?: string;
  cards?: string[];
  rows?: { label: string; value: string; highlight?: boolean }[];
  choices?: GameChoice[];
  input?: {
    id: string;
    label: string;
    type: "number" | "text";
    min?: number;
    max?: number;
    maxLength?: number;
    placeholder?: string;
  };
  history?: string[];
  deadline?: number;
  result?: string;
}
export interface GameMeta {
  id: string;
  title: string;
  subtitle: string;
  category: "行酒令" | "其他";
  minPlayers: number;
  maxPlayers: number;
  duration: string;
  icon: string;
  rules: string[];
}
export interface TypedGameDefinition<S extends GameState> {
  id: string;
  minPlayers: number;
  maxPlayers: number;
  create(players: GamePlayer[], context: GameContext): S;
  act(state: S, playerId: string, action: GameAction, context: GameContext): void;
  display(state: S, viewerId: string, context: GameContext): GameDisplay;
  timeout?(state: S, context: GameContext): void;
}
export type GameDefinition = TypedGameDefinition<GameState>;
/** Keeps each game internally typed, erasing only at the registry boundary. */
export function defineGame<S extends GameState>(game: TypedGameDefinition<S>): GameDefinition {
  return game as unknown as GameDefinition;
}
export function roster(players: GamePlayer[]): Pick<GameState, "playerIds" | "names"> {
  return { playerIds: players.map(p => p.id), names: Object.fromEntries(players.map(p => [p.id, p.name])) };
}
export function requirePlayer(state: GameState, playerId: string) {
  if (state.status !== "playing") throw new Error("本局已经结束。");
  if (!state.playerIds.includes(playerId)) throw new Error("你正在观战，请等待下一局。");
}
export function requireTurn(state: GameState, playerId: string, turnId: string) {
  requirePlayer(state, playerId);
  if (playerId !== turnId) throw new Error("还没有轮到你。");
}
export function shuffle<T>(items: readonly T[], randomInt: GameContext["randomInt"]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
