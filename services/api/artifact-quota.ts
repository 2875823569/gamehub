import type { PoolClient } from "pg";
import { ApiError } from "./errors";
import type { StoredGameFile } from "../../packages/contracts/catalog";

const MiB=1024*1024;
/** Fixed, conservative internal-test policy. This is not a billing entitlement. */
export const artifactLimits=Object.freeze({
  accountBytes:2*1024*MiB,environmentBytes:20*1024*MiB,
  accountActiveUploads:2,environmentActiveUploads:20,
  maxExpandedBytes:300*MiB,maxExpansionRatio:100,
  physicalObjectCount:100000,receivingSeconds:300,
});
export const uploadReservation=(compressed:number)=>compressed+Math.min(compressed*artifactLimits.maxExpansionRatio,artifactLimits.maxExpandedBytes);

async function lockQuota(client:PoolClient,environmentId:string){
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext('artifact-upload-quota'))",[environmentId]);
}
async function quotaUsage(client:PoolClient,environmentId:string,userId:string){
  return (await client.query(`WITH upload_objects AS (
      SELECT u.owner_id,f.value->>'digest' AS digest FROM artifact_uploads u
      CROSS JOIN LATERAL jsonb_each(COALESCE(u.files,'{}'::jsonb)) f
      WHERE u.environment_id=$1 AND u.storage_released_at IS NULL
    ), version_objects AS (
      SELECT g.owner_id,f.value->>'digest' AS digest,max((f.value->>'size')::bigint) AS bytes
      FROM game_versions v JOIN games g ON g.id=v.game_id CROSS JOIN LATERAL jsonb_each(v.files) f
      WHERE g.environment_id=$1 AND NOT EXISTS(SELECT 1 FROM upload_objects u WHERE u.owner_id=g.owner_id AND u.digest=f.value->>'digest')
      GROUP BY g.owner_id,f.value->>'digest'
    ), charges AS (
      SELECT owner_id,expected_size::bigint+LEAST(expected_size::bigint*$3,$4) AS bytes
      FROM artifact_uploads WHERE environment_id=$1 AND storage_released_at IS NULL
      UNION ALL SELECT owner_id,bytes FROM version_objects
    ) SELECT COALESCE(sum(bytes),0)::text AS environment_bytes,
      COALESCE(sum(bytes) FILTER(WHERE owner_id=$2),0)::text AS account_bytes FROM charges`,
    [environmentId,userId,artifactLimits.maxExpansionRatio,artifactLimits.maxExpandedBytes])).rows[0];
}
function assertLogicalCapacity(usage:{account_bytes:string;environment_bytes:string},reserved:number){
  if(Number(usage.account_bytes)+reserved>artifactLimits.accountBytes)throw new ApiError(429,"RATE_LIMITED","账号存储配额不足（内测 2 GiB，含上传展开预留和历史版本）；请联系管理员回收过期孤立上传");
  if(Number(usage.environment_bytes)+reserved>artifactLimits.environmentBytes)throw new ApiError(429,"RATE_LIMITED","测试环境存储配额不足，请联系管理员回收孤立对象");
}
export async function reserveUploadQuota(client:PoolClient,environmentId:string,userId:string,bytes:number){
  // Every new reservation in this environment observes the previous committed reservation.
  await lockQuota(client,environmentId);
  // An intent that never accepted a body has no possible orphan bytes to reclaim.
  await client.query(`UPDATE artifact_uploads SET storage_released_at=now()
    WHERE environment_id=$1 AND (expires_at<=now() OR generation<>(SELECT generation FROM environments WHERE id=$1))
      AND content_started_at IS NULL AND object_digest IS NULL
      AND storage_released_at IS NULL AND (receiving_until IS NULL OR receiving_until<=now())`,[environmentId]);
  const usage=await quotaUsage(client,environmentId,userId);
  const active=(await client.query(`SELECT count(*)::int AS environment_count,
      count(*) FILTER(WHERE owner_id=$2)::int AS account_count FROM artifact_uploads
      WHERE environment_id=$1 AND ((expires_at>now() AND status IN('pending','uploaded','checking')
        AND generation=(SELECT generation FROM environments WHERE id=$1)) OR receiving_until>now())`,
    [environmentId,userId])).rows[0];
  if(active.account_count>=artifactLimits.accountActiveUploads)throw new ApiError(429,"RATE_LIMITED","同时最多有 2 个未完成上传，请先完成检查或等待上传过期");
  if(active.environment_count>=artifactLimits.environmentActiveUploads)throw new ApiError(429,"RATE_LIMITED","测试环境上传繁忙，请稍后重试");
  const reserved=uploadReservation(bytes);
  assertLogicalCapacity(usage,reserved);
  return {reservedBytes:reserved,accountLimitBytes:artifactLimits.accountBytes,environmentLimitBytes:artifactLimits.environmentBytes};
}

export async function assertVersionStorageQuota(client:PoolClient,environmentId:string,userId:string,files:Record<string,StoredGameFile>){
  await lockQuota(client,environmentId);
  const known=(await client.query(`SELECT f.value->>'digest' AS digest FROM game_versions v JOIN games g ON g.id=v.game_id
    CROSS JOIN LATERAL jsonb_each(v.files) f WHERE g.environment_id=$1 AND g.owner_id=$2
    UNION SELECT f.value->>'digest' FROM artifact_uploads u CROSS JOIN LATERAL jsonb_each(COALESCE(u.files,'{}'::jsonb)) f
      WHERE u.environment_id=$1 AND u.owner_id=$2 AND u.storage_released_at IS NULL`,[environmentId,userId])).rows;
  const existing=new Set(known.map(row=>row.digest)),incoming=new Map(Object.values(files).map(file=>[file.digest,file.size]));
  const extra=[...incoming].reduce((total,[digest,size])=>total+(existing.has(digest)?0:size),0);
  assertLogicalCapacity(await quotaUsage(client,environmentId,userId),extra);
}

export function assertPhysicalCapacity(currentBytes:number,currentObjects:number,newBytes:number,newObjects:number){
  if(currentBytes+newBytes>artifactLimits.environmentBytes || currentObjects+newObjects>artifactLimits.physicalObjectCount){
    throw new ApiError(429,"RATE_LIMITED","本机私有对象存储已达配额，未提交和过期对象也占用容量；请先运行受控回收");
  }
}
