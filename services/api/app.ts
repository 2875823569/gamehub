import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import type { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";
import type { Pool } from "pg";
import {
  accessResponseSchema, errorSchema, exchangeBodySchema, guestBodySchema,
  guestResponseSchema, revokedResponseSchema,
} from "../../packages/contracts/access";
import { AccessStore, type AccessIdentity } from "./access-store";
import type { ApiConfig } from "./config";
import { ApiError, accessRequired } from "./errors";
import { csrfToken, isToken, tokenEqual } from "./tokens";
import { registerIdentityModule } from "./identity";
import { registerCatalogModule } from "./catalog-module";
import { registerWalletModule } from "./wallet-module";
import { registerCommunityModule } from "./community";
import { registerRoomsModule } from "./rooms-module";

export function accessCookieName(config: ApiConfig): string {
  return config.secureCookies ? "__Host-gamehub_test_access" : "gamehub_dev_test_access";
}

export async function buildApp(config: ApiConfig, pool: Pool, logging = false) {
  const app = Fastify({
    logger: logging, logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false, genReqId: () => randomUUID(), trustProxy: false,
    bodyLimit: 8192, requestTimeout: 15000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  }).withTypeProvider<JsonSchemaToTsProvider>();
  const store = new AccessStore(pool, config);
  const cookieName = accessCookieName(config);
  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "GameHub Internal Platform API", version: "0.2.0",
        description: "受控内测接口；真实 AI、短信、收款和不可信服务端执行仍受环境门槛限制。" },
      components: { securitySchemes: { testAccess: {
        type: "apiKey", in: "cookie", name: cookieName,
      } } },
    },
  });
  const errorResponses = { 400: errorSchema, 403: errorSchema, 409: errorSchema, 413: errorSchema, 429: errorSchema, 500: errorSchema, 503: errorSchema };
  const originHeaders = {
    type: "object", required: ["origin"], properties: { origin: { type: "string" } },
  } as const;
  const mutationHeaders = {
    type: "object", required: ["origin", "x-csrf-token"],
    properties: { origin: { type: "string" }, "x-csrf-token": { type: "string" } },
  } as const;

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (!request.headers.origin || !config.allowedOrigins.includes(request.headers.origin) ||
          request.headers["sec-fetch-site"] === "cross-site") {
        throw new ApiError(403, "PERMISSION_DENIED", "请求来源不受信任");
      }
    }
    const rateScope = /^\/api\/v1\/(?:auth\/|test-access\/exchanges)/.test(request.url) ? "auth" : "api";
    if (request.url.startsWith("/api/") && !(await store.allowRequest(request.ip, rateScope))) {
      reply.header("Retry-After", "60");
      throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    let status = 500, code: typeof errorSchema.properties.error.properties.code.enum[number] = "INTERNAL_ERROR";
    let message = "服务暂时无法完成请求";
    if (error instanceof ApiError) {
      status = error.statusCode; code = error.code; message = error.message;
    } else if (typeof error === "object" && error !== null && "statusCode" in error &&
        typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      status = error.statusCode === 413 ? 413 : 400; code = "INVALID_REQUEST"; message = "请求格式或大小不符合要求";
    } else {
      const driverCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (typeof driverCode === "string" && (/^[0-9A-Z]{5}$/.test(driverCode) ||
          ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(driverCode))) {
        status = 503; code = "DEPENDENCY_UNAVAILABLE"; message = "服务依赖暂不可用，请稍后重试";
      }
      // Database exceptions may contain SQL values; never pass the raw error to the logger.
      request.log.error({ requestId: request.id, category: "dependency_failure" }, "请求失败");
    }
    reply.code(status).send({ error: { code, message }, requestId: request.id });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "接口不存在" }, requestId: request.id });
  });

  const tokenFor = (cookies: Record<string, string | undefined>) => {
    const token = cookies[cookieName];
    if (!isToken(token)) throw accessRequired();
    return token;
  };
  const verifyCsrf = (token: string, header: string | string[] | undefined) => {
    if (typeof header !== "string" || !tokenEqual(csrfToken(config.tokenSecret, token), header)) {
      throw new ApiError(403, "PERMISSION_DENIED", "请求校验失败，请刷新后重试");
    }
  };
  const accessResponse = (identity: AccessIdentity, token: string, requestId: string) => ({
    data: {
      expiresAt: identity.expires_at.toISOString(), csrfToken: csrfToken(config.tokenSecret, token),
      capabilities: { play: true as const, create: false as const, admin: false as const },
    }, requestId,
  });
  const cookieOptions = { path: "/", httpOnly: true, secure: config.secureCookies, sameSite: "strict" as const };

  app.get("/health/live", { schema: { hide: true } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { schema: { hide: true } }, async () => {
    try { await store.assertEnvironment(); }
    catch { throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", "服务尚未就绪"); }
    return { status: "ready" };
  });
  app.post("/api/v1/test-access/exchanges", {
    schema: { operationId: "exchangeTestInvitation", headers: originHeaders, body: exchangeBodySchema,
      response: { 201: accessResponseSchema, ...errorResponses } },
  }, async (request, reply) => {
    const result = await store.exchange(request.body.invitation, request.id, request.cookies[cookieName]);
    reply.setCookie(cookieName, result.token, { ...cookieOptions, expires: result.identity.expires_at });
    return reply.code(201).send(accessResponse(result.identity, result.token, request.id));
  });
  app.get("/api/v1/test-access/sessions/current", {
    schema: { operationId: "getTestAccessSession", security: [{ testAccess: [] }],
      response: { 200: accessResponseSchema, ...errorResponses } },
  }, async request => {
    const token = tokenFor(request.cookies);
    return accessResponse(await store.current(token), token, request.id);
  });
  app.delete("/api/v1/test-access/sessions/current", {
    schema: { operationId: "revokeTestAccessSession", security: [{ testAccess: [] }], headers: mutationHeaders,
      response: { 200: revokedResponseSchema, ...errorResponses } },
  }, async (request, reply) => {
    const token = tokenFor(request.cookies);
    verifyCsrf(token, request.headers["x-csrf-token"]);
    await store.revokeSession(token, request.id);
    reply.clearCookie(cookieName, cookieOptions);
    return { data: { revoked: true as const }, requestId: request.id };
  });
  app.post("/api/v1/guest-sessions", {
    schema: { operationId: "createGuestSession", security: [{ testAccess: [] }], headers: mutationHeaders, body: guestBodySchema,
      response: { 200: guestResponseSchema, ...errorResponses } },
  }, async request => {
    const token = tokenFor(request.cookies);
    verifyCsrf(token, request.headers["x-csrf-token"]);
    const nickname = request.body.nickname.normalize("NFKC").trim();
    if (!nickname || [...nickname].length > 24 || /[\p{Cc}\p{Cf}]/u.test(nickname)) {
      throw new ApiError(400, "INVALID_REQUEST", "昵称应为 1—24 个可见字符");
    }
    return { data: await store.guest(token, nickname), requestId: request.id };
  });
  app.get("/api/v1/guest-sessions/current", {
    schema: { operationId: "getGuestSession", security: [{ testAccess: [] }],
      response: { 200: guestResponseSchema, ...errorResponses } },
  }, async request => ({ data: await store.guest(tokenFor(request.cookies)), requestId: request.id }));

  const auth = await registerIdentityModule(app, config, pool);
  const context = { app, config, pool, auth };
  await registerCatalogModule(context);
  await registerWalletModule(context);
  await registerCommunityModule(context);
  const rooms = await registerRoomsModule(context);
  app.get("/api/v1/platform/config", { schema: { response: { 200: {
    type: "object", properties: { data: { type: "object", properties: {
      gameOrigin: { type: "string" }, testOnly: { type: "boolean" }, aiMode: { type: "string" },
    } }, requestId: { type: "string" } },
  } } } }, async request => {
    await auth.access(request);
    return { data: { gameOrigin: config.gameOrigin ?? "", testOnly: true, aiMode: "mock" }, requestId: request.id };
  });
  return { app, store, auth, rooms };
}
