import { uuidSchema } from "./identity";

const actionBase = { requestId: { type: "string", maxLength: 80 } } as const;
export const officialActionSchema = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type"],
      properties: { type: { enum: ["start", "challenge", "slash"] }, ...actionBase } },
    { type: "object", additionalProperties: false, required: ["type", "counter"],
      properties: { type: { const: "respond-slash" }, counter: { type: "boolean" }, ...actionBase } },
    { type: "object", additionalProperties: false, required: ["type", "count", "face"],
      properties: { type: { const: "bid" }, count: { type: "integer", minimum: 1, maximum: 100 },
        face: { type: "integer", minimum: 1, maximum: 6 }, mode: { type: "string", enum: ["normal", "zhai", "fly"] }, ...actionBase } },
    { type: "object", additionalProperties: false, required: ["type", "action"],
      properties: { type: { const: "game" }, action: {
        type: "object", additionalProperties: false, required: ["type"],
        properties: { type: { type: "string", minLength: 1, maxLength: 80 }, value: {} },
      }, ...actionBase } },
  ],
} as const;
export const actionIdSchema = { type: "string", pattern: "^[A-Za-z0-9_-]{8,80}$" } as const;
export const roomActionBody = {
  type: "object", additionalProperties: false, required: ["actionId", "expectedSequence", "action"],
  properties: { actionId: actionIdSchema, expectedSequence: { type: "integer", minimum: 0 }, action: officialActionSchema },
} as const;
export const roomStartBody = {
  type: "object", additionalProperties: false, required: ["actionId", "expectedSequence"],
  properties: { actionId: actionIdSchema, expectedSequence: { type: "integer", minimum: 0 } },
} as const;
export const roomCreateBody = {
  type: "object", additionalProperties: false, required: ["gameId"], properties: { gameId: uuidSchema },
} as const;
export const roomJoinBody = {
  type: "object", additionalProperties: false, required: ["inviteToken"],
  properties: { inviteToken: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
} as const;
