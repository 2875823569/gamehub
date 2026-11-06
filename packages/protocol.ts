import type { Bid, Outcome } from "./games/liars-dice/rules";

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
  code: string;
  phase: "lobby" | "playing" | "finished";
  hostId: string;
  you: string;
  players: PublicPlayer[];
  round?: {
    number: number;
    playerIds: string[];
    names: Record<string, string>;
    turnId: string;
    bids: Bid[];
    yourDice: number[];
    revealedDice?: Record<string, number[]>;
    outcome?: Outcome;
  };
}

export type ClientAction =
  | { type: "start" }
  | { type: "bid"; count: number; face: number }
  | { type: "challenge" }
  | { type: "leave" };

export type ServerMessage =
  | { type: "state"; state: RoomView }
  | { type: "error"; message: string }
  | { type: "left" };
