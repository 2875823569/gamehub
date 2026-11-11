import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { ApiConfig } from "../services/api/config";
import { withTransaction } from "../services/api/db";
import { WalletService } from "../services/api/wallet-store";
import { ApiError } from "../services/api/errors";

export async function previewReset(pool:Pool,config:ApiConfig) {
  return withTransaction(pool,async c=>{
    const env=(await c.query("SELECT id,mode,generation,accepting_access FROM environments WHERE id=$1 FOR SHARE",[config.environmentId])).rows[0];
    if(!env||env.mode!==config.mode)throw new ApiError(403,"ENVIRONMENT_MISMATCH","环境配置不匹配");
    const counts=(await c.query(`SELECT
      (SELECT count(*)::int FROM test_access_sessions WHERE environment_id=$1 AND revoked_at IS NULL) AS "accessSessions",
      (SELECT count(*)::int FROM account_sessions WHERE environment_id=$1 AND revoked_at IS NULL) AS "accountSessions",
      (SELECT count(*)::int FROM ai_tasks WHERE environment_id=$1 AND status IN ('queued','running')) AS "activeTasks",
      (SELECT count(*)::int FROM play_sessions WHERE environment_id=$1 AND revoked_at IS NULL) AS "playSessions",
      (SELECT count(*)::int FROM provider_cost_reservations WHERE environment_id=$1 AND status IN ('reserved','uncertain')) AS "unresolvedCosts",
      (SELECT COALESCE(sum(frozen),0)::text FROM point_accounts WHERE environment_id=$1) AS "frozenPoints"`,[config.environmentId])).rows[0];
    return {environmentId:env.id,mode:env.mode,generation:env.generation,acceptingAccess:env.accepting_access,counts,
      effect:"暂停准入，释放未完成AI冻结，撤销旧身份与运行授权，递增世代；保留账户、账本、作品和未决供应商成本，不物理删除数据",
      confirmation:`RESET ${env.id} GENERATION ${env.generation}`};
  });
}

async function closeRoomsIfPresent(c:PoolClient,environmentId:string) {
  const exists=(await c.query("SELECT to_regclass('rooms') IS NOT NULL AS present")).rows[0].present;
  if(!exists)return 0;
  // The new room service's durable state is the authority; socket loops recheck it.
  const columns=(await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='rooms'`)).rows.map(r=>r.column_name);
  if(!columns.includes("environment_id")||!columns.includes("status"))throw new Error("未知房间结构，拒绝不完整重置");
  const assignments=["status='closed'"];
  if(columns.includes("lease_until"))assignments.push("lease_until=NULL");
  if(columns.includes("lease_epoch"))assignments.push("lease_epoch=lease_epoch+1");
  if(columns.includes("closed_at"))assignments.push("closed_at=now()");
  const r=await c.query(`UPDATE rooms SET ${assignments.join(",")} WHERE environment_id=$1 AND status<>'closed'`,[environmentId]);
  return r.rowCount??0;
}

export async function resetEnvironment(pool:Pool,config:ApiConfig,input:{generation:number;confirmation:string;operator:string}) {
  if(!Number.isSafeInteger(input.generation)||input.generation<1||input.confirmation!==`RESET ${config.environmentId} GENERATION ${input.generation}`||!input.operator.trim())
    throw new ApiError(400,"INVALID_REQUEST","需要精确的环境、世代确认和操作者");
  return withTransaction(pool,async c=>{
    const env=(await c.query("SELECT mode,generation FROM environments WHERE id=$1 FOR UPDATE",[config.environmentId])).rows[0];
    if(!env||env.mode!==config.mode||env.generation!==input.generation)throw new ApiError(409,"VERSION_CONFLICT","环境或世代已变化，请重新预览");
    await c.query("UPDATE environments SET accepting_access=false WHERE id=$1",[config.environmentId]);
    const cancelledTasks=await new WalletService(pool,config).releaseForReset(c,env.generation,input.operator);
    const frozen=(await c.query("SELECT COALESCE(sum(frozen),0)::text AS total FROM point_accounts WHERE environment_id=$1",[config.environmentId])).rows[0].total;
    if(frozen!=="0")throw new Error("仍有无法关联释放的冻结点数，拒绝重置");
    await c.query("UPDATE test_access_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE environment_id=$1",[config.environmentId]);
    await c.query("UPDATE test_access_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE environment_id=$1",[config.environmentId]);
    await c.query("UPDATE account_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE environment_id=$1",[config.environmentId]);
    const play=await c.query("UPDATE play_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE environment_id=$1 AND revoked_at IS NULL",[config.environmentId]);
    const rooms=await closeRoomsIfPresent(c,config.environmentId);
    await c.query("UPDATE artifact_jobs SET status='failed',failure_reason='ENVIRONMENT_RESET' WHERE environment_id=$1 AND status IN ('queued','running')",[config.environmentId]);
    await c.query("UPDATE payment_orders SET status='closed' WHERE environment_id=$1 AND status='pending'",[config.environmentId]);
    await c.query("UPDATE environments SET generation=generation+1 WHERE id=$1",[config.environmentId]);
    const id=randomUUID();
    await c.query(`INSERT INTO audit_events(id,environment_id,generation,actor,action,metadata)
      VALUES($1,$2,$3,$4,'environment_generation_reset',$5)`,
      [id,config.environmentId,env.generation+1,input.operator,{previousGeneration:env.generation,cancelledTasks,revokedPlaySessions:play.rowCount,closedRooms:rooms,physicalDataDeleted:false}]);
    return {environmentId:config.environmentId,generation:env.generation+1,acceptingAccess:false,cancelledTasks,revokedPlaySessions:play.rowCount,closedRooms:rooms,auditId:id,physicalDataDeleted:false};
  });
}

export async function resumeEnvironment(pool:Pool,config:ApiConfig,input:{generation:number;confirmation:string;operator:string}) {
  if(input.confirmation!==`RESUME ${config.environmentId} GENERATION ${input.generation}`||!input.operator.trim())
    throw new ApiError(400,"INVALID_REQUEST","需要精确的恢复确认和操作者");
  return withTransaction(pool,async c=>{
    const row=(await c.query("UPDATE environments SET accepting_access=true WHERE id=$1 AND mode=$2 AND generation=$3 RETURNING id",
      [config.environmentId,config.mode,input.generation])).rows[0];
    if(!row)throw new ApiError(409,"VERSION_CONFLICT","环境或世代已变化");
    await c.query("INSERT INTO audit_events(id,environment_id,generation,actor,action) VALUES($1,$2,$3,$4,'environment_access_resumed')",
      [randomUUID(),config.environmentId,input.generation,input.operator]);
    return {environmentId:config.environmentId,generation:input.generation,acceptingAccess:true};
  });
}
