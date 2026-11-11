import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ApiConfig } from "./config";
import { withTransaction } from "./db";
import { digest, newToken, isToken } from "./tokens";
import { ApiError } from "./errors";
import { getObject, safeGamePath } from "./artifact-files";
import type { GameManifest, StoredGameFile } from "../../packages/contracts/catalog";

export async function createPlaySession(client: PoolClient, config: ApiConfig, input: {
  accessSessionId:string;generation:number;userId?:string;accountSessionId?:string;gameId:string;versionId:string;scope:"preview"|"internal_catalog";
}) {
  const version = (await client.query(
    `SELECT v.*,g.restricted,g.deleted_at AS game_deleted FROM game_versions v JOIN games g ON g.id=v.game_id
     WHERE v.id=$1 AND g.id=$2 AND g.environment_id=$3 FOR SHARE OF g`,
    [input.versionId,input.gameId,config.environmentId])).rows[0];
  if (!version || version.deleted_at || version.game_deleted || version.restricted || version.check_status !== "passed") {
    throw new ApiError(409,"GAME_UNAVAILABLE","游戏版本不可运行");
  }
  const access = (await client.query(
    `SELECT s.id FROM test_access_sessions s JOIN environments e ON e.id=s.environment_id
     JOIN test_access_grants g ON g.id=s.grant_id WHERE s.id=$1 AND e.id=$2 AND e.generation=$3
       AND s.generation=e.generation AND e.accepting_access AND s.revoked_at IS NULL AND s.expires_at>now()
       AND g.revoked_at IS NULL AND g.expires_at>now() FOR SHARE OF s,e,g`,
    [input.accessSessionId,config.environmentId,input.generation])).rows[0];
  if (!access) throw new ApiError(403,"TEST_ACCESS_REQUIRED","测试访问已失效");
  if(input.userId){
    const account=(await client.query(`SELECT s.id FROM account_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.access_session_id=$3 AND s.environment_id=$4 AND s.generation=$5
        AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' FOR SHARE OF s,u`,
      [input.accountSessionId??null,input.userId,input.accessSessionId,config.environmentId,input.generation])).rows[0];
    if(!account)throw new ApiError(401,"AUTH_REQUIRED","账号会话已失效");
  }
  if (input.scope === "internal_catalog") {
    const head = (await client.query("SELECT version_id FROM publication_heads WHERE environment_id=$1 AND game_id=$2 AND scope='internal_catalog'",
      [config.environmentId,input.gameId])).rows[0];
    if (head?.version_id !== input.versionId || version.review_status !== "approved") throw new ApiError(409,"GAME_UNAVAILABLE","版本尚未发布");
  }
  const id = randomUUID(), token = newToken();
  const session = (await client.query(
    `INSERT INTO play_sessions(id,environment_id,generation,access_session_id,user_id,game_id,version_id,scope,resource_digest,expires_at,account_session_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour',$10) RETURNING expires_at`,
    [id,config.environmentId,input.generation,input.accessSessionId,input.userId ?? null,input.gameId,input.versionId,input.scope,
      digest(config.tokenSecret,"resource",token),input.accountSessionId??null])).rows[0];
  if (input.scope === "preview") await client.query("UPDATE game_versions SET previewed_at=now() WHERE id=$1",[input.versionId]);
  return { id,sessionId:id,versionId:input.versionId,gameId:input.gameId,resourceToken:token,
    entry:(version.manifest as GameManifest).entry,expiresAt:session.expires_at,scope:input.scope,
    source:version.source,manifest:version.manifest };
}

export async function validPlaySession(client:PoolClient,config:ApiConfig,id:string,accessSessionId?:string) {
  const result = await client.query(
    `SELECT p.*,v.manifest,v.files,v.source FROM play_sessions p
     JOIN environments e ON e.id=p.environment_id
     JOIN test_access_sessions a ON a.id=p.access_session_id
     JOIN test_access_grants t ON t.id=a.grant_id
     JOIN games g ON g.id=p.game_id JOIN game_versions v ON v.id=p.version_id
     WHERE p.id=$1 AND p.environment_id=$2 AND p.generation=e.generation AND a.generation=e.generation
       AND e.accepting_access AND p.revoked_at IS NULL AND p.expires_at>now()
       AND a.revoked_at IS NULL AND a.expires_at>now() AND t.revoked_at IS NULL AND t.expires_at>now()
       AND NOT g.restricted AND g.deleted_at IS NULL AND v.deleted_at IS NULL
       AND v.review_status <> 'revoked' AND ($3::uuid IS NULL OR p.access_session_id=$3)
     FOR SHARE OF p,e,a,t,g,v`,
    [id,config.environmentId,accessSessionId ?? null]);
  if (!result.rows[0]) throw new ApiError(409,"GAME_UNAVAILABLE","游玩授权已失效");
  const play=result.rows[0];
  if(play.user_id){
    const account=(await client.query(`SELECT s.kind FROM account_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.access_session_id=$3 AND s.environment_id=$4 AND s.generation=$5
        AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' FOR SHARE OF s,u`,
      [play.account_session_id,play.user_id,play.access_session_id,config.environmentId,play.generation])).rows[0];
    if(!account)throw new ApiError(409,"GAME_UNAVAILABLE","账号会话已失效");
    if(account.kind==="admin"){
      const role=await client.query("SELECT role FROM role_assignments WHERE user_id=$1 AND role IN ('super_admin','reviewer') FOR SHARE",[play.user_id]);
      if(!role.rowCount)throw new ApiError(409,"GAME_UNAVAILABLE","审核授权已失效");
    }
  }
  return play;
}

export async function readPlayResource(pool:Pool,config:ApiConfig,input:{sessionId:string;resourceToken:string;path:string}) {
  if (!/^[0-9a-f-]{36}$/i.test(input.sessionId) || !isToken(input.resourceToken)) throw new ApiError(403,"PERMISSION_DENIED","资源授权无效");
  const path = safeGamePath(input.path);
  const file = await withTransaction(pool, async client => {
    const session = await validPlaySession(client,config,input.sessionId);
    if (session.resource_digest !== digest(config.tokenSecret,"resource",input.resourceToken)) throw new ApiError(403,"PERMISSION_DENIED","资源授权无效");
    if (!path.startsWith("dist/")) throw new ApiError(403,"PERMISSION_DENIED","只能读取运行资源");
    const file = (session.files as Record<string,StoredGameFile>)[path];
    if (!file) throw new ApiError(404,"NOT_FOUND","资源不存在");
    return file;
  });
  const body = await getObject(config,file.digest);
  return { body,mime:file.mime,digest:file.digest };
}
