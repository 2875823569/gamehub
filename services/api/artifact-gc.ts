import { randomUUID } from "node:crypto";
import { lstat,readdir,unlink } from "node:fs/promises";
import { join,resolve,relative,isAbsolute } from "node:path";
import type { Pool,PoolClient } from "pg";
import type { ApiConfig } from "./config";
import { objectDirectory,withObjectLock } from "./artifact-files";
import { ApiError } from "./errors";

async function protectedObjects(client:PoolClient,config:ApiConfig):Promise<Set<string>>{
  const protectedKeys=new Set<string>();
  const addFiles=(files:unknown)=>{
    if(!files || typeof files!=="object")return;
    for(const value of Object.values(files))if(value && typeof value==="object" && "digest" in value && typeof value.digest==="string")protectedKeys.add(value.digest);
  };
  // Keep ALL version files, including deleted/archived versions. This conservatively covers
  // releases, rooms, workspace bases, AI disputes, feedback and audit evidence referencing versions.
  for(const row of (await client.query("SELECT v.files FROM game_versions v JOIN games g ON g.id=v.game_id WHERE g.environment_id=$1",[config.environmentId])).rows)addFiles(row.files);
  for(const row of (await client.query(`SELECT u.object_digest,u.files FROM artifact_uploads u WHERE u.environment_id=$1 AND
    (u.expires_at>now() OR EXISTS(SELECT 1 FROM artifact_jobs j WHERE j.input_id=u.id AND j.status IN('queued','running')))`,[config.environmentId])).rows){
    if(row.object_digest)protectedKeys.add(row.object_digest);addFiles(row.files);
  }
  for(const row of (await client.query(`SELECT result_digest FROM artifact_jobs WHERE environment_id=$1
    AND result_digest IS NOT NULL AND(expires_at>now() OR status IN('queued','running'))`,[config.environmentId])).rows)protectedKeys.add(row.result_digest);
  return protectedKeys;
}

/** Orphan-only GC. Never reclaims version evidence until a complete retention policy is approved. */
export async function collectArtifactOrphans(pool:Pool,config:ApiConfig,options:{apply?:boolean;confirmEnvironment?:string}={}){
  if(options.apply && options.confirmEnvironment!==config.environmentId)throw new ApiError(400,"INVALID_REQUEST","执行回收必须明确确认目标环境");
  const operationId=randomUUID();
  // Keep a durable attempt record even if a later filesystem operation or DB commit fails.
  if(options.apply){
    const started=await pool.query(`INSERT INTO audit_events(id,environment_id,generation,actor,action,metadata)
      SELECT $1,id,generation,'local-gc','artifact_gc_started',$4 FROM environments WHERE id=$2 AND mode=$3`,
      [operationId,config.environmentId,config.mode,{policy:"orphan-only",minimumAgeHours:24}]);
    if(!started.rowCount)throw new ApiError(403,"ENVIRONMENT_MISMATCH","环境不匹配");
  }
  return withObjectLock(config,async()=>{
    const client=await pool.connect();
    // Filesystem deletion is irreversible: never retry this transaction callback automatically.
    try{await client.query("BEGIN");
    const env=(await client.query("SELECT generation FROM environments WHERE id=$1 AND mode=$2 FOR UPDATE",[config.environmentId,config.mode])).rows[0];
    if(!env)throw new ApiError(403,"ENVIRONMENT_MISMATCH","环境不匹配");
    const root=objectDirectory(config),protectedKeys=await protectedObjects(client,config);
    const report:{dryRun:boolean;environmentId:string;candidates:string[];deleted:string[];protected:number;recent:number;ignored:number;policy:string}={
      dryRun:!options.apply,environmentId:config.environmentId,candidates:[],deleted:[],protected:0,recent:0,ignored:0,
      policy:"只清理24小时以上无引用对象；所有历史版本及其间接房间、审核、任务、反馈引用保留",
    };
    for(const name of await readdir(root)){
      if(!/^[a-f0-9]{64}$/.test(name)){report.ignored++;continue;}
      const target=resolve(join(root,name)),inside=relative(root,target);
      if(!inside || inside.startsWith("..") || isAbsolute(inside))throw new Error("Unsafe object path");
      const info=await lstat(target);
      if(!info.isFile() || info.isSymbolicLink()){report.ignored++;continue;}
      if(protectedKeys.has(name)){report.protected++;continue;}
      if(Date.now()-info.mtimeMs<24*3600000){report.recent++;continue;}
      report.candidates.push(name);
      if(options.apply){
        // Re-query immediately before deletion under the environment + writer locks.
        if((await protectedObjects(client,config)).has(name)){report.protected++;continue;}
        const fresh=await lstat(target);
        if(!fresh.isFile() || fresh.isSymbolicLink() || Date.now()-fresh.mtimeMs<24*3600000)continue;
        await unlink(target);report.deleted.push(name);
      }
    }
    if(options.apply){
      // After object cleanup, an expired upload cannot receive/retry or create a version.
      // Retained game_versions are counted independently, so releasing this conservative reservation is safe.
      await client.query(`UPDATE artifact_uploads u SET storage_released_at=now(),object_digest=NULL,files=NULL
        WHERE u.environment_id=$1 AND u.expires_at<now()-interval '24 hours' AND u.storage_released_at IS NULL
          AND (u.receiving_until IS NULL OR u.receiving_until<=now())
          AND NOT EXISTS(SELECT 1 FROM artifact_jobs j WHERE j.input_id=u.id AND j.status IN('queued','running'))`,
        [config.environmentId]);
      await client.query(`INSERT INTO audit_events(id,environment_id,generation,actor,action,metadata)
      VALUES($1,$2,$3,'local-gc','artifact_orphans_collected',$4)`,
      [randomUUID(),config.environmentId,env.generation,{operationId,deleted:report.deleted,candidates:report.candidates.length}]);
    }
    await client.query("COMMIT");
    return report;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  });
}
