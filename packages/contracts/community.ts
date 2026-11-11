import { uuidSchema } from "./identity";
export const commentBody = {
  type: "object", additionalProperties: false, required: ["content"],
  properties: { content: { type: "string", minLength: 1, maxLength: 2000 } },
} as const;
export const feedbackBody = {
  type: "object", additionalProperties: false, required: ["expected", "actual"],
  properties: {
    gameId: uuidSchema, versionId: uuidSchema, playSessionId: uuidSchema, roomId: uuidSchema, taskId: uuidSchema,
    expected: { type: "string", minLength: 1, maxLength: 2000 },
    actual: { type: "string", minLength: 1, maxLength: 4000 },
    attachmentIds: { type: "array", maxItems: 3, uniqueItems: true, items: uuidSchema },
    diagnostics: {
      type: "object", additionalProperties: false,
      properties: {
        errorCode: { type: "string", maxLength: 80 }, platformVersion: { type: "string", maxLength: 80 },
        clientKind: { type: "string", maxLength: 80 },
      },
    },
  },
} as const;
export const feedbackUpdateBody = {
  type: "object", additionalProperties: false, required: ["state", "reason"],
  properties: {
    state: { type: "string", enum: ["accepted", "in_progress", "awaiting_retest", "closed", "declined"] },
    severity: { type: "string", enum: ["blocking", "severe", "normal", "suggestion"] },
    reason: { type: "string", minLength: 1, maxLength: 2000 }, fixVersionId: uuidSchema,
  },
} as const;
export const reportBody = {
  type: "object", additionalProperties: false, required: ["objectType", "objectId", "reason"],
  properties: {
    objectType: { type: "string", enum: ["game", "comment"] }, objectId: uuidSchema,
    reason: { type: "string", minLength: 1, maxLength: 1000 },
  },
} as const;
export const appealBody = {
  ...reportBody,
  properties: { ...reportBody.properties, objectType: { type: "string", enum: ["account", "game", "report"] } },
} as const;
export const uploadBody = {
  type: "object", additionalProperties: false, required: ["mime", "size", "sha256"],
  properties: {
    mime: { type: "string", enum: ["image/png", "image/jpeg", "text/plain"] },
    size: { type: "integer", minimum: 1, maximum: 5242880 },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;
