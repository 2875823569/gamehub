import { randomUUID } from "node:crypto";
import type { FastifyRequest, HTTPMethods } from "fastify";
import type { PoolClient } from "pg";
import { catalogIdParams, catalogResponse, gameCreateBody } from "../../packages/contracts/catalog";
import type { PlatformModuleContext, PlatformActor } from "./platform-auth";
import { withTransaction } from "./db";
import { ApiError } from "./errors";
import { getOwnedGame, insertCandidate, publishVersion, catalogEvent } from "./catalog-store";
import { buildExport, getObject, MAX_ARCHIVE, putObject, sha256 } from "./artifact-files";
import { createPlaySession, validPlaySession } from "./play-store";
import { digest, newToken } from "./tokens";
import { runArtifactJob } from "./artifact-worker";
import { IdentityService } from "./identity-store";
import { reserveUploadQuota,artifactLimits } from "./artifact-quota";

const object = (properties:Record<string,unknown>,required:string[]=[]) => ({type:"object",additionalProperties:false,properties,required});
const text = (max=2000) => ({type:"string",minLength:1,maxLength:max});
const uuid = {type:"string",format:"uuid"};
const revision = {type:"integer",minimum:0};
const idBody = (name:string) => object({[name]:uuid},[name]);
const body = (request:FastifyRequest) => request.body as Record<string,any>;
const params = (request:FastifyRequest) => request.params as {id:string};
const keyFor=(request:FastifyRequest)=>{
  const key=request.headers["idempotency-key"];
  if(typeof key!=="string" || !/^[A-Za-z0-9_-]{8,100}$/.test(key))throw new ApiError(400,"INVALID_REQUEST","请提供有效 Idempotency-Key");
  return key;
};

