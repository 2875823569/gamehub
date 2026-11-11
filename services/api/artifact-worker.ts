import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApiConfig } from "./config";
import { withTransaction } from "./db";
import { ApiError } from "./errors";
import { buildExport, getObject, prepareStaticFiles } from "./artifact-files";
import { runArchiveCodec } from "./artifact-codec";

export async function runArtifactJob(pool:Pool,config:ApiConfig):Promise<boolean> {
  const owner = randomUUID();
  const job = await withTransaction(pool,async client => {
    const expired=await client.query(`UPDATE artifact_jobs SET status='expired',lease_until=NULL,failure_reason='文件任务已过期'
      WHERE environment_id=$1 AND expires_at<=now() AND status IN ('queued','running') RETURNING kind,input_id`,[config.environmentId]);
    for(const item of expired.rows)if(item.kind==="scan")await client.query(
      "UPDATE artifact_uploads SET status='failed',failure_reason='文件任务已过期，请重新上传' WHERE id=$1 AND status='checking'",[item.input_id]);
    const row=(await client.query(
      `SELECT j.* FROM artifact_jobs j JOIN environments e ON e.id=j.environment_id
       WHERE j.environment_id=$1 AND j.generation=e.generation AND j.expires_at>now() AND
         (j.status='queued' OR (j.status='running' AND j.lease_until<now()))
       ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[config.environmentId])).rows[0];
    if(!row)return null;
    return (await client.query(`UPDATE artifact_jobs SET status='running',lease_owner=$2,lease_epoch=lease_epoch+1,
      lease_until=now()+interval '2 minutes' WHERE id=$1 RETURNING *`,[row.id,owner])).rows[0];
  });
  if(!job)return false;
  try{
    if(job.kind==="scan"){
      const upload=(await pool.query("SELECT * FROM artifact_uploads WHERE id=$1 AND owner_id=$2",[job.input_id,job.owner_id])).rows[0];
      if(!upload?.object_digest)throw new ApiError(422,"PACKAGE_UNSUPPORTED","上传尚未完整保存");
      const files=await runArchiveCodec("decode",await getObject(config,upload.object_digest));
      const prepared=await prepareStaticFiles(config,files);
      await withTransaction(pool,async client=>{
        const updated=await client.query(`UPDATE artifact_jobs j SET status='succeeded',lease_until=NULL
          FROM environments e WHERE j.id=$1 AND j.environment_id=e.id AND j.generation=e.generation
          AND j.status='running' AND j.lease_owner=$2 AND j.lease_epoch=$3 AND j.lease_until>now() RETURNING j.id`,
          [job.id,owner,job.lease_epoch]);
        if(!updated.rowCount)return;
        await client.query("UPDATE artifact_uploads SET status='passed',manifest=$2,files=$3 WHERE id=$1",
          [job.input_id,prepared.manifest,prepared.files]);
      });
    }else{
      const version=(await pool.query(`SELECT v.*,g.owner_id,g.deleted_at AS game_deleted FROM game_versions v
        JOIN games g ON g.id=v.game_id WHERE v.id=$1 AND g.environment_id=$2 AND g.owner_id=$3`,
        [job.input_id,config.environmentId,job.owner_id])).rows[0];
      if(!version || version.deleted_at || version.game_deleted)throw new ApiError(409,"RESOURCE_IN_USE","版本不可导出");
      const result=await buildExport(config,version.files);
      await pool.query(`UPDATE artifact_jobs j SET status='succeeded',result_digest=$4,lease_until=NULL
        FROM environments e WHERE j.id=$1 AND j.environment_id=e.id AND j.generation=e.generation
        AND j.status='running' AND j.lease_owner=$2 AND j.lease_epoch=$3 AND j.lease_until>now()`,
        [job.id,owner,job.lease_epoch,result]);
    }
  }catch(error){
    const reason=error instanceof ApiError?error.message:"文件处理失败，请重新上传或联系支持";
    await withTransaction(pool,async client=>{
      const changed=await client.query(`UPDATE artifact_jobs j SET status='failed',failure_reason=$4,lease_until=NULL
        FROM environments e WHERE j.id=$1 AND j.environment_id=e.id AND j.generation=e.generation
        AND j.status='running' AND j.lease_owner=$2 AND j.lease_epoch=$3 RETURNING j.id`,
        [job.id,owner,job.lease_epoch,reason]);
      if(changed.rowCount && job.kind==="scan")await client.query("UPDATE artifact_uploads SET status='failed',failure_reason=$2 WHERE id=$1",[job.input_id,reason]);
    });
  }
  return true;
}
