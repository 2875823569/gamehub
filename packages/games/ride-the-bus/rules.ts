import {
  defineGame, requirePlayer, requireTurn, roster, shuffle,
  type GameAction, type GameChoice, type GameContext, type GameDisplay, type GamePlayer, type GameState
} from "../core";

type Suit = "hearts" | "diamonds" | "spades" | "clubs";
export interface Card { rank: number; suit: Suit }
export interface RideBusState extends GameState {
  stage: "deal" | "pyramid" | "bus";
  deck: Card[];
  hands: Record<string, Card[]>;
  scores: Record<string, number>;
  dealStep: number;
  turnIndex: number;
  pyramid: Card[];
  pyramidIndex: number;
  responses: Record<string, boolean>;
  busRider?: string;
  busCards: Card[];
  busCorrect: number;
  history: string[];
}

const suits: Suit[] = ["hearts", "diamonds", "spades", "clubs"];
const suitLabels: Record<Suit, string> = { hearts: "♥ 红桃", diamonds: "♦ 方块", spades: "♠ 黑桃", clubs: "♣ 梅花" };
const stepLabels = ["猜红黑", "猜高低", "猜区间内外", "猜花色"];
const TURN_MS = 30_000;
const PYRAMID_MS = 25_000;

function newDeck(context: GameContext): Card[] {
  return shuffle(suits.flatMap(suit => Array.from({ length: 13 }, (_, i) => ({ rank: i + 2, suit }))), context.randomInt);
}

export function cardLabel(card: Card): string {
  const rank = card.rank === 14 ? "A" : card.rank === 13 ? "K" : card.rank === 12 ? "Q" : card.rank === 11 ? "J" : String(card.rank);
  return `${suitLabels[card.suit]} ${rank}`;
}

function options(step: number): GameChoice[] {
  const choices: [string, string][] = step === 0 ? [["red", "红色 ♥ ♦"], ["black", "黑色 ♠ ♣"]]
    : step === 1 ? [["higher", "更高"], ["lower", "更低"]]
    : step === 2 ? [["inside", "区间内"], ["outside", "区间外"]]
    : suits.map(suit => [suit, suitLabels[suit]]);
  return choices.map(([value, label]) => ({ id: "guess", value, label }));
}

export function guessMatches(step: number, answer: string, card: Card, previous: Card[]): boolean {
  if (step === 0) return answer === (card.suit === "hearts" || card.suit === "diamonds" ? "red" : "black");
  if (step === 1) return answer === "higher" ? card.rank > previous[0].rank : answer === "lower" && card.rank < previous[0].rank;
  if (step === 2) {
    const low = Math.min(previous[0].rank, previous[1].rank);
    const high = Math.max(previous[0].rank, previous[1].rank);
    return answer === "inside" ? card.rank > low && card.rank < high : answer === "outside" && (card.rank < low || card.rank > high);
  }
  return answer === card.suit;
}

function log(state: RideBusState, message: string) {
  state.history.push(message);
  state.history = state.history.slice(-24);
}

function draw(state: RideBusState): Card {
  const card = state.deck.pop();
  if (!card) throw new Error("牌堆为空，请重新开局。");
  return card;
}

function pyramidLevel(index: number): number {
  return index < 5 ? 1 : index < 9 ? 2 : index < 12 ? 3 : index < 14 ? 4 : 5;
}

function playDeal(state: RideBusState, answer: string | undefined, context: GameContext) {
  const id = state.playerIds[state.turnIndex];
  const card = draw(state);
  const correct = answer !== undefined && guessMatches(state.dealStep, answer, card, state.hands[id]);
  state.hands[id].push(card);
  if (correct) state.scores[id]++;
  log(state, `${state.names[id]}${answer === undefined ? "超时，自动领牌" : `${stepLabels[state.dealStep]}${correct ? "成功，+1分" : "未猜中"}`}。`);
  state.turnIndex++;
  if (state.turnIndex === state.playerIds.length) {
    state.turnIndex = 0;
    state.dealStep++;
  }
  if (state.dealStep === 4) {
    state.stage = "pyramid";
    state.pyramid = newDeck(context).slice(0, 15);
    state.deck = [];
    state.pyramidIndex = 0;
    state.responses = {};
    state.deadline = context.now + PYRAMID_MS;
    log(state, "进入金字塔：可打出与公开牌点数相同的手牌，或选择保留。");
  } else state.deadline = context.now + TURN_MS;
}

