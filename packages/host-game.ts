import { challenge, createRound, MAX_PLAYERS, MIN_PLAYERS, placeBid, randomInt, respondSlash, slash, type Round } from "./games/liars-dice/rules";
import { partyGames } from "./games/registry";
import type { GameContext, GameState } from "./games/core";
import type { ClientAction, RoomView, ServerMessage } from "./protocol";
import type { PeerRoster } from "./peer-protocol";

export interface HostSnapshot {
  version: 1;
  revision: number;
  phase: RoomView["phase"];
  round?: Round;
  party?: { number: number; state: GameState; interrupted?: string };
  // Persist deduplication with game state so relay retries cannot apply twice.
  receipts: { playerId: string; requestId: string; reply: ServerMessage }[];
}

/** Owns the trusted host's private state; only view(playerId) leaves for a guest. */
export class HostGame {
  private data: HostSnapshot;
  private roster: PeerRoster;
  private lastAction = new Map<string, number>();

  constructor(roster: PeerRoster, snapshot?: HostSnapshot, private random = randomInt) {
    this.roster = roster;
    this.data = snapshot ? structuredClone(snapshot) : { version: 1, revision: 0, phase: "lobby", receipts: [] };
    this.reconcile(roster);
  }

  snapshot(): HostSnapshot { return structuredClone(this.data); }
  private definition() { return partyGames.get(this.roster.gameId); }
  private context(now: number): GameContext {
    return { now, randomInt: this.random, hostId: this.roster.hostId, roundNumber: this.data.party?.number ?? 1 };
  }

  reconcile(roster: PeerRoster, reason: "leave" | "disconnect" = "leave") {
    this.roster = roster;
    const ids = this.data.party?.state.playerIds ?? this.data.round?.playerIds ?? [];
    const departed = ids.find(id => !roster.players.some(p => p.id === id));
    if (this.data.phase === "playing" && departed) {
      if (this.data.party) {
        const party = this.data.party;
        party.interrupted = `${party.state.names[departed]}已离开，本局中止。房主可以重新开局。`;
        party.state.status = "finished";
        delete party.state.deadline;
      }
      if (this.data.round) {
        this.data.round.outcome = { loserId: departed, reason, multiplier: 1 };
        delete this.data.round.pendingSlash;
      }
      this.data.phase = "finished";
    }
    this.data.revision++;
  }

  tick(now = Date.now()): boolean {
    const party = this.data.party;
    const game = this.definition();
    if (this.data.phase !== "playing" || !party || !game || party.state.deadline === undefined || party.state.deadline > now) return false;
    const next = structuredClone(party.state);
    game.timeout?.(next, this.context(now));
    if (next.deadline !== undefined && next.deadline <= now) delete next.deadline;
    party.state = next;
    if (next.status === "finished") this.data.phase = "finished";
    this.data.revision++;
    return true;
  }

  act(playerId: string, action: ClientAction, now = Date.now()): ServerMessage {
    const requestId = action?.requestId;
    if (!requestId || typeof requestId !== "string" || requestId.length > 80) return { type: "error", message: "操作缺少有效编号。" };
    const prior = this.data.receipts.find(r => r.playerId === playerId && r.requestId === requestId);
    if (prior) return structuredClone(prior.reply);
    let reply: ServerMessage;
    try {
      if (!this.roster.players.some(p => p.id === playerId && p.connected)) throw new Error("请先连接房间。");
      const last = this.lastAction.get(playerId);
      if (last !== undefined && now - last < 150) throw new Error("操作太快，请稍后重试。");
      this.lastAction.set(playerId, now);
      if (this.tick(now) && action.type === "game") throw new Error("本轮时间已到，请按最新画面操作。");
      // Commit atomically: invalid actions may not partly mutate a game.
      const next = structuredClone(this.data);
      const game = this.definition();
      switch (action.type) {
        case "start": {
          if (playerId !== this.roster.hostId) throw new Error("只有房主可以开始游戏。");
          if (next.phase === "playing") throw new Error("本局还没有结束。");
          if (this.roster.players.length < (game?.minPlayers ?? MIN_PLAYERS)) throw new Error("人数不足，邀请朋友再开始。");
          if (this.roster.players.some(p => !p.connected)) throw new Error("还有玩家未连接，请等他们回来。");
          if (game) {
            const number = (next.party?.number ?? 0) + 1;
            next.party = { number, state: game.create(this.roster.players, { ...this.context(now), roundNumber: number }) };
          } else next.round = createRound(this.roster.players, (next.round?.number ?? 0) + 1, this.random, next.round);
          next.phase = "playing";
          break;
        }
        case "game":
          if (!game || !next.party || next.phase !== "playing") throw new Error("当前不在对局中。");
          if (!next.party.state.playerIds.includes(playerId)) throw new Error("你正在观战，请等待下一局。");
          if (!action.action || typeof action.action.type !== "string") throw new Error("游戏操作格式不正确。");
          game.act(next.party.state, playerId, action.action, this.context(now));
          if (next.party.state.status === "finished") next.phase = "finished";
          break;
        case "bid": case "challenge": case "slash": case "respond-slash":
          if (!next.round || next.phase !== "playing") throw new Error("当前不在对局中。");
          if (action.type === "bid") placeBid(next.round, playerId, action.count, action.face, action.mode);
          if (action.type === "challenge") challenge(next.round, playerId);
          if (action.type === "slash") slash(next.round, playerId);
          if (action.type === "respond-slash") respondSlash(next.round, playerId, action.counter);
          if (next.round.outcome) next.phase = "finished";
          break;
        default: throw new Error("不支持的操作。");
      }
      this.data = next;
      this.data.revision++;
      reply = { type: "ack", requestId, revision: this.data.revision };
    } catch (error) {
      reply = { type: "error", requestId, message: error instanceof Error ? error.message : "操作失败。" };
      this.data.revision++;
    }
    this.data.receipts.push({ playerId, requestId, reply });
    this.data.receipts = this.data.receipts.slice(-256);
    return reply;
  }

  view(playerId: string, now = Date.now()): RoomView {
    const { round, party } = this.data;
    const game = this.definition();
    return structuredClone({
      revision: this.data.revision, code: this.roster.code, gameId: this.roster.gameId,
      minPlayers: game?.minPlayers ?? MIN_PLAYERS, maxPlayers: game?.maxPlayers ?? MAX_PLAYERS,
      phase: this.data.phase, hostId: this.roster.hostId, you: playerId,
      players: this.roster.players.map(({ connectionId: _, ...p }) => p),
      party: party && game ? {
        number: party.number, playerIds: party.state.playerIds, interrupted: party.interrupted,
        display: party.interrupted ? { title: "本局已中止", prompt: party.interrupted, result: party.interrupted }
          : game.display(party.state, playerId, this.context(now))
      } : undefined,
      round: round ? {
        number: round.number, playerIds: round.playerIds, names: round.names,
        turnId: round.playerIds[round.turnIndex], bids: round.bids,
        yourDice: round.dice[playerId] ?? [], pendingSlash: round.pendingSlash,
        ...(this.data.phase === "finished" ? { revealedDice: round.dice, outcome: round.outcome } : {})
      } : undefined
    });
  }
}
