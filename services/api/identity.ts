import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  authData, challengeBody, dataResponse, genericObject, idParams, loginBody,
  phoneChangeBody, profileBody, reasonBody, restrictionBody, userData,
} from "../../packages/contracts/identity";
import type { ApiConfig } from "./config";
import { ApiError } from "./errors";
import { IdentityService, accountCookieName, type ChallengePurpose, type SessionKind } from "./identity-store";
import { csrfToken } from "./tokens";
import { withTransaction } from "./db";
import type { PlatformAuth } from "./platform-auth";
import type { AccessIdentity } from "./access-store";
import { publicAuthorData,type AvatarKey } from "../../packages/contracts/profile";

export async function registerIdentityModule(app: FastifyInstance, config: ApiConfig, pool: Pool): Promise<PlatformAuth> {
  const auth = new IdentityService(pool, config);
  const cookies = { httpOnly: true, secure: config.secureCookies, sameSite: "strict" as const, path: "/" };
  const response = (request: FastifyRequest, data: unknown) => ({ data, requestId: request.id });
  app.post("/api/v1/auth/sms-challenges", { schema: { body: challengeBody, response: { 200: dataResponse(genericObject) } } }, async request => {
    const access = await auth.access(request);
    const body = request.body as { phone: string; purpose: ChallengePurpose };
    return response(request, await auth.challenge(access, body.phone, body.purpose));
  });
  app.post("/api/v1/auth/sessions", { schema: { body: loginBody, response: { 201: dataResponse(authData) } } }, async (request, reply) => {
    const access = await auth.access(request);
    const result = await auth.login(access, request.body as { challengeId: string; code: string; acceptTerms?: boolean; termsVersion?: string });
    reply.setCookie(accountCookieName(config, result.kind), result.token, { ...cookies, expires: new Date(result.expiresAt) });
    return reply.code(201).send(response(request, { user: result.user, kind: result.kind, roles: result.roles,
      expiresAt: result.expiresAt, csrfToken: csrfToken(config.tokenSecret, result.token) }));
  });
  const current = async (request: FastifyRequest, kind: SessionKind) => {
    const actor = await auth.authenticate(request, kind);
    const user = (await pool.query('SELECT id,nickname,status,avatar_key AS "avatarKey" FROM users WHERE id=$1', [actor.userId])).rows[0];
    const session = (await pool.query("SELECT expires_at FROM account_sessions WHERE id=$1", [actor.sessionId])).rows[0];
    return response(request, { user, kind, roles: actor.roles, expiresAt: session.expires_at.toISOString(),
      csrfToken: csrfToken(config.tokenSecret, request.cookies[accountCookieName(config, kind)]!) });
  };
  for (const [kind, path] of [
    ["user", "/api/v1/auth/sessions/current"], ["admin", "/api/v1/admin/auth/sessions/current"], ["support", "/api/v1/support/sessions/current"],
  ] as const) {
    app.get(path, { schema: { response: { 200: dataResponse(authData) } } }, request => current(request, kind));
    app.delete(path, { schema: { response: { 200: dataResponse(genericObject) } } }, async (request, reply) => {
      const actor = await auth.authenticate(request, kind);
      await withTransaction(pool, async client => {
        // Support sessions may belong to a disabled account; recheck access and
        // the exact support credential rather than requiring an active user.
        if (kind === "support") {
          const row = (await client.query("SELECT id,generation,expires_at FROM test_access_sessions WHERE id=$1", [actor.accessSessionId])).rows[0];
          if (!row) throw new ApiError(403, "TEST_ACCESS_REQUIRED", "请重新进入测试范围");
          await auth.assertAccess(client, row);
        } else await auth.assertActor(client, actor);
        await client.query("UPDATE account_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2", [actor.sessionId, actor.userId]);
      });
      reply.clearCookie(accountCookieName(config, kind), cookies);
      return response(request, { revoked: true });
    });
  }
  app.get("/api/v1/me", { schema: { response: { 200: dataResponse(userData) } } }, async request => {
    const actor = await auth.user(request);
    return response(request, (await pool.query('SELECT id,nickname,status,avatar_key AS "avatarKey" FROM users WHERE id=$1', [actor.userId])).rows[0]);
  });
  app.patch("/api/v1/me/profile", { schema: { body: profileBody, response: { 200: dataResponse(userData) } } }, async request => {
    const actor = await auth.user(request);
    const input=request.body as {nickname?:string;avatarKey?:AvatarKey};
    const nickname = input.nickname?.normalize("NFKC").trim();
    if (nickname!==undefined && (!nickname || [...nickname].length > 24 || /[\p{Cc}\p{Cf}]/u.test(nickname))) throw new ApiError(400, "INVALID_REQUEST", "昵称应为 1—24 个可见字符");
    const data = await withTransaction(pool, async client => {
      await auth.assertActor(client, actor);
      return (await client.query(`UPDATE users SET nickname=COALESCE($2,nickname),avatar_key=COALESCE($3,avatar_key),updated_at=now()
        WHERE id=$1 RETURNING id,nickname,status,avatar_key AS "avatarKey"`, [actor.userId, nickname??null,input.avatarKey??null])).rows[0];
    });
    return response(request, data);
  });
  app.get("/api/v1/authors/:id",{schema:{params:idParams,response:{200:dataResponse(publicAuthorData)}}},async request=>{
    await auth.access(request);
    const id=(request.params as {id:string}).id;
    const author=(await pool.query(`SELECT id,nickname,avatar_key AS "avatarKey" FROM users
      WHERE id=$1 AND environment_id=$2 AND status='active'`,[id,config.environmentId])).rows[0];
    if(!author)throw new ApiError(404,"NOT_FOUND","作者资料不可访问");
    const games=(await pool.query(`SELECT g.id,g.title,g.description,g.category,v.id AS "versionId"
      FROM games g JOIN publication_heads h ON h.game_id=g.id AND h.environment_id=g.environment_id
      JOIN game_versions v ON v.id=h.version_id AND v.game_id=g.id
      WHERE g.owner_id=$1 AND g.environment_id=$2 AND h.scope='internal_catalog'
        AND g.status='published' AND NOT g.restricted AND g.deleted_at IS NULL AND g.archived_at IS NULL
        AND v.review_status='approved' AND v.check_status='passed' AND v.deleted_at IS NULL
      ORDER BY g.updated_at DESC,g.id LIMIT 100`,[id,config.environmentId])).rows;
    return response(request,{...author,games});
  });
  app.get("/api/v1/me/sessions", { schema: { response: { 200: dataResponse({ type: "array", items: genericObject }) } } }, async request => {
    const actor = await auth.user(request);
    const result = await pool.query(
      "SELECT id,kind,created_at,expires_at,(id=$2) AS current FROM account_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 100",
      [actor.userId, actor.sessionId],
    );
    return response(request, result.rows);
  });
  app.delete("/api/v1/me/sessions/:id", { schema: { params: idParams } }, async request => {
    const actor = await auth.user(request), id = (request.params as { id: string }).id;
    await withTransaction(pool, async client => {
      await auth.assertActor(client, actor);
      const result = await client.query("UPDATE account_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id", [id, actor.userId]);
      if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", "会话不存在");
    });
    return response(request, { revoked: true });
  });
  app.post("/api/v1/me/phone-change", { schema: { body: phoneChangeBody } }, async request => {
    const actor = await auth.user(request);
    const row = (await pool.query("SELECT id,generation,expires_at FROM test_access_sessions WHERE id=$1", [actor.accessSessionId])).rows[0] as AccessIdentity;
    return response(request, await auth.changePhone(actor, row, request.body as Parameters<IdentityService["changePhone"]>[2]));
  });
  app.post("/api/v1/me/closure-requests", { schema: { body: reasonBody } }, async request => {
    const actor = await auth.user(request);
    const data = await withTransaction(pool, async client => {
      await auth.assertActor(client, actor);
      const result = await client.query(
        `INSERT INTO closure_requests(id,user_id,reason) VALUES($1,$2,$3)
         ON CONFLICT(user_id) WHERE state IN ('requested','reviewing') DO UPDATE SET user_id=EXCLUDED.user_id
         RETURNING id,state,created_at`,
        [randomUUID(), actor.userId, (request.body as { reason: string }).reason],
      );
      return { ...result.rows[0], message: "已受理，需核对未结任务、账目与作品后人工处理；账号和数据尚未删除" };
    });
    return response(request, data);
  });
  app.get("/api/v1/admin/users", { schema: { response: { 200: dataResponse({ type: "array", items: userData }) } } }, async request => {
    await auth.admin(request, ["super_admin"]);
    return response(request, (await pool.query('SELECT id,nickname,status,avatar_key AS "avatarKey" FROM users WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100', [config.environmentId])).rows);
  });
  app.post("/api/v1/admin/users/:id/restrictions", { schema: { params: idParams, body: restrictionBody } }, async request => {
    const actor = await auth.admin(request, ["super_admin"]);
    const body = request.body as { capability: string; reason: string; expiresAt?: string }, userId = (request.params as { id: string }).id;
    if (body.expiresAt && new Date(body.expiresAt) <= new Date()) throw new ApiError(400, "INVALID_REQUEST", "结束时间必须晚于当前时间");
    const id = await withTransaction(pool, async client => {
      await auth.assertActor(client, actor);
      const target = await client.query("SELECT id FROM users WHERE id=$1 AND environment_id=$2 FOR UPDATE", [userId, config.environmentId]);
      if (!target.rowCount) throw new ApiError(404, "NOT_FOUND", "账号不存在");
      const restrictionId = randomUUID();
      await client.query("INSERT INTO account_restrictions(id,user_id,capability,reason,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [restrictionId, userId, body.capability, body.reason, body.expiresAt ?? null, actor.userId]);
      if (body.capability === "all") await client.query("UPDATE account_sessions SET revoked_at=now() WHERE user_id=$1 AND kind<>'support'", [userId]);
      await client.query("INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id,metadata) VALUES($1,$2,$3,$4,'account_restricted',$5,$6)",
        [randomUUID(), config.environmentId, actor.generation, actor.userId, userId, JSON.stringify(body)]);
      await client.query("INSERT INTO outbox_events(id,environment_id,generation,business_key,event_type,user_id,payload) VALUES($1,$2,$3,$4,'account.restricted',$5,$6)",
        [randomUUID(),config.environmentId,actor.generation,`restriction:${restrictionId}`,userId,{id:restrictionId,...body}]);
      return restrictionId;
    });
    return response(request, { id });
  });
  app.delete("/api/v1/admin/restrictions/:id", { schema: { params: idParams, body: reasonBody } }, async request => {
    const actor = await auth.admin(request, ["super_admin"]), id = (request.params as { id: string }).id;
    await withTransaction(pool, async client => {
      await auth.assertActor(client, actor);
      const result = await client.query(
        `UPDATE account_restrictions r SET released_at=now() FROM users u
         WHERE r.id=$1 AND u.id=r.user_id AND u.environment_id=$2 AND r.released_at IS NULL RETURNING r.user_id`,
        [id, config.environmentId]);
      if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", "限制记录不存在");
      await client.query("INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id,metadata) VALUES($1,$2,$3,$4,'account_restriction_released',$5,$6)",
        [randomUUID(), config.environmentId, actor.generation, actor.userId, id, JSON.stringify(request.body)]);
      await client.query("INSERT INTO outbox_events(id,environment_id,generation,business_key,event_type,user_id,payload) VALUES($1,$2,$3,$4,'account.restriction_released',$5,$6)",
        [randomUUID(),config.environmentId,actor.generation,`restriction-released:${id}`,result.rows[0].user_id,{id,reason:(request.body as {reason:string}).reason}]);
    });
    return response(request, { released: true });
  });
  app.get("/api/v1/admin/test-access-grants", {}, async request => {
    await auth.admin(request, ["super_admin"]);
    return response(request, (await pool.query(
      "SELECT id,generation,max_uses,used_count,expires_at,revoked_at,created_at FROM test_access_grants WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100",
      [config.environmentId])).rows);
  });
  app.post("/api/v1/admin/test-access-grants", { schema: { body: {
    type: "object", additionalProperties: false, required: ["maxUses", "ttlSeconds"],
    properties: { maxUses: { type: "integer", minimum: 1, maximum: 1000 }, ttlSeconds: { type: "integer", minimum: 60, maximum: 604800 } },
  } } }, async request => {
    const actor = await auth.admin(request, ["super_admin"]), body = request.body as { maxUses: number; ttlSeconds: number };
    return response(request, await auth.accessStore.issueInvitation(body.maxUses, body.ttlSeconds, actor.userId,client=>auth.assertActor(client,actor)));
  });
  app.delete("/api/v1/admin/test-access-grants/:id", { schema: { params: idParams } }, async request => {
    const actor = await auth.admin(request, ["super_admin"]);
    return response(request, { revoked: await auth.accessStore.revokeInvitation((request.params as { id: string }).id, actor.userId,client=>auth.assertActor(client,actor)) });
  });
  app.get("/api/v1/admin/audit-events", {}, async request => {
    await auth.admin(request, ["super_admin"]);
    return response(request, (await pool.query(
      "SELECT id,actor,action,object_id,metadata,created_at FROM audit_events WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100", [config.environmentId])).rows);
  });
  return auth;
}
