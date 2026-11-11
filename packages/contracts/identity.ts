export const uuidSchema = { type: "string", format: "uuid" } as const;
export const idParams = { type: "object", additionalProperties: false, required: ["id"], properties: { id: uuidSchema } } as const;
export const nicknameSchema = { type: "string", minLength: 1, maxLength: 24 } as const;
export const challengeBody = {
  type: "object", additionalProperties: false, required: ["phone", "purpose"],
  properties: {
    phone: { type: "string", pattern: "^1[3-9][0-9]{9}$" },
    purpose: { type: "string", enum: ["login", "admin", "support", "phone-change-old", "phone-change-new"] },
  },
} as const;
export const loginBody = {
  type: "object", additionalProperties: false, required: ["challengeId", "code"],
  properties: {
    challengeId: uuidSchema, code: { type: "string", pattern: "^[0-9]{6}$" },
    acceptTerms: { type: "boolean" }, termsVersion: { type: "string", const: "internal-v1" },
  },
} as const;
export const profileBody = {
  type: "object", additionalProperties: false, minProperties:1, properties: { nickname: nicknameSchema,avatarKey:avatarKeySchema },
} as const;
export const restrictionBody = {
  type: "object", additionalProperties: false, required: ["capability", "reason"],
  properties: {
    capability: { type: "string", enum: ["create", "submit", "comment", "billing", "all"] },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;
export const phoneChangeBody = {
  type: "object", additionalProperties: false,
  required: ["oldChallengeId", "oldCode", "newChallengeId", "newCode"],
  properties: {
    oldChallengeId: uuidSchema, newChallengeId: uuidSchema,
    oldCode: { type: "string", pattern: "^[0-9]{6}$" }, newCode: { type: "string", pattern: "^[0-9]{6}$" },
  },
} as const;
export const reasonBody = {
  type: "object", additionalProperties: false, required: ["reason"],
  properties: { reason: { type: "string", minLength: 1, maxLength: 1000 } },
} as const;
export function dataResponse(data: object) {
  return { type: "object", additionalProperties: false, required: ["data", "requestId"],
    properties: { data, requestId: { type: "string" } } };
}
export const userData = {
  type: "object", additionalProperties: false, required: ["id", "nickname", "status"],
  properties: { id: uuidSchema, nickname: nicknameSchema, status: { type: "string" },avatarKey:avatarKeySchema },
} as const;
export const authData = {
  type: "object", additionalProperties: false, required: ["user", "csrfToken", "expiresAt", "kind"],
  properties: {
    user: userData, csrfToken: { type: "string" }, expiresAt: { type: "string", format: "date-time" },
    kind: { type: "string", enum: ["user", "admin", "support"] }, roles: { type: "array", items: { type: "string" } },
  },
} as const;
export const genericObject = { type: "object", additionalProperties: true } as const;
import { avatarKeySchema } from "./profile";