export async function registerCatalogModule({app,config,pool,auth}:PlatformModuleContext) {
  const identityService=new IdentityService(pool,config);
  const replyData=(request:FastifyRequest,data:unknown)=>({data,requestId:request.id});
  const route=(method:HTTPMethods,url:string,schema:Record<string,unknown>,handler:(request:FastifyRequest)=>Promise<unknown>)=>{
    app.route({method,url,bodyLimit:url.includes("/workspace")?110000:8192,schema:{...(url.includes(":id")?{params:catalogIdParams}:{}),...schema,response:{200:catalogResponse}},
      handler:async request=>replyData(request,await handler(request))});
  };
  const audit=async(client:PoolClient,actor:PlatformActor,action:string,id:string,requestId:string)=>{
    await client.query("INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id,request_id)VALUES($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(),config.environmentId,actor.generation,actor.userId,action,id,requestId]);
  };
  const actorLock=async(client:PoolClient,actor:PlatformActor,capability="create")=>{
    await identityService.assertActor(client,actor,["create","submit","comment","billing"].includes(capability)?capability as "create"|"submit"|"comment"|"billing":undefined);
  };
  const reviewerLock=async(client:PoolClient,actor:PlatformActor)=>{
    await actorLock(client,actor,"submit");
    const role=await client.query("SELECT role FROM role_assignments WHERE user_id=$1 AND role IN ('super_admin','reviewer') FOR SHARE",[actor.userId]);
    if(!role.rowCount)throw new ApiError(403,"PERMISSION_DENIED","审核角色已撤销");
  };
  const ownedVersion=async(client:PoolClient,actor:PlatformActor,id:string)=>{
    const version=(await client.query(`SELECT v.*,g.owner_id,g.environment_id,g.restricted,g.deleted_at AS game_deleted
      FROM game_versions v JOIN games g ON g.id=v.game_id WHERE v.id=$1 AND g.owner_id=$2 AND g.environment_id=$3`,
      [id,actor.userId,config.environmentId])).rows[0];
    if(!version)throw new ApiError(404,"NOT_FOUND","版本不存在");
    return version;
  };
  const jobFor=async(client:PoolClient,actor:PlatformActor,id:string)=>{
    const job=(await client.query("SELECT * FROM artifact_jobs WHERE id=$1 AND owner_id=$2 AND environment_id=$3 AND generation=$4",
      [id,actor.userId,config.environmentId,actor.generation])).rows[0];
    if(!job)throw new ApiError(404,"NOT_FOUND","文件任务不存在");
    return job;
  };

  route("GET","/api/v1/games",{querystring:object({q:{type:"string",maxLength:100},category:{type:"string",maxLength:32},
    cursor:uuid,limit:{type:"string",pattern:"^(?:[1-9]|[1-9][0-9]|100)$"}})},async request=>{
    await auth.access(request);const query=request.query as Record<string,string>;
    const rows=(await pool.query(`SELECT g.id,g.official_key,g.title,g.description,g.category,h.version_id,v.manifest
      FROM games g JOIN publication_heads h ON h.game_id=g.id JOIN game_versions v ON v.id=h.version_id
      WHERE g.environment_id=$1 AND h.environment_id=$1 AND NOT g.restricted AND g.deleted_at IS NULL
        AND h.scope='internal_catalog' AND ($2::text IS NULL OR g.title ILIKE '%'||$2||'%')
        AND ($3::text IS NULL OR g.category=$3) AND ($4::uuid IS NULL OR g.id>$4)
      ORDER BY g.id LIMIT $5`,[config.environmentId,query.q??null,query.category??null,query.cursor??null,Number(query.limit??20)+1])).rows;
    const limit=Number(query.limit??20),more=rows.length>limit; const items=rows.slice(0,limit);
    return {items,nextCursor:more?items.at(-1)?.id:null};
  });
  route("GET","/api/v1/games/:id",{},async request=>{
    await auth.access(request);
    const row=(await pool.query(`SELECT g.id,g.title,g.description,g.category,g.official_key,g.status,g.restricted,g.owner_id,
      h.version_id,v.manifest FROM games g LEFT JOIN publication_heads h ON h.game_id=g.id AND h.scope='internal_catalog'
      LEFT JOIN game_versions v ON v.id=h.version_id WHERE g.id=$1 AND g.environment_id=$2 AND g.deleted_at IS NULL`,
      [params(request).id,config.environmentId])).rows[0];
    if(!row || (!row.version_id && row.status==="draft"))throw new ApiError(404,"NOT_FOUND","游戏不存在");
    return {...row,available:Boolean(row.version_id && !row.restricted)};
  });
  route("POST","/api/v1/creator/games",{body:gameCreateBody},async request=>{
    const actor=await auth.user(request,"create"),input=body(request);
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);
      const id=randomUUID(),projectId=randomUUID();
      await client.query("INSERT INTO games(id,environment_id,owner_id,title,description,category)VALUES($1,$2,$3,$4,$5,$6)",
        [id,config.environmentId,actor.userId,input.title.trim(),input.description??"",input.category??"其他"]);
      await client.query("INSERT INTO projects(id,game_id,owner_id)VALUES($1,$2,$3)",[projectId,id,actor.userId]);
      await audit(client,actor,"game_created",id,request.id);
      return {id,projectId,title:input.title,workspaceRevision:0};
    });
  });
  route("GET","/api/v1/creator/games",{},async request=>{
    const actor=await auth.user(request);
    return {items:(await pool.query(`SELECT g.*,p.id AS project_id,p.workspace_revision FROM games g JOIN projects p ON p.game_id=g.id
      WHERE g.environment_id=$1 AND g.owner_id=$2 ORDER BY g.created_at DESC LIMIT 100`,[config.environmentId,actor.userId])).rows};
  });
  route("POST","/api/v1/creator/uploads",{body:object({size:{type:"integer",minimum:1,maximum:MAX_ARCHIVE},sha256:{type:"string",pattern:"^[a-f0-9]{64}$"},purpose:{enum:["game-package"]}},["size","sha256","purpose"])},async request=>{
    const actor=await auth.user(request,"create"),input=body(request),id=randomUUID();
    const quota=await withTransaction(pool,async client=>{
      await actorLock(client,actor);
      const quota=await reserveUploadQuota(client,config.environmentId,actor.userId,input.size);
      await client.query("INSERT INTO artifact_uploads(id,environment_id,generation,owner_id,expected_size,expected_digest)VALUES($1,$2,$3,$4,$5,$6)",
        [id,config.environmentId,actor.generation,actor.userId,input.size,input.sha256]);
      return quota;
    });
    return {id,uploadUrl:`/api/v1/creator/uploads/${id}/content`,method:"PUT",contentType:"application/octet-stream",...quota};
  });
  const receiving=new WeakMap<FastifyRequest,{id:string;token:string}>();
  const releaseReceiving=async(request:FastifyRequest)=>{
    const lease=receiving.get(request);if(!lease)return;
    receiving.delete(request);
    await pool.query("UPDATE artifact_uploads SET receiving_token=NULL,receiving_until=NULL WHERE id=$1 AND receiving_token=$2",[lease.id,lease.token]);
  };
  if(!app.hasContentTypeParser("application/octet-stream"))app.addContentTypeParser("application/octet-stream",{parseAs:"buffer"},(_request,payload,done)=>done(null,payload));
  app.put("/api/v1/creator/uploads/:id/content",{
    bodyLimit:MAX_ARCHIVE,schema:{params:catalogIdParams,response:{200:catalogResponse}},
    onRequest:async request=>{
      const actor=await auth.user(request,"create"),id=params(request).id,token=randomUUID();
      if(!/^[0-9a-f-]{36}$/i.test(id))throw new ApiError(400,"INVALID_REQUEST","上传标识无效");
      await withTransaction(pool,async client=>{
        await actorLock(client,actor);
        const row=(await client.query(`UPDATE artifact_uploads SET receiving_token=$5,
            receiving_until=now()+($6::int*interval '1 second'),content_started_at=COALESCE(content_started_at,now())
          WHERE id=$1 AND owner_id=$2 AND environment_id=$3 AND generation=$4 AND expires_at>now()
            AND storage_released_at IS NULL AND status IN('pending','uploaded')
            AND (receiving_until IS NULL OR receiving_until<=now()) RETURNING expected_size`,
          [id,actor.userId,config.environmentId,actor.generation,token,artifactLimits.receivingSeconds])).rows[0];
        if(!row)throw new ApiError(409,"VERSION_CONFLICT","上传不存在、正在接收、已过期或已开始检查");
        const length=request.headers["content-length"];
        if(length!==undefined && Number(length)!==row.expected_size)throw new ApiError(422,"PACKAGE_UNSUPPORTED","上传大小与预留不符");
      });
      receiving.set(request,{id,token});
    },
    onError:async request=>{await releaseReceiving(request);},
    onResponse:async request=>{await releaseReceiving(request);},
  },async(request)=>{
    const actor=await auth.user(request,"create"),id=params(request).id;
    if(!Buffer.isBuffer(request.body))throw new ApiError(400,"INVALID_REQUEST","上传内容必须为二进制 ZIP");
    const bytes=request.body;
    const upload=(await pool.query("SELECT * FROM artifact_uploads WHERE id=$1 AND owner_id=$2 AND environment_id=$3 AND generation=$4 AND expires_at>now()",
      [id,actor.userId,config.environmentId,actor.generation])).rows[0];
    if(!upload)throw new ApiError(404,"NOT_FOUND","上传请求不存在或已过期");
    if(upload.expected_size!==bytes.length || upload.expected_digest!==sha256(bytes))throw new ApiError(422,"PACKAGE_UNSUPPORTED","上传大小或摘要不匹配");
    const stored=await putObject(config,bytes);
    await withTransaction(pool,async client=>{
      await actorLock(client,actor);
      const changed=await client.query(`UPDATE artifact_uploads SET object_digest=$2,status='uploaded',receiving_token=NULL,receiving_until=NULL
        WHERE id=$1 AND status IN ('pending','uploaded') AND receiving_token=$3 AND receiving_until>now() AND expires_at>now()
          AND storage_released_at IS NULL`,[id,stored,receiving.get(request)?.token]);
      if(!changed.rowCount)throw new ApiError(409,"VERSION_CONFLICT","上传已开始检查，不可替换");
    });
    return replyData(request,{id,status:"uploaded"});
  });
  route("POST","/api/v1/creator/uploads/:id/complete",{body:object({})},async request=>{
    const actor=await auth.user(request,"create"),id=params(request).id;
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);
      const upload=(await client.query("SELECT * FROM artifact_uploads WHERE id=$1 AND owner_id=$2 AND environment_id=$3 AND generation=$4 AND expires_at>now() FOR UPDATE",
        [id,actor.userId,config.environmentId,actor.generation])).rows[0];
      if(!upload)throw new ApiError(404,"NOT_FOUND","上传不存在");
      const old=(await client.query("SELECT id,status FROM artifact_jobs WHERE input_id=$1 AND kind='scan'",[id])).rows[0];
      if(old)return {jobId:old.id,status:old.status};
      if(upload.status!=="uploaded")throw new ApiError(409,"VERSION_CONFLICT","文件尚未完整上传");
      const jobId=randomUUID();
      await client.query("INSERT INTO artifact_jobs(id,environment_id,generation,owner_id,kind,input_id,status)VALUES($1,$2,$3,$4,'scan',$5,'queued')",
        [jobId,config.environmentId,actor.generation,actor.userId,id]);
      await client.query("UPDATE artifact_uploads SET status='checking' WHERE id=$1",[id]);
      return {jobId,status:"queued"};
    });
  });
  route("GET","/api/v1/creator/uploads/:id",{},async request=>{
    const actor=await auth.user(request);
    const row=(await pool.query(`SELECT u.id,u.status,u.failure_reason,u.manifest,j.id AS job_id FROM artifact_uploads u
      LEFT JOIN artifact_jobs j ON j.input_id=u.id AND j.kind='scan' WHERE u.id=$1 AND u.owner_id=$2 AND u.environment_id=$3 AND u.generation=$4`,
      [params(request).id,actor.userId,config.environmentId,actor.generation])).rows[0];
    if(!row)throw new ApiError(404,"NOT_FOUND","上传不存在");return row;
  });
  route("GET","/api/v1/creator/artifact-jobs/:id",{},async request=>{
    const actor=await auth.user(request);
    return withTransaction(pool,async client=>{
      const job=await jobFor(client,actor,params(request).id);
      return {id:job.id,kind:job.kind,status:new Date(job.expires_at)<new Date()?"expired":job.status,failureReason:job.failure_reason,expiresAt:job.expires_at};
    });
  });
  route("GET","/api/v1/creator/artifact-jobs",{},async request=>{
    const actor=await auth.user(request);
    return {items:(await pool.query(`SELECT id,kind,input_id AS "inputId",
      CASE WHEN expires_at<now() THEN 'expired' ELSE status END AS status,
      failure_reason AS "failureReason",expires_at AS "expiresAt",created_at AS "createdAt"
      FROM artifact_jobs WHERE owner_id=$1 AND environment_id=$2 AND generation=$3 ORDER BY created_at DESC LIMIT 100`,
      [actor.userId,config.environmentId,actor.generation])).rows};
  });
  route("GET","/api/v1/creator/uploads",{},async request=>{
    const actor=await auth.user(request);
    return {items:(await pool.query(`SELECT id,status,failure_reason,manifest,expires_at,created_at FROM artifact_uploads
      WHERE owner_id=$1 AND environment_id=$2 AND generation=$3 ORDER BY created_at DESC LIMIT 100`,
      [actor.userId,config.environmentId,actor.generation])).rows};
  });
  route("POST","/api/v1/creator/games/:id/versions",{body:idBody("uploadId")},async request=>{
    const actor=await auth.user(request,"create");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);
      const game=await getOwnedGame(client,config.environmentId,actor.userId,params(request).id);
      if(game.deleted_at || game.archived_at || game.restricted)throw new ApiError(409,"GAME_UNAVAILABLE","作品当前不可编辑");
      const upload=(await client.query("SELECT * FROM artifact_uploads WHERE id=$1 AND owner_id=$2 AND environment_id=$3 AND generation=$4 AND status='passed' AND expires_at>now()",
        [body(request).uploadId,actor.userId,config.environmentId,actor.generation])).rows[0];
      if(!upload)throw new ApiError(409,"PACKAGE_UNSUPPORTED","上传未通过检查或无权使用");
      return insertCandidate(client,game.id,{manifest:upload.manifest,files:upload.files,contentDigest:sha256(JSON.stringify({manifest:upload.manifest,files:upload.files}))},"upload");
    });
  });
  route("GET","/api/v1/creator/games/:id/versions",{},async request=>{
    const actor=await auth.user(request);
    return withTransaction(pool,async client=>{
      await getOwnedGame(client,config.environmentId,actor.userId,params(request).id);
      return {items:(await client.query(`SELECT v.id,v.number,v.manifest,v.source,v.source_label,v.review_status,v.check_status,v.check_evidence,v.deleted_at,v.created_at,
        (SELECT r.id FROM review_submissions r WHERE r.version_id=v.id AND r.status IN ('pending','reviewing') ORDER BY r.created_at DESC LIMIT 1) AS submission_id
        FROM game_versions v WHERE v.game_id=$1 ORDER BY v.number DESC LIMIT 100`,[params(request).id])).rows};
    });
  });
  route("GET","/api/v1/creator/versions/:id",{},async request=>{
    const actor=await auth.user(request);
    return withTransaction(pool,client=>ownedVersion(client,actor,params(request).id));
  });
  route("POST","/api/v1/creator/versions/:id/preview-sessions",{body:object({})},async request=>{
    const actor=await auth.user(request,"create");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);
      const version=await ownedVersion(client,actor,params(request).id);
      return createPlaySession(client,config,{accessSessionId:actor.accessSessionId,userId:actor.userId,accountSessionId:actor.sessionId,generation:actor.generation,
        gameId:version.game_id,versionId:version.id,scope:"preview"});
    });
  });
  route("POST","/api/v1/games/:id/play-sessions",{body:object({})},async request=>{
    let actor:PlatformActor|undefined;
    try{actor=await auth.user(request);}catch(error){if(!(error instanceof ApiError && error.code==="AUTH_REQUIRED"))throw error;}
    const access=actor?{id:actor.accessSessionId,generation:actor.generation}:await auth.access(request);
    return withTransaction(pool,async client=>{
      const head=(await client.query("SELECT version_id FROM publication_heads WHERE game_id=$1 AND environment_id=$2 AND scope='internal_catalog'",[params(request).id,config.environmentId])).rows[0];
      if(!head)throw new ApiError(409,"GAME_UNAVAILABLE","游戏不可启动");
      return createPlaySession(client,config,{accessSessionId:access.id,userId:actor?.userId,accountSessionId:actor?.sessionId,generation:access.generation,
        gameId:params(request).id,versionId:head.version_id,scope:"internal_catalog"});
    });
  });
  route("GET","/api/v1/play-sessions/:id",{},async request=>{
    const access=await auth.access(request);
    return withTransaction(pool,async client=>{
      const session=await validPlaySession(client,config,params(request).id,access.id);
      return {id:session.id,gameId:session.game_id,versionId:session.version_id,expiresAt:session.expires_at,scope:session.scope,manifest:session.manifest};
    });
  });
  route("POST","/api/v1/creator/versions/:id/submissions",{body:object({publishOnApproval:{type:"boolean"}},["publishOnApproval"])},async request=>{
    const actor=await auth.user(request,"submit"),key=keyFor(request),id=params(request).id,input=body(request);
    return withTransaction(pool,async client=>{
      await actorLock(client,actor,"submit");
      const version=await ownedVersion(client,actor,id);
      await getOwnedGame(client,config.environmentId,actor.userId,version.game_id);
      const requestDigest=sha256(JSON.stringify({id,...input}));
      const old=(await client.query("SELECT * FROM review_submissions WHERE submitter_id=$1 AND idempotency_key=$2",[actor.userId,key])).rows[0];
      if(old){if(old.request_digest!==requestDigest)throw new ApiError(409,"VERSION_CONFLICT","幂等键用于不同送审内容");return old;}
      if(version.deleted_at || version.game_deleted || version.restricted || !version.previewed_at ||
        version.check_status!=="passed" || !["draft","rejected","withdrawn"].includes(version.review_status))throw new ApiError(409,"GAME_UNAVAILABLE","请先完成有效版本预览，且版本须可送审");
      const active=(await client.query("SELECT id FROM review_submissions WHERE game_id=$1 AND status IN ('pending','reviewing')",[version.game_id])).rows[0];
      if(active)throw new ApiError(409,"VERSION_CONFLICT","作品已有待处理审核");
      const count=(await client.query("SELECT count(*)::int AS n FROM review_submissions WHERE submitter_id=$1 AND created_at>date_trunc('day',now())",[actor.userId])).rows[0].n;
      if(count>=5)throw new ApiError(429,"RATE_LIMITED","今日送审次数已用完");
      const submissionId=randomUUID();
      await client.query(`INSERT INTO review_submissions(id,game_id,version_id,submitter_id,status,publish_on_approval,idempotency_key,request_digest)
        VALUES($1,$2,$3,$4,'pending',$5,$6,$7)`,[submissionId,version.game_id,id,actor.userId,input.publishOnApproval,key,requestDigest]);
      await client.query("UPDATE game_versions SET review_status='pending' WHERE id=$1",[id]);
      await audit(client,actor,"version_submitted",id,request.id);
      return {id:submissionId,status:"pending"};
    });
  });
  route("POST","/api/v1/creator/submissions/:id/withdraw",{body:object({})},async request=>{
    const actor=await auth.user(request,"submit");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor,"submit");
      const row=(await client.query(`SELECT r.* FROM review_submissions r JOIN games g ON g.id=r.game_id
        WHERE r.id=$1 AND r.submitter_id=$2 AND g.environment_id=$3 FOR UPDATE OF r`,[params(request).id,actor.userId,config.environmentId])).rows[0];
      if(!row)throw new ApiError(404,"NOT_FOUND","审核申请不存在");
      if(!["pending","reviewing"].includes(row.status))throw new ApiError(409,"VERSION_CONFLICT","审核已完成，不能撤回");
      await client.query("UPDATE review_submissions SET status='withdrawn',updated_at=now() WHERE id=$1",[row.id]);
      await client.query("UPDATE game_versions SET review_status='withdrawn' WHERE id=$1",[row.version_id]);
      return {id:row.id,status:"withdrawn"};
    });
  });
  route("GET","/api/v1/admin/reviews",{},async request=>{
    await auth.admin(request,["super_admin","reviewer"]);
    return {items:(await pool.query(`SELECT r.*,g.title,v.manifest,v.content_digest,v.check_evidence FROM review_submissions r
      JOIN games g ON g.id=r.game_id JOIN game_versions v ON v.id=r.version_id WHERE g.environment_id=$1
      ORDER BY r.created_at DESC LIMIT 100`,[config.environmentId])).rows};
  });
  route("POST","/api/v1/admin/reviews/:id/claim",{body:object({})},async request=>{
    const actor=await auth.admin(request,["super_admin","reviewer"]);
    return withTransaction(pool,async client=>{
      await reviewerLock(client,actor);
      const row=(await client.query(`UPDATE review_submissions r SET status='reviewing',reviewer_id=$2,updated_at=now()
        FROM games g WHERE r.id=$1 AND g.id=r.game_id AND g.environment_id=$3 AND r.status='pending' RETURNING r.*`,
        [params(request).id,actor.userId,config.environmentId])).rows[0];
      if(!row)throw new ApiError(409,"VERSION_CONFLICT","审核已被领取或已完成");
      await client.query("UPDATE game_versions SET review_status='reviewing' WHERE id=$1",[row.version_id]);
      return row;
    });
  });
  route("POST","/api/v1/admin/reviews/:id/preview-sessions",{body:object({})},async request=>{
    const actor=await auth.admin(request,["super_admin","reviewer"]);
    return withTransaction(pool,async client=>{
      await reviewerLock(client,actor);
      const row=(await client.query(`SELECT r.* FROM review_submissions r JOIN games g ON g.id=r.game_id
        WHERE r.id=$1 AND g.environment_id=$2 AND r.status='reviewing' AND r.reviewer_id=$3`,[params(request).id,config.environmentId,actor.userId])).rows[0];
      if(!row)throw new ApiError(403,"PERMISSION_DENIED","请先领取审核");
      return createPlaySession(client,config,{accessSessionId:actor.accessSessionId,userId:actor.userId,accountSessionId:actor.sessionId,generation:actor.generation,
        gameId:row.game_id,versionId:row.version_id,scope:"preview"});
    });
  });
  route("POST","/api/v1/admin/reviews/:id/decision",{body:object({decision:{enum:["approved","rejected"]},reason:text(2000),previewConfirmed:{type:"boolean"}},["decision","reason","previewConfirmed"])},async request=>{
    const actor=await auth.admin(request,["super_admin","reviewer"]),input=body(request);
    return withTransaction(pool,async client=>{
      await reviewerLock(client,actor);
      const row=(await client.query(`SELECT r.* FROM review_submissions r JOIN games g ON g.id=r.game_id
        WHERE r.id=$1 AND g.environment_id=$2 FOR UPDATE OF r`,[params(request).id,config.environmentId])).rows[0];
      if(!row || row.status!=="reviewing" || row.reviewer_id!==actor.userId)throw new ApiError(409,"VERSION_CONFLICT","审核状态已改变");
      if(input.decision==="approved"){
        const preview=(await client.query(`SELECT 1 FROM play_sessions WHERE version_id=$1 AND user_id=$2 AND scope='preview'
          AND generation=$3 AND account_session_id=$4 AND revoked_at IS NULL AND expires_at>now()`,
          [row.version_id,actor.userId,actor.generation,actor.sessionId])).rows[0];
        if(!input.previewConfirmed || !preview)throw new ApiError(409,"VERSION_CONFLICT","审核员须完成隔离预览并确认");
      }
      await client.query("UPDATE review_submissions SET status=$2,reason=$3,updated_at=now() WHERE id=$1",[row.id,input.decision,input.reason]);
      await client.query("UPDATE game_versions SET review_status=$2 WHERE id=$1",[row.version_id,input.decision]);
      let published=false;
      if(input.decision==="approved" && row.publish_on_approval){
        const owner=(await client.query(`SELECT g.restricted,g.archived_at,g.deleted_at,u.status,
          EXISTS(SELECT 1 FROM account_restrictions r WHERE r.user_id=u.id AND r.released_at IS NULL
           AND (r.expires_at IS NULL OR r.expires_at>now()) AND r.capability IN ('all','submit')) AS blocked
          FROM games g JOIN users u ON u.id=g.owner_id WHERE g.id=$1 FOR UPDATE OF g`,[row.game_id])).rows[0];
        if(owner && owner.status==="active" && !owner.blocked && !owner.restricted && !owner.archived_at && !owner.deleted_at){
          await publishVersion(client,config.environmentId,actor.userId,row.game_id,row.version_id,"审核批准");published=true;
        }
      }
      await audit(client,actor,`review_${input.decision}`,row.id,request.id);
      await catalogEvent(client,config.environmentId,row.submitter_id,`review:${row.id}:${input.decision}`,
        `review.${input.decision}`,{gameId:row.game_id,versionId:row.version_id,reason:input.reason,published});
      return {id:row.id,status:input.decision,published};
    });
  });
  route("POST","/api/v1/creator/games/:id/releases",{body:object({versionId:uuid,reason:text(500)},["versionId","reason"])},async request=>{
    const actor=await auth.user(request,"submit");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor,"submit");await getOwnedGame(client,config.environmentId,actor.userId,params(request).id);
      await publishVersion(client,config.environmentId,actor.userId,params(request).id,body(request).versionId,body(request).reason);
      await audit(client,actor,"game_released",params(request).id,request.id);return {published:true,versionId:body(request).versionId};
    });
  });
  route("POST","/api/v1/creator/games/:id/unpublish",{body:object({})},async request=>{
    const actor=await auth.user(request,"submit");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor,"submit");const game=await getOwnedGame(client,config.environmentId,actor.userId,params(request).id);
      await client.query("DELETE FROM publication_heads WHERE game_id=$1 AND environment_id=$2",[game.id,config.environmentId]);
      await client.query("UPDATE games SET status=CASE WHEN restricted THEN 'restricted' ELSE 'unpublished' END,current_version_id=NULL,updated_at=now() WHERE id=$1",[game.id]);
      await audit(client,actor,"game_unpublished",game.id,request.id);return {unpublished:true};
    });
  });
  route("POST","/api/v1/admin/games/:id/restrictions",{body:object({restricted:{type:"boolean"},reason:text(2000)},["restricted","reason"])},async request=>{
    const actor=await auth.admin(request,["super_admin","reviewer"]),input=body(request);
    return withTransaction(pool,async client=>{
      await reviewerLock(client,actor);
      const row=(await client.query(`UPDATE games SET restricted=$3,restriction_reason=$4,status=CASE WHEN $3 THEN 'restricted' ELSE 'unpublished' END,
        current_version_id=NULL,updated_at=now() WHERE id=$1 AND environment_id=$2 RETURNING id`,
        [params(request).id,config.environmentId,input.restricted,input.reason])).rows[0];
      if(!row)throw new ApiError(404,"NOT_FOUND","作品不存在");
      await client.query("DELETE FROM publication_heads WHERE game_id=$1",[row.id]);
      if(input.restricted)await client.query("UPDATE play_sessions SET revoked_at=now() WHERE game_id=$1 AND revoked_at IS NULL",[row.id]);
      await audit(client,actor,input.restricted?"game_restricted":"game_restriction_released",row.id,request.id);
      const owner=(await client.query("SELECT owner_id FROM games WHERE id=$1",[row.id])).rows[0];
      await catalogEvent(client,config.environmentId,owner.owner_id,`restriction:${request.id}`,input.restricted?"game.restricted":"game.restriction_released",
        {gameId:row.id,reason:input.reason});
      return {restricted:input.restricted};
    });
  });
  route("GET","/api/v1/creator/projects/:id/workspace",{},async request=>{
    const actor=await auth.user(request);
    const row=(await pool.query(`SELECT p.* FROM projects p JOIN games g ON g.id=p.game_id WHERE p.id=$1 AND p.owner_id=$2 AND g.environment_id=$3`,
      [params(request).id,actor.userId,config.environmentId])).rows[0];
    if(!row)throw new ApiError(404,"NOT_FOUND","工程不存在");
    return {id:row.id,gameId:row.game_id,workspaceRevision:row.workspace_revision,baseVersionId:row.base_version_id,draft:row.draft};
  });
  const saveWorkspace=async(request:FastifyRequest,restore=false)=>{
    const actor=await auth.user(request,"create"),input=body(request);
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);
      const project=(await client.query(`SELECT p.*,g.restricted,g.deleted_at,g.archived_at FROM projects p JOIN games g ON g.id=p.game_id
        WHERE p.id=$1 AND p.owner_id=$2 AND g.environment_id=$3 FOR UPDATE OF p,g`,[params(request).id,actor.userId,config.environmentId])).rows[0];
      if(!project)throw new ApiError(404,"NOT_FOUND","工程不存在");
      if(project.restricted || project.deleted_at || project.archived_at)throw new ApiError(409,"GAME_UNAVAILABLE","工程不可修改");
      if(project.workspace_revision!==input.expectedRevision)throw new ApiError(409,"VERSION_CONFLICT","草稿已被其他页面修改");
      let draft=input.draft??project.draft,baseVersionId=input.baseVersionId===undefined?project.base_version_id:input.baseVersionId;
      if(restore){
        const snap=(await client.query("SELECT * FROM draft_snapshots WHERE id=$1 AND project_id=$2",[input.snapshotId,project.id])).rows[0];
        if(!snap)throw new ApiError(404,"NOT_FOUND","草稿快照不存在");draft=snap.draft;baseVersionId=snap.base_version_id;
      }
      if(Buffer.byteLength(JSON.stringify(draft))>102400)throw new ApiError(413,"PAYLOAD_TOO_LARGE","草稿超过 100 KiB");
      if(baseVersionId && !(await client.query("SELECT 1 FROM game_versions WHERE id=$1 AND game_id=$2 AND deleted_at IS NULL",[baseVersionId,project.game_id])).rows[0]){
        throw new ApiError(409,"VERSION_CONFLICT","基线版本不可用");
      }
      await client.query("INSERT INTO draft_snapshots(id,project_id,revision,base_version_id,draft)VALUES($1,$2,$3,$4,$5)",
        [randomUUID(),project.id,project.workspace_revision,project.base_version_id,project.draft]);
      await client.query("UPDATE projects SET workspace_revision=workspace_revision+1,draft=$2,base_version_id=$3,updated_at=now() WHERE id=$1",[project.id,draft,baseVersionId]);
      return {id:project.id,workspaceRevision:project.workspace_revision+1,draft,baseVersionId};
    });
  };
  route("PATCH","/api/v1/creator/projects/:id/workspace",{body:object({expectedRevision:revision,draft:{type:"object",additionalProperties:true},baseVersionId:{anyOf:[uuid,{type:"null"}]}},["expectedRevision"])},request=>saveWorkspace(request));
  route("POST","/api/v1/creator/projects/:id/draft-restores",{body:object({expectedRevision:revision,snapshotId:uuid},["expectedRevision","snapshotId"])},request=>saveWorkspace(request,true));
  route("GET","/api/v1/creator/projects/:id/draft-snapshots",{},async request=>{
    const actor=await auth.user(request);
    const rows=(await pool.query(`SELECT s.* FROM draft_snapshots s JOIN projects p ON p.id=s.project_id JOIN games g ON g.id=p.game_id
      WHERE p.id=$1 AND p.owner_id=$2 AND g.environment_id=$3 ORDER BY s.revision DESC LIMIT 100`,[params(request).id,actor.userId,config.environmentId])).rows;
    return {items:rows};
  });
  route("POST","/api/v1/creator/versions/:id/exports",{body:object({})},async request=>{
    const actor=await auth.user(request);
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);const version=await ownedVersion(client,actor,params(request).id);
      if(version.deleted_at || version.game_deleted || version.source==="official")throw new ApiError(409,"RESOURCE_IN_USE","版本不可导出");
      const id=randomUUID();
      await client.query("INSERT INTO artifact_jobs(id,environment_id,generation,owner_id,kind,input_id,status)VALUES($1,$2,$3,$4,'export',$5,'queued')",
        [id,config.environmentId,actor.generation,actor.userId,version.id]);return {jobId:id,status:"queued"};
    });
  });
  route("POST","/api/v1/creator/artifact-jobs/:id/download-grants",{body:object({})},async request=>{
    const actor=await auth.user(request);
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);const job=await jobFor(client,actor,params(request).id);
      if(job.kind!=="export" || job.status!=="succeeded")throw new ApiError(409,"VERSION_CONFLICT","导出尚未完成");
      if(new Date(job.expires_at)<new Date())throw new ApiError(410,"ARTIFACT_EXPIRED","导出产物已过期，请重新导出");
      const version=await ownedVersion(client,actor,job.input_id);
      if(version.deleted_at || version.game_deleted)throw new ApiError(409,"RESOURCE_IN_USE","版本已删除");
      const token=newToken(),id=randomUUID();
      await client.query("INSERT INTO artifact_download_grants(id,job_id,access_session_id,owner_id,token_digest)VALUES($1,$2,$3,$4,$5)",
        [id,job.id,actor.accessSessionId,actor.userId,digest(config.tokenSecret,"download",token)]);
      return {id,token,downloadUrl:`/api/v1/creator/downloads/${id}`,expiresIn:300};
    });
  });
  app.get("/api/v1/creator/downloads/:id",{schema:{params:catalogIdParams,headers:{type:"object",required:["x-download-token"],properties:{"x-download-token":text(100)}}}},async(request,reply)=>{
    const actor=await auth.user(request),token=request.headers["x-download-token"];
    if(typeof token!=="string")throw new ApiError(403,"PERMISSION_DENIED","下载授权无效");
    const row=(await pool.query(`SELECT j.result_digest FROM artifact_download_grants d JOIN artifact_jobs j ON j.id=d.job_id
      JOIN game_versions v ON v.id=j.input_id JOIN games g ON g.id=v.game_id
      WHERE d.id=$1 AND d.owner_id=$2 AND d.access_session_id=$3 AND d.token_digest=$4 AND d.expires_at>now()
        AND j.environment_id=$5 AND j.generation=$6 AND j.expires_at>now() AND j.status='succeeded'
        AND v.deleted_at IS NULL AND g.deleted_at IS NULL AND g.owner_id=$2`,
      [params(request).id,actor.userId,actor.accessSessionId,digest(config.tokenSecret,"download",token),config.environmentId,actor.generation])).rows[0];
    if(!row)throw new ApiError(410,"ARTIFACT_EXPIRED","下载授权无效或已过期");
    return reply.type("application/zip").header("Content-Disposition",'attachment; filename="game-export.zip"').send(await getObject(config,row.result_digest));
  });
  const checkReferences=async(client:PoolClient,gameId:string,versionId?:string)=>{
    const used=(await client.query(`SELECT
      EXISTS(SELECT 1 FROM publication_heads WHERE game_id=$1 AND ($2::uuid IS NULL OR version_id=$2)) OR
      EXISTS(SELECT 1 FROM review_submissions WHERE game_id=$1 AND status IN('pending','reviewing') AND($2::uuid IS NULL OR version_id=$2)) OR
      EXISTS(SELECT 1 FROM play_sessions WHERE game_id=$1 AND revoked_at IS NULL AND expires_at>now() AND($2::uuid IS NULL OR version_id=$2)) OR
      EXISTS(SELECT 1 FROM artifact_jobs j JOIN game_versions v ON v.id=j.input_id WHERE v.game_id=$1 AND j.kind='export'
        AND j.status IN('queued','running') AND($2::uuid IS NULL OR v.id=$2)) AS used`,[gameId,versionId??null])).rows[0].used;
    if(used)throw new ApiError(409,"RESOURCE_IN_USE","作品仍被发布、审核、游玩或文件任务引用");
    // Unknown future references are not physically collected by this implementation.
    if((await client.query("SELECT to_regclass('ai_tasks') AS name")).rows[0].name){
      const task=(await client.query("SELECT 1 FROM ai_tasks t JOIN ai_quotes q ON q.id=t.quote_id WHERE q.game_id=$1 AND t.status IN('queued','running') LIMIT 1",[gameId])).rows[0];
      if(task)throw new ApiError(409,"RESOURCE_IN_USE","作品仍有 AI 任务");
    }
  };
  route("POST","/api/v1/creator/games/:id/archive",{body:object({})},async request=>{
    const actor=await auth.user(request,"create");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);const game=await getOwnedGame(client,config.environmentId,actor.userId,params(request).id);
      await checkReferences(client,game.id);
      await client.query("UPDATE games SET archived_at=now() WHERE id=$1",[game.id]);return {archived:true};
    });
  });
  route("DELETE","/api/v1/creator/games/:id",{},async request=>{
    const actor=await auth.user(request,"create");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);const game=await getOwnedGame(client,config.environmentId,actor.userId,params(request).id);
      await checkReferences(client,game.id);
      const row=(await client.query("UPDATE games SET deleted_at=COALESCE(deleted_at,now()),archived_at=COALESCE(archived_at,now()) WHERE id=$1 RETURNING deleted_at+interval '30 days' AS restore_until",[game.id])).rows[0];
      await audit(client,actor,"game_soft_deleted",game.id,request.id);return {deleted:true,restoreUntil:row.restore_until};
    });
  });
  route("POST","/api/v1/creator/games/:id/restore",{body:object({})},async request=>{
    const actor=await auth.user(request,"create");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);const game=await getOwnedGame(client,config.environmentId,actor.userId,params(request).id);
      if(game.deleted_at && Date.now()-new Date(game.deleted_at).getTime()>30*86400000)throw new ApiError(410,"ARTIFACT_EXPIRED","恢复期已结束");
      await client.query("UPDATE games SET deleted_at=NULL,archived_at=NULL WHERE id=$1",[game.id]);
      return {restored:true,published:false};
    });
  });
  route("DELETE","/api/v1/creator/versions/:id",{},async request=>{
    const actor=await auth.user(request,"create");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);const version=await ownedVersion(client,actor,params(request).id);
      await getOwnedGame(client,config.environmentId,actor.userId,version.game_id);
      await checkReferences(client,version.game_id,version.id);
      if((await client.query("SELECT 1 FROM projects WHERE game_id=$1 AND base_version_id=$2",[version.game_id,version.id])).rows[0])throw new ApiError(409,"RESOURCE_IN_USE","版本仍是当前工作基线");
      const row=(await client.query("UPDATE game_versions SET deleted_at=COALESCE(deleted_at,now()) WHERE id=$1 RETURNING deleted_at+interval '30 days' AS restore_until",[version.id])).rows[0];
      return {deleted:true,restoreUntil:row.restore_until};
    });
  });
  route("POST","/api/v1/creator/versions/:id/restore",{body:object({})},async request=>{
    const actor=await auth.user(request,"create");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor);const version=await ownedVersion(client,actor,params(request).id);
      if(version.deleted_at && Date.now()-new Date(version.deleted_at).getTime()>30*86400000)throw new ApiError(410,"ARTIFACT_EXPIRED","恢复期已结束");
      if(version.game_deleted)throw new ApiError(409,"RESOURCE_IN_USE","请先恢复作品");
      await client.query("UPDATE game_versions SET deleted_at=NULL WHERE id=$1",[version.id]);return {restored:true,published:false};
    });
  });
  const saveContext=async(client:PoolClient,request:FastifyRequest,actor:PlatformActor)=>{
    const session=await validPlaySession(client,config,params(request).id,actor.accessSessionId);
    if(session.user_id!==actor.userId)throw new ApiError(403,"PERMISSION_DENIED","该游玩会话不属于当前账号");
    const schema=session.manifest.saveSchemaVersion;
    if(!schema || !session.manifest.permissions.includes("save"))throw new ApiError(409,"SAVE_SCHEMA_MISMATCH","游戏未声明云档能力");
    return {session,schema};
  };
  route("GET","/api/v1/play-sessions/:id/save",{},async request=>{
    const actor=await auth.user(request);
    return withTransaction(pool,async client=>{
      const {session,schema}=await saveContext(client,request,actor);
      const row=(await client.query("SELECT revision,data,updated_at FROM game_saves WHERE user_id=$1 AND game_id=$2 AND save_schema_version=$3",[actor.userId,session.game_id,schema])).rows[0];
      const otherSchemas=(await client.query(`SELECT save_schema_version FROM game_saves
        WHERE user_id=$1 AND game_id=$2 AND save_schema_version<>$3 AND data IS NOT NULL ORDER BY save_schema_version`,
        [actor.userId,session.game_id,schema])).rows.map(item=>item.save_schema_version);
      return {...(row??{revision:0,data:null}),saveSchemaVersion:schema,otherSchemaVersions:otherSchemas};
    });
  });
  const writeSave=async(request:FastifyRequest,remove=false,importing=false)=>{
    const actor=await auth.user(request),input=body(request);
    if(importing && input.confirmed!==true)throw new ApiError(400,"INVALID_REQUEST","导入需要明确确认");
    const data=remove?null:input.data;
    if(Buffer.byteLength(JSON.stringify(data))>102400)throw new ApiError(413,"PAYLOAD_TOO_LARGE","存档超过 100 KiB");
    return withTransaction(pool,async client=>{
      await actorLock(client,actor,"save");
      const {session,schema}=await saveContext(client,request,actor);
      // Lock the user so even an empty slot has a stable serialization point.
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[actor.userId]);
      const old=(await client.query("SELECT * FROM game_saves WHERE user_id=$1 AND game_id=$2 AND save_schema_version=$3 FOR UPDATE",[actor.userId,session.game_id,schema])).rows[0];
      if((old?.revision??0)!==input.expectedRevision || (importing && old?.data!==null && old))throw new ApiError(409,"VERSION_CONFLICT","云档已更新，请先读取当前存档");
      const next=(old?.revision??0)+1;
      await client.query(`INSERT INTO game_saves(user_id,game_id,save_schema_version,revision,data,game_version_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,game_id,save_schema_version)
        DO UPDATE SET revision=excluded.revision,data=excluded.data,game_version_id=excluded.game_version_id,updated_at=now()`,
        [actor.userId,session.game_id,schema,next,data,session.version_id]);
      return {revision:next,data};
    });
  };
  const saveBody=object({expectedRevision:revision,data:{}},["expectedRevision","data"]);
  // Route-specific bodyLimit allows the documented save size rather than the API's small default.
  for(const [method,url,schema,remove,importing] of [
    ["PUT","/api/v1/play-sessions/:id/save",saveBody,false,false],
    ["DELETE","/api/v1/play-sessions/:id/save",object({expectedRevision:revision,confirmed:{const:true}},["expectedRevision","confirmed"]),true,false],
    ["POST","/api/v1/play-sessions/:id/save-imports",object({expectedRevision:revision,data:{},confirmed:{const:true}},["expectedRevision","data","confirmed"]),false,true],
  ] as const){
    app.route({method,url,bodyLimit:110000,schema:{params:catalogIdParams,body:schema,response:{200:catalogResponse}},
      handler:async request=>replyData(request,await writeSave(request,remove,importing))});
  }

  let busy=false;
  const timer=setInterval(()=>{
    if(busy)return;busy=true;
    void runArtifactJob(pool,config).catch(()=>app.log.error({category:"artifact_worker"},"文件任务处理失败")).finally(()=>{busy=false;});
  },500);
  timer.unref();
  app.addHook("onClose",async()=>{
    clearInterval(timer);
    // Finish the trusted parser operation before the caller closes its pool.
    while(busy)await new Promise(resolve=>setTimeout(resolve,10));
  });
}
