export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const DICE_PER_PLAYER = 5;
export const RECONNECT_MS = 60_000;
export const FACE_ORDER = [2, 3, 4, 5, 6, 1];
export type BidMode = "normal" | "zhai" | "fly";

export interface Bid {
  playerId: string;
  count: number;
  face: number;
  mode?: BidMode;
}

export interface PendingSlash { challengerId: string; bidderId: string }

export interface Outcome {
  loserId: string;
  reason: "challenge" | "disconnect" | "leave";
  challengerId?: string;
  actualCount?: number;
  bid?: Bid;
  multiplier?: 1 | 2 | 4;
}

export interface Round {
  number: number;
  playerIds: string[];
  names: Record<string, string>;
  dice: Record<string, number[]>;
  turnIndex: number;
  bids: Bid[];
  outcome?: Outcome;
  pendingSlash?: PendingSlash;
}

export function isZhai(bid: Bid): boolean {
  return bid.face === 1 || bid.mode === "zhai";
}

export function effectiveMode(face: number, previous?: Bid, mode?: BidMode): BidMode {
  if (mode === "fly") return "fly";
  if (face === 1) return "zhai";
  return mode ?? (previous && isZhai(previous) ? "zhai" : "normal");
}

export function validBid(count: number, face: number, previous: Bid | undefined, playerCount: number, mode?: BidMode): boolean {
  if (mode !== undefined && !["normal", "zhai", "fly"].includes(mode)) return false;
  if (!Number.isInteger(count) || count < 1 || count > playerCount * 7 ||
      !Number.isInteger(face) || face < 1 || face > 6) return false;
  const nextMode = effectiveMode(face, previous, mode);
  if (nextMode === "fly") return !!previous && isZhai(previous) && face !== 1 && count >= previous.count * 2;
  if (!previous) return count >= playerCount;
  if (isZhai(previous) && nextMode !== "zhai") return false;
  if (!isZhai(previous) && nextMode === "zhai") return count >= Math.ceil(previous.count / 2);
  return count > previous.count || (count === previous.count && FACE_ORDER.indexOf(face) > FACE_ORDER.indexOf(previous.face));
}

export function minimumBid(face: number, previous: Bid | undefined, playerCount: number, mode?: BidMode): number | undefined {
  for (let count = 1; count <= playerCount * 7; count++) {
    if (validBid(count, face, previous, playerCount, mode)) return count;
  }
}

export function isStraight(hand: number[]): boolean {
  return hand.length === DICE_PER_PLAYER && new Set(hand).size === DICE_PER_PLAYER;
}

// Evaluate one complete hand; flattening hands loses straight and surround rules.
export function handCount(hand: number[], bid: Bid): number {
  if (isStraight(hand)) return 0;
  const wild = !isZhai(bid);
  if (hand.length === 5 && hand.every(v => v === hand[0])) {
    return hand[0] === bid.face || (wild && hand[0] === 1) ? 7 : 0;
  }
  if (hand.length === 5 && wild && hand.every(v => v === bid.face || v === 1)) return 6;
  return hand.filter(v => v === bid.face || (wild && v === 1)).length;
}

export function handLabel(hand: number[], bid?: Bid): string {
  if (isStraight(hand)) return "顺子 · 整手计 0";
  if (hand.length === 5 && new Set(hand).size === 1) return "全围 · 匹配时计 7";
  if (hand.length === 5 && hand.includes(1) && new Set(hand.filter(v => v !== 1)).size === 1) {
    return bid && isZhai(bid) ? "围骰 · 斋按实际点数" : "围骰 · 万能模式计 6";
  }
  return "普通手牌";
}

export function bidLabel(bid: Bid): string {
  return `${bid.count} 个 ${bid.face}${isZhai(bid) ? " 斋" : bid.mode === "fly" ? " 飞" : ""}`;
}

export function nextStarter(players: { id: string }[], previous?: Round): string | undefined {
  const loser = previous?.outcome?.loserId;
  if (!loser || !previous) return;
  const start = previous.playerIds.indexOf(loser);
  for (let offset = 0; offset < previous.playerIds.length; offset++) {
    const id = previous.playerIds[(Math.max(0, start) + offset) % previous.playerIds.length];
    if (players.some(p => p.id === id)) return id;
  }
  return players[0]?.id;
}

export function createRound(
  players: { id: string; name: string }[],
  number: number,
  randomInt: (max: number) => number,
  previous?: Round
): Round {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) throw new Error("需要 2～6 位玩家才能开始。");
  const starter = nextStarter(players, previous);
  return {
    number,
    playerIds: players.map(p => p.id),
    names: Object.fromEntries(players.map(p => [p.id, p.name])),
    dice: Object.fromEntries(players.map(p => [p.id, Array.from({ length: DICE_PER_PLAYER }, () => randomInt(6) + 1)])),
    turnIndex: starter ? players.findIndex(p => p.id === starter) : randomInt(players.length),
    bids: []
  };
}

export function placeBid(round: Round, playerId: string, count: number, face: number, mode?: BidMode): void {
  assertTurn(round, playerId);
  const previous = round.bids.at(-1);
  if (!validBid(count, face, previous, round.playerIds.length, mode)) {
    throw new Error("叫点不符合加码规则：首叫至少人数；斋最低减半向上取整；飞至少翻倍且不能叫 1。");
  }
  round.bids.push({ playerId, count, face, mode: effectiveMode(face, previous, mode) });
  round.turnIndex = (round.turnIndex + 1) % round.playerIds.length;
}

export function challenge(round: Round, playerId: string): Outcome {
  assertTurn(round, playerId);
  return settle(round, playerId, 1);
}

export function slash(round: Round, playerId: string): void {
  assertActive(round, playerId);
  const bid = round.bids.at(-1);
  if (!bid) throw new Error("还没有人叫点，请先叫点。");
  if (bid.playerId === playerId) throw new Error("不能劈自己的叫点。");
  round.pendingSlash = { challengerId: playerId, bidderId: bid.playerId };
}

export function respondSlash(round: Round, playerId: string, counter: boolean): Outcome {
  if (round.outcome) throw new Error("本局已经结束。");
  if (!round.pendingSlash || round.pendingSlash.bidderId !== playerId) throw new Error("只有被劈的叫点者可以回应。");
  if (typeof counter !== "boolean") throw new Error("回应格式不正确。");
  const outcome = settle(round, round.pendingSlash.challengerId, counter ? 4 : 2);
  delete round.pendingSlash;
  return outcome;
}

function settle(round: Round, playerId: string, multiplier: 1 | 2 | 4): Outcome {
  const bid = round.bids.at(-1);
  if (!bid) throw new Error("还没有人叫点，请先叫点。");
  const actualCount = Object.values(round.dice).reduce((sum, hand) => sum + handCount(hand, bid), 0);
  const outcome: Outcome = {
    loserId: actualCount >= bid.count ? playerId : bid.playerId,
    challengerId: playerId,
    reason: "challenge",
    actualCount,
    bid,
    multiplier
  };
  round.outcome = outcome;
  return outcome;
}

function assertTurn(round: Round, playerId: string): void {
  assertActive(round, playerId);
  if (round.playerIds[round.turnIndex] !== playerId) throw new Error("还没轮到你。");
}

function assertActive(round: Round, playerId: string): void {
  if (round.outcome) throw new Error("本局已经结束。");
  if (!round.playerIds.includes(playerId)) throw new Error("旁观玩家不能参与本局。");
  if (round.pendingSlash) throw new Error("正在等待被劈的玩家回应。");
}

export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % max;
}
