import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ApiConfig } from "./config";
import type { GameManifest } from "../../packages/contracts/catalog";
import { prepareStaticFiles, type PreparedCandidate } from "./artifact-files";
import { ApiError } from "./errors";
import { assertVersionStorageQuota } from "./artifact-quota";

export async function getOwnedGame(client: PoolClient, environmentId: string, userId: string, gameId: string) {
  const result = await client.query("SELECT * FROM games WHERE id=$1 AND environment_id=$2 AND owner_id=$3 FOR UPDATE",
    [gameId,environmentId,userId]);
  if (!result.rows[0]) throw new ApiError(404, "NOT_FOUND", "作品不存在");
  return result.rows[0];
}
export async function assertVisibleGame(client: PoolClient, environmentId: string, gameId: string) {
  const result = await client.query(
    `SELECT g.*,h.version_id FROM games g JOIN publication_heads h ON h.game_id=g.id
     WHERE g.id=$1 AND g.environment_id=$2 AND h.environment_id=$2 AND h.scope='internal_catalog'
       AND NOT g.restricted AND g.deleted_at IS NULL`, [gameId,environmentId]);
  if (!result.rows[0]) throw new ApiError(404,"NOT_FOUND","游戏不存在或不可访问");
  return result.rows[0];
}
export async function prepareAiCandidate(config: ApiConfig, files: Record<string,string>, manifest: GameManifest): Promise<PreparedCandidate> {
  return prepareStaticFiles(config, Object.fromEntries(Object.entries(files).map(([path,text]) => [path,Buffer.from(text)])), manifest);
}
export async function createAiCandidate(client: PoolClient, input: {
  environmentId: string; generation: number; userId: string; gameId: string;
  baseVersionId?: string | null; prepared: PreparedCandidate; sourceLabel?: string;
}): Promise<{id:string;number:number}> {
  const env = await client.query("SELECT generation FROM environments WHERE id=$1 FOR SHARE", [input.environmentId]);
  if (env.rows[0]?.generation !== input.generation) throw new ApiError(403,"ENVIRONMENT_MISMATCH","环境已经重置");
  const game = await getOwnedGame(client,input.environmentId,input.userId,input.gameId);
  if (game.deleted_at || game.restricted || game.archived_at) throw new ApiError(409,"GAME_UNAVAILABLE","作品当前不可写入");
  if (input.baseVersionId) {
    const base = await client.query("SELECT id FROM game_versions WHERE id=$1 AND game_id=$2 AND deleted_at IS NULL",[input.baseVersionId,input.gameId]);
    if (!base.rows[0]) throw new ApiError(409,"VERSION_CONFLICT","起始版本不可用");
  }
  return insertCandidate(client,input.gameId,input.prepared,"ai",input.sourceLabel ?? "mock",input.baseVersionId);
}
export async function insertCandidate(client:PoolClient,gameId:string,prepared:PreparedCandidate,source:"upload"|"ai",label?:string,baseVersionId?:string|null) {
  const game=(await client.query("SELECT environment_id,owner_id FROM games WHERE id=$1",[gameId])).rows[0];
  await assertVersionStorageQuota(client,game.environment_id,game.owner_id,prepared.files);
  const result = await client.query<{id:string;number:number}>(
    `INSERT INTO game_versions(id,game_id,number,manifest,files,source,source_label,base_version_id,content_digest,check_status,check_evidence)
     VALUES($1,$2,(SELECT COALESCE(max(number),0)+1 FROM game_versions WHERE game_id=$2),$3,$4,$5,$6,$7,$8,'passed',$9)
     RETURNING id,number`,
    [randomUUID(),gameId,prepared.manifest,prepared.files,source,label ?? null,baseVersionId ?? null,prepared.contentDigest,
      { type:"static-package", codeExecuted:false, browserVerified:false }]);
  return result.rows[0];
}
export async function publishVersion(client:PoolClient,environmentId:string,userId:string,gameId:string,versionId:string,reason:string) {
  const game = (await client.query("SELECT * FROM games WHERE id=$1 AND environment_id=$2 FOR UPDATE",[gameId,environmentId])).rows[0];
  if (!game || game.restricted || game.deleted_at || game.archived_at) throw new ApiError(409,"GAME_UNAVAILABLE","作品不可发布");
  const version = (await client.query("SELECT * FROM game_versions WHERE id=$1 AND game_id=$2 AND deleted_at IS NULL",[versionId,gameId])).rows[0];
  if (!version || version.review_status !== "approved" || version.check_status !== "passed") throw new ApiError(409,"GAME_UNAVAILABLE","版本未获有效批准");
  const account = (await client.query("SELECT status FROM users WHERE id=$1 FOR SHARE",[game.owner_id])).rows[0];
  if (!account || account.status !== "active") throw new ApiError(409,"GAME_UNAVAILABLE","作者账号不可发布");
  const blocked=await client.query(`SELECT 1 FROM account_restrictions WHERE user_id=$1 AND released_at IS NULL
    AND (expires_at IS NULL OR expires_at>now()) AND capability IN ('all','submit') LIMIT 1`,[game.owner_id]);
  if(blocked.rowCount)throw new ApiError(409,"GAME_UNAVAILABLE","作者投稿权限已受限制");
  await client.query(`INSERT INTO publication_heads(environment_id,scope,game_id,version_id) VALUES($1,'internal_catalog',$2,$3)
    ON CONFLICT(environment_id,scope,game_id) DO UPDATE SET version_id=excluded.version_id`,[environmentId,gameId,versionId]);
  await client.query("UPDATE games SET current_version_id=$2,status='published',updated_at=now() WHERE id=$1",[gameId,versionId]);
  const releaseId=randomUUID();
  await client.query("INSERT INTO releases(id,environment_id,game_id,version_id,actor_id,scope,reason) VALUES($1,$2,$3,$4,$5,'internal_catalog',$6)",
    [releaseId,environmentId,gameId,versionId,userId,reason]);
  await catalogEvent(client,environmentId,game.owner_id,`release:${releaseId}`,"game.released",{gameId,versionId});
}
export async function catalogEvent(client:PoolClient,environmentId:string,userId:string,key:string,type:string,payload:object){
  await client.query(`INSERT INTO outbox_events(id,environment_id,generation,business_key,event_type,user_id,payload)
    SELECT $1,id,generation,$3,$4,$5,$6 FROM environments WHERE id=$2
    ON CONFLICT(environment_id,business_key) DO NOTHING`,
    [randomUUID(),environmentId,key,type,userId,payload]);
}