function beginBus(state: RideBusState, context: GameContext) {
  const ordered = [...state.playerIds].sort((a, b) =>
    state.hands[b].length - state.hands[a].length ||
    Math.max(0, ...state.hands[b].map(c => c.rank)) - Math.max(0, ...state.hands[a].map(c => c.rank)) ||
    state.playerIds.indexOf(a) - state.playerIds.indexOf(b));
  state.busRider = ordered[0];
  state.busCards = [];
  state.busCorrect = 0;
  state.deck = newDeck(context);
  state.stage = "bus";
  state.deadline = context.now + TURN_MS;
  log(state, `${state.names[state.busRider]}搭巴士：固定四次猜测，猜错也会继续。`);
}

function nextPyramid(state: RideBusState, context: GameContext) {
  if (state.pyramidIndex === 14) { beginBus(state, context); return; }
  state.pyramidIndex++;
  state.responses = {};
  state.deadline = context.now + PYRAMID_MS;
}

function playPyramid(state: RideBusState, id: string, discard: boolean, context: GameContext) {
  if (Object.hasOwn(state.responses, id)) throw new Error("你已经处理过这张公开牌。");
  if (discard) {
    const rank = state.pyramid[state.pyramidIndex].rank;
    const count = state.hands[id].filter(card => card.rank === rank).length;
    if (!count) throw new Error("你的手牌没有相同点数。");
    state.hands[id] = state.hands[id].filter(card => card.rank !== rank);
    const points = count * pyramidLevel(state.pyramidIndex);
    state.scores[id] += points;
    log(state, `${state.names[id]}配出${count}张牌，+${points}分。`);
  }
  state.responses[id] = discard;
  if (state.playerIds.every(playerId => Object.hasOwn(state.responses, playerId))) nextPyramid(state, context);
}

function playBus(state: RideBusState, answer: string | undefined, context: GameContext) {
  const card = draw(state);
  const step = state.busCards.length;
  const correct = answer !== undefined && guessMatches(step, answer, card, state.busCards);
  state.busCards.push(card);
  if (correct) { state.busCorrect++; state.scores[state.busRider!]++; }
  log(state, `巴士第${step + 1}关：${cardLabel(card)}，${answer === undefined ? "超时" : correct ? "猜对，+1分" : "未猜中"}。`);
  if (state.busCards.length === 4) {
    state.status = "finished";
    delete state.deadline;
    state.deck = [];
    log(state, `巴士到站！${state.names[state.busRider!]}答对${state.busCorrect}/4关。`);
  } else state.deadline = context.now + TURN_MS;
}

function create(players: GamePlayer[], context: GameContext): RideBusState {
  if (players.length < 2 || players.length > 8 || new Set(players.map(p => p.id)).size !== players.length) throw new Error("搭巴士需要2～8位不同的玩家。");
  return {
    ...roster(players), status: "playing", stage: "deal", deck: newDeck(context),
    hands: Object.fromEntries(players.map(p => [p.id, []])),
    scores: Object.fromEntries(players.map(p => [p.id, 0])),
    dealStep: 0, turnIndex: 0, pyramid: [], pyramidIndex: 0, responses: {},
    busCards: [], busCorrect: 0, history: ["四轮猜牌开始：每个人最终获得4张私人手牌。"],
    deadline: context.now + TURN_MS
  };
}

function act(state: RideBusState, playerId: string, action: GameAction, context: GameContext) {
  requirePlayer(state, playerId);
  if (state.deadline !== undefined && context.now >= state.deadline) throw new Error("本回合已超时，请等待服务器推进。");
  if (state.stage === "pyramid") {
    if (action.type !== "match" || (action.value !== "discard" && action.value !== "keep")) throw new Error("请选择配牌或保留。");
    playPyramid(state, playerId, action.value === "discard", context);
    return;
  }
  const turnId = state.stage === "deal" ? state.playerIds[state.turnIndex] : state.busRider!;
  requireTurn(state, playerId, turnId);
  const step = state.stage === "deal" ? state.dealStep : state.busCards.length;
  if (action.type !== "guess" || typeof action.value !== "string" || !options(step).some(choice => choice.value === action.value)) throw new Error("请选择当前关卡中的有效答案。");
  if (state.stage === "deal") playDeal(state, action.value, context);
  else playBus(state, action.value, context);
}

