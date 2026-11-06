export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const DICE_PER_PLAYER = 5;
export const RECONNECT_MS = 60_000;

export interface Bid {
  playerId: string;
  count: number;
  face: number;
}

export interface Outcome {
  loserId: string;
  reason: "challenge" | "disconnect" | "leave";
  challengerId?: string;
  actualCount?: number;
  bid?: Bid;
}

export interface Round {
  number: number;
  playerIds: string[];
  names: Record<string, string>;
  dice: Record<string, number[]>;
  turnIndex: number;
  bids: Bid[];
  outcome?: Outcome;
}

export function validBid(count: number, face: number, previous: Bid | undefined, totalDice: number): boolean {
  return Number.isInteger(count) && count >= 1 && count <= totalDice &&
    Number.isInteger(face) && face >= 2 && face <= 6 &&
    (!previous || count > previous.count || (count === previous.count && face > previous.face));
}

export function createRound(
  players: { id: string; name: string }[],
  number: number,
  randomInt: (max: number) => number
): Round {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) throw new Error("需要 2～6 位玩家才能开始。");
  return {
    number,
    playerIds: players.map(p => p.id),
    names: Object.fromEntries(players.map(p => [p.id, p.name])),
    dice: Object.fromEntries(players.map(p => [p.id, Array.from({ length: DICE_PER_PLAYER }, () => randomInt(6) + 1)])),
    turnIndex: randomInt(players.length),
    bids: []
  };
}

export function placeBid(round: Round, playerId: string, count: number, face: number): void {
  assertTurn(round, playerId);
  if (!validBid(count, face, round.bids.at(-1), round.playerIds.length * DICE_PER_PLAYER)) {
    throw new Error("叫点必须加码：增加数量，或保持数量并增加点数。");
  }
  round.bids.push({ playerId, count, face });
  round.turnIndex = (round.turnIndex + 1) % round.playerIds.length;
}

export function challenge(round: Round, playerId: string): Outcome {
  assertTurn(round, playerId);
  const bid = round.bids.at(-1);
  if (!bid) throw new Error("还没有人叫点，请先叫点。");
  const actualCount = Object.values(round.dice).flat().filter(die => die === 1 || die === bid.face).length;
  const outcome: Outcome = {
    loserId: actualCount >= bid.count ? playerId : bid.playerId,
    challengerId: playerId,
    reason: "challenge",
    actualCount,
    bid
  };
  round.outcome = outcome;
  return outcome;
}

function assertTurn(round: Round, playerId: string): void {
  if (round.outcome) throw new Error("本局已经结束。");
  if (round.playerIds[round.turnIndex] !== playerId) throw new Error("还没轮到你。");
}

export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % max;
}
