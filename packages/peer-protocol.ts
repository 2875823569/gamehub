import type { ClientAction, PublicPlayer, ServerMessage } from "./protocol";
import type { HostSnapshot } from "./host-game";

// DOM-independent wire types, shared by Workers and browsers.
export interface PeerPlayer extends PublicPlayer { connectionId?: string }
export interface PeerRoster {
  code: string;
  gameId: string;
  hostId: string;
  epoch: number;
  revision: number;
  you: string;
  players: PeerPlayer[];
}
export type Signal =
  | { description: { type: "offer" | "answer"; sdp: string } }
  | { candidate: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } };
export type PeerPayload =
  | { type: "action"; action: ClientAction }
  | { type: "message"; message: ServerMessage }
  | { type: "sync" }
  | { type: "ping"; at: number }
  | { type: "pong"; at: number };
export type PeerClientMessage =
  | { type: "peer-signal"; to: string; connectionId: string; epoch: number; negotiation: string; signal: Signal }
  | { type: "peer-relay"; to: string; epoch: number; payload: PeerPayload }
  | { type: "peer-checkpoint"; epoch: number; snapshot: HostSnapshot }
  | { type: "leave"; requestId?: string };
export type PeerServerMessage =
  | { type: "peer-roster"; roster: PeerRoster; snapshot?: HostSnapshot }
  | { type: "peer-signal"; from: string; connectionId: string; epoch: number; negotiation: string; signal: Signal }
  | { type: "peer-relay"; from: string; epoch: number; payload: PeerPayload }
  | { type: "peer-saved"; revision: number }
  | Extract<ServerMessage, { type: "error" | "left" }>;

export const MAX_PEER_MESSAGE = 256 * 1024;
