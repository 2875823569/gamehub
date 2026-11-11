import type { Bid, BidMode, Outcome, PendingSlash } from "./games/liars-dice/rules";
import type { GameAction, GameDisplay } from "./games/core";

export interface Session {
  code: string;
  playerId: string;
  token: string;
}

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  disconnectAt?: number;
}

export interface RoomView {
  revision: number;
  gameId: string;
  minPlayers: number;
  maxPlayers: number;
  code: string;
  phase: "lobby" | "playing" | "finished";
  hostId: string;
  you: string;
  players: PublicPlayer[];
  party?: {
    number: number;
    playerIds: string[];
    display: GameDisplay;
    interrupted?: string;
  };
  round?: {
    number: number;
    playerIds: string[];
    names: Record<string, string>;
    turnId: string;
    bids: Bid[];
    yourDice: number[];
    revealedDice?: Record<string, number[]>;
    outcome?: Outcome;
    pendingSlash?: PendingSlash;
  };
}

export type ClientAction = (
  | { type: "start" }
  | { type: "game"; action: GameAction }
  | { type: "bid"; count: number; face: number; mode?: BidMode }
  | { type: "challenge" }
  | { type: "slash" }
  | { type: "respond-slash"; counter: boolean }
  | { type: "leave" }
) & { requestId?: string };

export type ServerMessage =
  | { type: "state"; state: RoomView }
  | { type: "ack"; requestId: string; revision: number }
  | { type: "error"; message: string; requestId?: string }
  | { type: "left" };
