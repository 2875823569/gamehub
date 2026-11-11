import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { appealBody, commentBody, feedbackBody, feedbackUpdateBody, reportBody, uploadBody } from "../../packages/contracts/community";
import { dataResponse, genericObject, idParams, reasonBody, uuidSchema } from "../../packages/contracts/identity";
import { ApiError } from "./errors";
import { withTransaction } from "./db";
import type { PlatformModuleContext } from "./platform-auth";
import { IdentityService, accountCookieName } from "./identity-store";
import { digest, isToken } from "./tokens";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const cleanText = (value: string) => {
  const text = value.normalize("NFKC").trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new ApiError(400, "INVALID_REQUEST", "文本不能为空或包含控制字符");
  return text;
};
export async function notifyUser(client: PoolClient, environmentId: string, userId: string, key: string, type: string, payload: object) {
  await client.query(
    `INSERT INTO notifications(id,environment_id,user_id,event_key,event_type,payload)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(environment_id,user_id,event_key) DO NOTHING`,
    [randomUUID(), environmentId, userId, key, type, payload]);
}
export async function registerCommunityModule({ app, config, pool, auth }: PlatformModuleContext) {
  const identity = new IdentityService(pool, config);
  const response = (request: FastifyRequest, data: unknown) => ({ data, requestId: request.id });
  const genericResponse = { 200: dataResponse(genericObject) };
  const visible = async (client: PoolClient, id: string) => {
    const result = await client.query(
      `SELECT g.id,g.owner_id FROM games g JOIN publication_heads h ON h.game_id=g.id
       WHERE g.id=$1 AND g.environment_id=$2 AND h.environment_id=$2 AND h.scope='internal_catalog'
       AND NOT g.restricted AND g.deleted_at IS NULL`, [id, config.environmentId]);
    if (!result.rows[0]) throw new ApiError(404, "NOT_FOUND", "游戏不存在或不可访问");
    return result.rows[0] as { id: string; owner_id: string };
  };
  const audit = async (client: PoolClient, generation: number, actor: string, action: string, objectId: string, payload: object) => {
    await client.query("INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), config.environmentId, generation, actor, action, objectId, payload]);
  };
  app.get("/api/v1/games/:id/comments", { schema: { params: idParams } }, async request => {
    await auth.access(request);
    const id = (request.params as { id: string }).id;
    const data = await withTransaction(pool, async client => {
      await visible(client, id);
      return (await client.query(
        `SELECT c.id,c.parent_id,c.user_id,u.nickname,
         CASE WHEN c.status='deleted' THEN '' ELSE c.content END AS content,c.status,c.created_at
         FROM comments c JOIN users u ON u.id=c.user_id
         WHERE c.game_id=$1 AND c.environment_id=$2 AND c.status IN ('visible','deleted')
         ORDER BY c.created_at DESC,c.id DESC LIMIT 100`, [id, config.environmentId])).rows;
    });
    return response(request, data);
  });
  const createComment = async (request: FastifyRequest, replyTo: boolean) => {
    const actor = await auth.user(request, "comment");
    const id = (request.params as { id: string }).id, content = cleanText((request.body as { content: string }).content);
    const data = await withTransaction(pool, async client => {
      await identity.assertActor(client, actor, "comment");
      let gameId = id, parentId: string | null = null;
      if (replyTo) {
        const parent = (await client.query("SELECT * FROM comments WHERE id=$1 AND environment_id=$2 FOR SHARE", [id, config.environmentId])).rows[0];
        if (!parent || parent.parent_id || !["visible", "deleted"].includes(parent.status)) throw new ApiError(409, "INVALID_REQUEST", "只能回复可见的一级评论");
        gameId = parent.game_id; parentId = parent.id;
      }
      await visible(client, gameId);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('comment'),hashtext($1))", [actor.userId]);
      const count = await client.query("SELECT count(*)::int AS n FROM comments WHERE user_id=$1 AND created_at>now()-interval '1 minute'", [actor.userId]);
      if (count.rows[0].n >= 5) throw new ApiError(429, "RATE_LIMITED", "评论过于频繁，请稍后重试");
      const status = /<\s*script|javascript:|data:text\/html/i.test(content) ? "pending" : "visible";
      return (await client.query(
        "INSERT INTO comments(id,environment_id,game_id,user_id,parent_id,content,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status,created_at",
        [randomUUID(), config.environmentId, gameId, actor.userId, parentId, content, status])).rows[0];
    });
    return response(request, data);
  };
  app.post("/api/v1/games/:id/comments", { schema: { params: idParams, body: commentBody, response: genericResponse } }, request => createComment(request, false));
  app.post("/api/v1/comments/:id/replies", { schema: { params: idParams, body: commentBody, response: genericResponse } }, request => createComment(request, true));
  app.delete("/api/v1/comments/:id", { schema: { params: idParams } }, async request => {
    const actor = await auth.user(request), id = (request.params as { id: string }).id;
    await withTransaction(pool, async client => {
      await identity.assertActor(client, actor);
      const result = await client.query("UPDATE comments SET status='deleted' WHERE id=$1 AND user_id=$2 AND environment_id=$3 RETURNING id", [id, actor.userId, config.environmentId]);
      if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", "评论不存在或不属于你");
    });
    return response(request, { deleted: true });
  });
  for (const [path, table] of [["like", "likes"], ["favorite", "favorites"]] as const) {
    for (const method of ["PUT", "DELETE"] as const) {
      app.route({ method, url: `/api/v1/games/:id/${path}`, schema: { params: idParams, response: genericResponse }, handler: async request => {
        const actor = await auth.user(request, "comment"), id = (request.params as { id: string }).id;
        const data = await withTransaction(pool, async client => {
          await identity.assertActor(client, actor, "comment");
          await visible(client, id);
          if (method === "PUT") await client.query(`INSERT INTO ${table}(environment_id,game_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [config.environmentId, id, actor.userId]);
          else await client.query(`DELETE FROM ${table} WHERE environment_id=$1 AND game_id=$2 AND user_id=$3`, [config.environmentId, id, actor.userId]);
          return { active: method === "PUT", count: (await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE environment_id=$1 AND game_id=$2`, [config.environmentId, id])).rows[0].n };
        });
        return response(request, data);
      } });
    }
  }
  app.get("/api/v1/me/favorites", {}, async request => {
    const actor = await auth.user(request);
    return response(request, (await pool.query(
      `SELECT g.id,g.title,g.category FROM favorites f JOIN games g ON g.id=f.game_id
       JOIN publication_heads h ON h.game_id=g.id AND h.environment_id=g.environment_id
       WHERE f.user_id=$1 AND f.environment_id=$2 AND NOT g.restricted AND g.deleted_at IS NULL
       ORDER BY f.created_at DESC LIMIT 100`, [actor.userId, config.environmentId])).rows);
  });
  app.get("/api/v1/admin/comments", {}, async request => {
    await auth.admin(request, ["reviewer"]);
    return response(request, (await pool.query("SELECT id,game_id,user_id,content,status,created_at FROM comments WHERE environment_id=$1 AND status IN ('pending','hidden') ORDER BY created_at LIMIT 100", [config.environmentId])).rows);
  });
  app.patch("/api/v1/admin/comments/:id", { schema: { params: idParams, body: {
    ...reasonBody, required: ["reason", "status"], properties: { ...reasonBody.properties, status: { type: "string", enum: ["visible", "hidden"] } },
  } } }, async request => {
    const actor = await auth.admin(request, ["reviewer"]), id = (request.params as { id: string }).id;
    const body = request.body as { status: string; reason: string };
    await withTransaction(pool, async client => {
      await identity.assertActor(client, actor);
      const result = await client.query("UPDATE comments SET status=$2,moderation_reason=$3 WHERE id=$1 AND environment_id=$4 AND status<>'deleted' RETURNING user_id",
        [id, body.status, body.reason, config.environmentId]);
      if (!result.rows[0]) throw new ApiError(404, "NOT_FOUND", "评论不存在");
      await audit(client, actor.generation, actor.userId, "comment_moderated", id, body);
      await notifyUser(client, config.environmentId, result.rows[0].user_id, `comment:${id}:${body.status}`, "comment.moderated", { commentId: id, status: body.status, reason: body.reason });
    });
    return response(request, { updated: true });
  });
  app.post("/api/v1/reports", { schema: { body: reportBody } }, async request => {
    const actor = await auth.user(request, "comment"), body = request.body as { objectType: "game" | "comment"; objectId: string; reason: string };
    const reason = cleanText(body.reason);
    const data = await withTransaction(pool, async client => {
      await identity.assertActor(client, actor, "comment");
      let gameId = body.objectId;
      if (body.objectType === "comment") {
        const comment = (await client.query("SELECT game_id FROM comments WHERE id=$1 AND environment_id=$2 AND status='visible'", [body.objectId, config.environmentId])).rows[0];
        if (!comment) throw new ApiError(404, "NOT_FOUND", "对象不存在");
        gameId = comment.game_id;
      }
      await visible(client, gameId);
      return (await client.query(
        `INSERT INTO reports(id,environment_id,user_id,object_type,object_id,reason,reason_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(environment_id,user_id,object_type,object_id,reason_digest)
         DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id,state`,
        [randomUUID(), config.environmentId, actor.userId, body.objectType, body.objectId, reason, hash(reason)])).rows[0];
    });
    return response(request, data);
  });
  const appeal = async (request: FastifyRequest, support: boolean) => {
    const actor = support ? await identity.authenticate(request, "support") : await auth.user(request);
    const body = request.body as { objectType: "account" | "game" | "report"; objectId: string; reason: string };
    const data = await withTransaction(pool, async client => {
      if (support) {
        const access = (await client.query("SELECT id,generation,expires_at FROM test_access_sessions WHERE id=$1", [actor.accessSessionId])).rows[0];
        if (!access) throw new ApiError(403, "TEST_ACCESS_REQUIRED", "请重新进入测试范围");
        await identity.assertAccess(client, access);
        const session = await client.query("SELECT id FROM account_sessions WHERE id=$1 AND user_id=$2 AND kind='support' AND revoked_at IS NULL AND expires_at>now() FOR SHARE", [actor.sessionId, actor.userId]);
        if (!session.rowCount) throw new ApiError(401, "AUTH_REQUIRED", "支持会话已失效");
      } else await identity.assertActor(client, actor);
      let owns = body.objectType === "account" && body.objectId === actor.userId;
      if (body.objectType === "game") owns = Boolean((await client.query("SELECT id FROM games WHERE id=$1 AND owner_id=$2 AND environment_id=$3", [body.objectId, actor.userId, config.environmentId])).rowCount);
      if (body.objectType === "report") owns = Boolean((await client.query("SELECT id FROM reports WHERE id=$1 AND user_id=$2 AND environment_id=$3", [body.objectId, actor.userId, config.environmentId])).rowCount);
      if (!owns) throw new ApiError(404, "NOT_FOUND", "对象不存在或不属于你");
      return (await client.query("INSERT INTO appeals(id,environment_id,user_id,object_type,object_id,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,state",
        [randomUUID(), config.environmentId, actor.userId, body.objectType, body.objectId, cleanText(body.reason)])).rows[0];
    });
    return response(request, data);
  };
  app.post("/api/v1/appeals", { schema: { body: appealBody } }, request => appeal(request, false));
  app.post("/api/v1/support/appeals", { schema: { body: appealBody } }, request => appeal(request, true));
  app.get("/api/v1/support/appeals",{},async request=>{
    const actor=await identity.authenticate(request,"support");
    return response(request,(await pool.query("SELECT id,object_type,object_id,reason,state,resolution,created_at FROM appeals WHERE user_id=$1 AND environment_id=$2 ORDER BY created_at DESC LIMIT 100",[actor.userId,config.environmentId])).rows);
  });
  for (const table of ["reports", "appeals"] as const) {
    app.get(`/api/v1/${table}/:id`, { schema: { params: idParams } }, async request => {
      const actor = await auth.user(request), id = (request.params as { id: string }).id;
      const found = await pool.query(`SELECT id,object_type,object_id,reason,state,resolution,created_at FROM ${table} WHERE id=$1 AND user_id=$2 AND environment_id=$3`, [id, actor.userId, config.environmentId]);
      if (!found.rows[0]) throw new ApiError(404, "NOT_FOUND", "记录不存在");
      return response(request, found.rows[0]);
    });
    app.get(`/api/v1/admin/${table}`, {}, async request => {
      await auth.admin(request, ["reviewer", "support"]);
      return response(request, (await pool.query(`SELECT id,user_id,object_type,object_id,reason,state,resolution,created_at FROM ${table} WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100`, [config.environmentId])).rows);
    });
    app.patch(`/api/v1/admin/${table}/:id`, { schema: { params: idParams, body: {
      ...reasonBody, required: ["reason", "state"], properties: { ...reasonBody.properties, state: { type: "string", enum: ["accepted", "resolved", "dismissed"] } },
    } } }, async request => {
      const actor = await auth.admin(request, ["reviewer", "support"]), id = (request.params as { id: string }).id, body = request.body as { state: string; reason: string };
      await withTransaction(pool, async client => {
        await identity.assertActor(client, actor);
        const row = (await client.query(`UPDATE ${table} SET state=$2,resolution=$3 WHERE id=$1 AND environment_id=$4 RETURNING user_id`, [id, body.state, cleanText(body.reason), config.environmentId])).rows[0];
        if (!row) throw new ApiError(404, "NOT_FOUND", "记录不存在");
        await audit(client, actor.generation, actor.userId, `${table}_processed`, id, body);
        await notifyUser(client, config.environmentId, row.user_id, `${table}:${id}:${body.state}`, `${table}.processed`, { id, state: body.state, reason: body.reason });
      });
      return response(request, { updated: true });
    });
  }
  app.get("/api/v1/notifications", {}, async request => {
    const actor = await auth.user(request);
    return response(request, (await pool.query("SELECT id,event_type,payload,read_at,created_at FROM notifications WHERE user_id=$1 AND environment_id=$2 ORDER BY created_at DESC LIMIT 100", [actor.userId, config.environmentId])).rows);
  });
  app.patch("/api/v1/notifications/:id", { schema: { params: idParams, body: {
    type: "object", additionalProperties: false, required: ["read"], properties: { read: { const: true } },
  } } }, async request => {
    const actor = await auth.user(request), id = (request.params as { id: string }).id;
    await withTransaction(pool, async client => {
      await identity.assertActor(client, actor);
      const result = await client.query("UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 AND environment_id=$3 RETURNING id", [id, actor.userId, config.environmentId]);
      if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", "消息不存在");
    });
    return response(request, { read: true });
  });

  const feedbackFor = async (request: FastifyRequest, id: string, admin = false) => {
    const access = admin ? null : await auth.access(request);
    if (admin) await auth.admin(request, ["reviewer", "support"]);
    const row = (await pool.query("SELECT * FROM test_feedback WHERE id=$1 AND environment_id=$2", [id, config.environmentId])).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", "反馈不存在");
    if (!admin && row.access_session_id !== access!.id) {
      let author = false;
      try {
        const actor = await auth.user(request);
        author = Boolean((await pool.query("SELECT id FROM games WHERE id=$1 AND owner_id=$2 AND environment_id=$3", [row.game_id, actor.userId, config.environmentId])).rowCount);
      } catch (error) { if (!(error instanceof ApiError)) throw error; }
      if (!author) throw new ApiError(404, "NOT_FOUND", "反馈不存在");
    }
    const { access_session_id: _access, ...safe } = row;
    return safe;
  };
  app.post("/api/v1/test-feedback", { schema: { body: feedbackBody } }, async request => {
    const access = await auth.access(request);
    const body = request.body as { gameId?: string; versionId?: string; playSessionId?: string; roomId?:string;taskId?:string;expected: string; actual: string; diagnostics?: object; attachmentIds?: string[] };
    if(body.roomId && body.taskId)throw new ApiError(400,"INVALID_REQUEST","一次反馈只能关联房间或任务");
    const data = await withTransaction(pool, async client => {
      await identity.assertAccess(client, access);
      let gameId = body.gameId ?? null, versionId = body.versionId ?? null,playSessionId=body.playSessionId??null,contextBound=false;
      if(body.roomId){
        const room=(await client.query(`SELECT r.game_id,r.version_id,m.play_session_id FROM rooms r
          JOIN room_members m ON m.room_id=r.id WHERE r.id=$1 AND r.environment_id=$2 AND r.generation=$3 AND m.access_session_id=$4`,
        [body.roomId,config.environmentId,access.generation,access.id])).rows[0];
        if(!room || (gameId && gameId!==room.game_id) || (versionId && versionId!==room.version_id) || (playSessionId && playSessionId!==room.play_session_id)){
          throw new ApiError(404,"NOT_FOUND","房间不属于当前测试会话或版本不一致");
        }
        gameId=room.game_id;versionId=room.version_id;playSessionId=room.play_session_id;contextBound=true;
      }
      if(body.taskId){
        const token=request.cookies[accountCookieName(config,"user")];
        if(!isToken(token))throw new ApiError(401,"AUTH_REQUIRED","任务反馈需要登录所属账号");
        const session=(await client.query(`SELECT s.id,s.user_id FROM account_sessions s JOIN users u ON u.id=s.user_id
          WHERE s.token_digest=$1 AND s.access_session_id=$2 AND s.environment_id=$3 AND s.generation=$4 AND s.kind='user'
            AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' FOR SHARE OF s,u`,
        [digest(config.tokenSecret,"account",token),access.id,config.environmentId,access.generation])).rows[0];
        if(!session)throw new ApiError(401,"AUTH_REQUIRED","账号会话已失效");
        await identity.assertActor(client,{userId:session.user_id,sessionId:session.id,accessSessionId:access.id,generation:access.generation,roles:[]});
        const task=(await client.query(`SELECT COALESCE(t.output_version_id,q.base_version_id) AS context_version_id,q.game_id
          FROM ai_tasks t JOIN ai_quotes q ON q.id=t.quote_id
          WHERE t.id=$1 AND t.user_id=$2 AND t.environment_id=$3 AND t.generation=$4`,
        [body.taskId,session.user_id,config.environmentId,access.generation])).rows[0];
        if(!task || (gameId && gameId!==task.game_id) || (versionId && versionId!==task.context_version_id) || playSessionId)throw new ApiError(404,"NOT_FOUND","任务不存在或关联版本不一致");
        gameId=task.game_id??null;versionId=task.context_version_id??null;contextBound=true;
      }
      if (playSessionId) {
        const play = (await client.query(
          "SELECT game_id,version_id FROM play_sessions WHERE id=$1 AND access_session_id=$2 AND environment_id=$3 AND generation=$4",
          [playSessionId, access.id, config.environmentId, access.generation])).rows[0];
        if (!play || (gameId && gameId !== play.game_id) || (versionId && versionId !== play.version_id)) throw new ApiError(404, "NOT_FOUND", "运行会话不存在");
        gameId = play.game_id; versionId = play.version_id;
      } else if (gameId && !contextBound) {
        await visible(client, gameId);
        const version = (await client.query("SELECT version_id FROM publication_heads WHERE game_id=$1 AND environment_id=$2", [gameId, config.environmentId])).rows[0];
        if (versionId && versionId !== version.version_id) throw new ApiError(403, "PERMISSION_DENIED", "请通过实际运行会话反馈其他版本");
        versionId = version.version_id;
      } else if (versionId && !contextBound) throw new ApiError(400, "INVALID_REQUEST", "版本必须关联游戏或运行会话");
      const id = randomUUID();
      await client.query(
        "INSERT INTO test_feedback(id,environment_id,generation,access_session_id,game_id,version_id,play_session_id,expected,actual,diagnostics,room_id,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [id, config.environmentId, access.generation, access.id, gameId, versionId, playSessionId, cleanText(body.expected), cleanText(body.actual), body.diagnostics ?? {},body.roomId??null,body.taskId??null]);
      for (const attachmentId of body.attachmentIds ?? []) {
        const result = await client.query(
          `UPDATE feedback_uploads SET feedback_id=$1,expires_at=now()+interval '30 days'
           WHERE id=$2 AND access_session_id=$3 AND environment_id=$4 AND generation=$5
             AND status='passed' AND expires_at>now() AND feedback_id IS NULL RETURNING id`,
          [id, attachmentId, access.id, config.environmentId, access.generation]);
        if (!result.rowCount) throw new ApiError(403, "PERMISSION_DENIED", "附件不可用或不属于当前测试会话");
      }
      return { id, state: "new" };
    });
    return response(request, data);
  });
  app.get("/api/v1/test-feedback", {}, async request => {
    const access = await auth.access(request);
    return response(request, (await pool.query("SELECT id,game_id,version_id,expected,actual,state,severity,fix_version_id,resolution,created_at FROM test_feedback WHERE access_session_id=$1 AND environment_id=$2 ORDER BY created_at DESC LIMIT 100", [access.id, config.environmentId])).rows);
  });
  app.get("/api/v1/test-feedback/:id", { schema: { params: idParams } }, async request => {
    const id = (request.params as { id: string }).id, row = await feedbackFor(request, id);
    const attachments = (await pool.query("SELECT id,mime,expected_size AS size,expires_at FROM feedback_uploads WHERE feedback_id=$1 AND status='passed'", [id])).rows;
    return response(request, { ...row, attachments });
  });
  app.post("/api/v1/test-feedback/:id/retests", { schema: { params: idParams, body: {
    type: "object", additionalProperties: false, required: ["resolved", "details"],
    properties: { resolved: { type: "boolean" }, details: { type: "string", minLength: 1, maxLength: 2000 } },
  } } }, async request => {
    const access = await auth.access(request), id = (request.params as { id: string }).id, body = request.body as { resolved: boolean; details: string };
    const state = await withTransaction(pool, async client => {
      await identity.assertAccess(client, access);
      const row = (await client.query("SELECT state FROM test_feedback WHERE id=$1 AND access_session_id=$2 AND environment_id=$3 FOR UPDATE", [id, access.id, config.environmentId])).rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND", "反馈不存在");
      if (row.state !== "awaiting_retest") throw new ApiError(409, "VERSION_CONFLICT", "当前反馈尚未进入待复测状态");
      const next = body.resolved ? "closed" : "in_progress";
      await client.query("UPDATE test_feedback SET state=$2,resolution=$3,updated_at=now() WHERE id=$1", [id, next, cleanText(body.details)]);
      await client.query("INSERT INTO test_feedback_events(id,feedback_id,actor,event_type,payload) VALUES($1,$2,$3,'retest',$4)", [randomUUID(), id, access.id, body]);
      return next;
    });
    return response(request, { state });
  });
  app.get("/api/v1/admin/test-feedback", {}, async request => {
    await auth.admin(request, ["reviewer", "support"]);
    return response(request, (await pool.query("SELECT id,game_id,version_id,expected,actual,state,severity,fix_version_id,created_at FROM test_feedback WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100", [config.environmentId])).rows);
  });
  app.get("/api/v1/admin/test-feedback/:id", { schema: { params: idParams } }, async request => {
    const id = (request.params as { id: string }).id, row = await feedbackFor(request, id, true);
    const attachments = (await pool.query("SELECT id,mime,expected_size AS size,expires_at FROM feedback_uploads WHERE feedback_id=$1 AND status='passed'", [id])).rows;
    return response(request, { ...row, attachments });
  });
  app.get("/api/v1/admin/test-feedback/uploads/:id/content", { schema: { params: idParams } }, async (request, reply) => {
    await auth.admin(request, ["reviewer", "support"]);
    const id = (request.params as { id: string }).id;
    const upload = (await pool.query(`SELECT u.mime,u.content FROM feedback_uploads u JOIN test_feedback f ON f.id=u.feedback_id
      WHERE u.id=$1 AND u.environment_id=$2 AND f.environment_id=$2 AND u.status='passed' AND u.expires_at>now()`, [id, config.environmentId])).rows[0];
    if (!upload) throw new ApiError(404, "NOT_FOUND", "附件不存在或已过期");
    reply.header("Content-Type", upload.mime).header("Content-Disposition", "attachment").header("X-Content-Type-Options", "nosniff");
    return reply.send(upload.content);
  });
  app.patch("/api/v1/admin/test-feedback/:id", { schema: { params: idParams, body: feedbackUpdateBody } }, async request => {
    const actor = await auth.admin(request, ["reviewer", "support"]), id = (request.params as { id: string }).id;
    const body = request.body as { state: string; severity?: string; reason: string; fixVersionId?: string };
    await withTransaction(pool, async client => {
      await identity.assertActor(client, actor);
      const feedback = (await client.query("SELECT * FROM test_feedback WHERE id=$1 AND environment_id=$2 FOR UPDATE", [id, config.environmentId])).rows[0];
      if (!feedback) throw new ApiError(404, "NOT_FOUND", "反馈不存在");
      if (body.fixVersionId) {
        const version = await client.query("SELECT id FROM game_versions WHERE id=$1 AND game_id=$2 AND deleted_at IS NULL", [body.fixVersionId, feedback.game_id]);
        if (!version.rowCount) throw new ApiError(409, "VERSION_CONFLICT", "修复版本必须属于对应游戏");
      }
      if (body.state === "awaiting_retest" && feedback.game_id && !body.fixVersionId && !feedback.fix_version_id) {
        throw new ApiError(409, "VERSION_CONFLICT", "游戏问题进入复测前必须关联修复版本");
      }
      await client.query("UPDATE test_feedback SET state=$2,severity=COALESCE($3,severity),resolution=$4,fix_version_id=COALESCE($5,fix_version_id),assigned_to=$6,updated_at=now() WHERE id=$1",
        [id, body.state, body.severity ?? null, cleanText(body.reason), body.fixVersionId ?? null, actor.userId]);
      await client.query("INSERT INTO test_feedback_events(id,feedback_id,actor,event_type,payload) VALUES($1,$2,$3,'processed',$4)", [randomUUID(), id, actor.userId, body]);
      await audit(client, actor.generation, actor.userId, "feedback_processed", id, body);
    });
    return response(request, { updated: true });
  });
  app.post("/api/v1/test-feedback/uploads", { schema: { body: uploadBody } }, async request => {
    const access = await auth.access(request), body = request.body as { mime: string; size: number; sha256: string };
    const id = randomUUID();
    await withTransaction(pool, async client => {
      await identity.assertAccess(client, access);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('feedback-upload'),hashtext($1))", [access.id]);
      const count = (await client.query("SELECT count(*)::int AS n FROM feedback_uploads WHERE access_session_id=$1 AND created_at>now()-interval '1 day'", [access.id])).rows[0].n;
      if (count >= 10) throw new ApiError(429, "RATE_LIMITED", "反馈附件已达到每日限额");
      await client.query("INSERT INTO feedback_uploads(id,environment_id,generation,access_session_id,mime,expected_size,expected_digest) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, config.environmentId, access.generation, access.id, body.mime, body.size, body.sha256]);
    });
    return response(request, { id, status: "pending", completeUrl: `/api/v1/test-feedback/uploads/${id}/complete` });
  });
  app.post("/api/v1/test-feedback/uploads/:id/complete", { bodyLimit: 7 * 1024 * 1024, schema: { params: idParams, body: {
    type: "object", additionalProperties: false, required: ["base64"], properties: { base64: { type: "string", maxLength: 6990508 } },
  } } }, async request => {
    const access = await auth.access(request), id = (request.params as { id: string }).id, encoded = (request.body as { base64: string }).base64;
    const content = Buffer.from(encoded, "base64");
    if (content.toString("base64") !== encoded || !content.length || content.length > 5242880) throw new ApiError(400, "INVALID_REQUEST", "附件编码或大小不正确");
    const result = await withTransaction(pool, async client => {
      await identity.assertAccess(client, access);
      const upload = (await client.query("SELECT * FROM feedback_uploads WHERE id=$1 AND access_session_id=$2 AND environment_id=$3 AND generation=$4 AND expires_at>now() FOR UPDATE", [id, access.id, config.environmentId, access.generation])).rows[0];
      if (!upload) throw new ApiError(404, "NOT_FOUND", "上传不存在");
      if (upload.status !== "pending") return { id, status: upload.status };
      const signature = upload.mime === "image/png"
        ? content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && content.subarray(-8, -4).toString() === "IEND"
        : upload.mime === "image/jpeg" ? content[0] === 255 && content[1] === 216 && content.at(-2) === 255 && content.at(-1) === 217
          : !content.includes(0) && Buffer.from(content.toString("utf8")).equals(content);
      const passed = signature && content.length === upload.expected_size && hash(content) === upload.expected_digest;
      await client.query("UPDATE feedback_uploads SET status=$2,content=$3,failure_reason=$4 WHERE id=$1",
        [id, passed ? "passed" : "failed", passed ? content : null, passed ? null : "摘要、大小或文件内容类型不匹配"]);
      return { id, status: passed ? "passed" : "failed" };
    });
    return response(request, result);
  });
  app.get("/api/v1/test-feedback/uploads/:id", { schema: { params: idParams } }, async request => {
    const access = await auth.access(request), id = (request.params as { id: string }).id;
    const row = (await pool.query("SELECT id,status,mime,expected_size AS size,failure_reason,expires_at FROM feedback_uploads WHERE id=$1 AND access_session_id=$2 AND environment_id=$3 AND generation=$4", [id, access.id, config.environmentId, access.generation])).rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", "上传不存在");
    return response(request, row);
  });
  app.get("/api/v1/test-feedback/uploads/:id/content", { schema: { params: idParams } }, async (request, reply) => {
    const access = await auth.access(request), id = (request.params as { id: string }).id;
    const upload = (await pool.query("SELECT * FROM feedback_uploads WHERE id=$1 AND environment_id=$2 AND status='passed' AND expires_at>now()", [id, config.environmentId])).rows[0];
    if (!upload) throw new ApiError(404, "NOT_FOUND", "附件不存在或已过期");
    if (upload.access_session_id !== access.id) {
      if (!upload.feedback_id) throw new ApiError(404, "NOT_FOUND", "附件不存在");
      await feedbackFor(request, upload.feedback_id);
    }
    reply.header("Content-Type", upload.mime).header("Content-Disposition", "attachment").header("X-Content-Type-Options", "nosniff");
    return reply.send(upload.content);
  });
}
