import type { FromSchema } from "json-schema-to-ts";

export const errorCodes = [
  "INVALID_REQUEST", "NOT_FOUND", "TEST_ACCESS_REQUIRED", "INVITATION_INVALID",
  "ENVIRONMENT_MISMATCH", "PERMISSION_DENIED", "RATE_LIMITED",
  "DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR", "GUEST_SESSION_REQUIRED",
  "AUTH_REQUIRED", "SMS_CHALLENGE_INVALID", "ACCOUNT_RESTRICTED", "VERSION_CONFLICT",
  "RESOURCE_IN_USE", "GAME_UNAVAILABLE", "PACKAGE_UNSUPPORTED", "ARTIFACT_EXPIRED",
  "PAYLOAD_TOO_LARGE", "SAVE_SCHEMA_MISMATCH", "INSUFFICIENT_POINTS", "QUOTE_EXPIRED",
  "TASK_NOT_CANCELLABLE", "PROVIDER_BUDGET_UNAVAILABLE", "IDENTITY_REQUIRED",
] as const;

export const errorSchema = {
  type: "object", additionalProperties: false, required: ["error", "requestId"],
  properties: {
    error: {
      type: "object", additionalProperties: false, required: ["code", "message"],
      properties: { code: { type: "string", enum: errorCodes }, message: { type: "string" } },
    },
    requestId: { type: "string" },
  },
} as const;

export const exchangeBodySchema = {
  type: "object", additionalProperties: false, required: ["invitation"],
  properties: { invitation: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
} as const;

export const accessDataSchema = {
  type: "object", additionalProperties: false,
  required: ["expiresAt", "csrfToken", "capabilities"],
  properties: {
    expiresAt: { type: "string", format: "date-time" },
    csrfToken: { type: "string" },
    capabilities: {
      type: "object", additionalProperties: false, required: ["play", "create", "admin"],
      properties: { play: { const: true }, create: { const: false }, admin: { const: false } },
    },
  },
} as const;

export const accessResponseSchema = {
  type: "object", additionalProperties: false, required: ["data", "requestId"],
  properties: { data: accessDataSchema, requestId: { type: "string" } },
} as const;

export const guestBodySchema = {
  type: "object", additionalProperties: false, required: ["nickname"],
  properties: { nickname: { type: "string", minLength: 1, maxLength: 24 } },
} as const;

export const guestResponseSchema = {
  type: "object", additionalProperties: false, required: ["data", "requestId"],
  properties: {
    data: {
      type: "object", additionalProperties: false, required: ["id", "nickname"],
      properties: { id: { type: "string", format: "uuid" }, nickname: { type: "string" } },
    },
    requestId: { type: "string" },
  },
} as const;

export const revokedResponseSchema = {
  type: "object", additionalProperties: false, required: ["data", "requestId"],
  properties: {
    data: {
      type: "object", additionalProperties: false, required: ["revoked"],
      properties: { revoked: { const: true } },
    },
    requestId: { type: "string" },
  },
} as const;

export type ExchangeBody = FromSchema<typeof exchangeBodySchema>;
export type GuestBody = FromSchema<typeof guestBodySchema>;
export type AccessResponse = FromSchema<typeof accessResponseSchema>;
export type GuestResponse = FromSchema<typeof guestResponseSchema>;