function display(state: RideBusState, viewerId: string): GameDisplay {
  const participant = state.playerIds.includes(viewerId);
  const ownHand = participant ? state.hands[viewerId] : undefined;
  const cards = ownHand?.map(card => `你的手牌 · ${cardLabel(card)}`) ?? [];
  const base: GameDisplay = {
    title: "搭巴士", prompt: "", cards, deadline: state.deadline,
    rows: state.playerIds.map(id => ({ label: state.names[id], value: `${state.scores[id]}分 · 剩余${state.hands[id].length}张${id === state.busRider ? " · 巴士挑战者" : ""}`, highlight: id === viewerId })),
    history: state.history,
    notice: participant ? ownHand?.length ? "手牌点数只对你可见。A最大；相等点数不算高低、内外猜中。" : "你的手牌暂时为空。" : "你正在观战，将在下一局参与。",
    choices: []
  };
  if (state.stage !== "deal") cards.unshift(...state.pyramid.slice(0, state.pyramidIndex + 1).map((card, i) => `金字塔 ${i + 1} · ${cardLabel(card)}`));
  if (state.stage === "bus") cards.push(...state.busCards.map((card, i) => `巴士第${i + 1}关 · ${cardLabel(card)}`));
  if (state.status === "finished") {
    const best = Math.max(...Object.values(state.scores));
    const leaders = state.playerIds.filter(id => state.scores[id] === best).map(id => state.names[id]).join("、");
    base.prompt = "巴士到站，本场结束！";
    base.result = `${state.names[state.busRider!]}巴士挑战答对${state.busCorrect}/4；积分领先：${leaders}（${best}分）。`;
    base.progress = "三个阶段全部完成";
    return base;
  }
  if (state.stage === "pyramid") {
    const card = state.pyramid[state.pyramidIndex];
    const level = pyramidLevel(state.pyramidIndex);
    base.prompt = `公开牌：${cardLabel(card)}。打出同点数手牌，每张得${level}分。`;
    base.subtitle = Object.hasOwn(state.responses, viewerId) ? "已提交，等待大家处理这张牌。" : "可以配出全部相同点数的手牌，也可以保留。";
    base.progress = `金字塔 ${state.pyramidIndex + 1}/15 · 第${level}层 · ${Object.keys(state.responses).length}/${state.playerIds.length}人已提交`;
    if (participant && !Object.hasOwn(state.responses, viewerId)) {
      if (ownHand!.some(held => held.rank === card.rank)) base.choices!.push({ id: "match", label: "配出全部同点数牌", value: "discard" });
      base.choices!.push({ id: "match", label: "保留手牌", value: "keep" });
    }
    return base;
  }
  const step = state.stage === "deal" ? state.dealStep : state.busCards.length;
  const turnId = state.stage === "deal" ? state.playerIds[state.turnIndex] : state.busRider!;
  base.turnId = turnId;
  base.progress = state.stage === "deal" ? `发牌阶段 · 第${step + 1}/4轮 · 第${state.turnIndex + 1}/${state.playerIds.length}位` : `巴士挑战 · 第${step + 1}/4关`;
  base.prompt = `${state.names[turnId]}，${stepLabels[step]}！`;
  base.subtitle = turnId === viewerId ? "在倒计时结束前作出选择。" : `等待${state.names[turnId]}选择。`;
  if (turnId === viewerId) {
    base.choices = options(step);
    const previous = state.stage === "deal" ? state.hands[viewerId] : state.busCards;
    if (step === 1) base.prompt += ` 与${cardLabel(previous[0])}比较。`;
    if (step === 2) base.prompt += ` 两张边界：${cardLabel(previous[0])}、${cardLabel(previous[1])}。`;
  }
  return base;
}

function timeout(state: RideBusState, context: GameContext) {
  if (state.status !== "playing" || state.deadline === undefined || context.now < state.deadline) return;
  if (state.stage === "deal") playDeal(state, undefined, context);
  else if (state.stage === "bus") playBus(state, undefined, context);
  else {
    const missing = state.playerIds.filter(id => !Object.hasOwn(state.responses, id));
    log(state, `${missing.map(id => state.names[id]).join("、")}超时，自动保留手牌。`);
    nextPyramid(state, context);
  }
}

export const game = defineGame<RideBusState>({ id: "ride-the-bus", minPlayers: 2, maxPlayers: 8, create, act, display, timeout });
