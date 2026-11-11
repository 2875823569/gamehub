import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ApiConfig } from "./config";
import type { PlatformActor } from "./platform-auth";
import { withTransaction } from "./db";
import { ApiError } from "./errors";
import { digest, tokenEqual } from "./tokens";

type Client = PoolClient;
export type TaskStatus = "queued"|"running"|"succeeded"|"failed"|"cancelled"|"timed_out";
export interface TaskRow {
  id:string; environment_id:string; generation:number; user_id:string; quote_id:string;
  status:TaskStatus; points:number; lease_epoch:number; worker_id:string|null; lease_until:Date|null;
  attempts:number; deadline_at:Date; original_task_id:string|null; output_version_id:string|null;
}
export interface ClaimedTask extends TaskRow {
  game_id:string; base_version_id:string|null; prompt:string; mode:"create"|"modify";
}
const hash = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const num = (value:string|number):number => {
  const n=Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Unsafe numeric balance");
  return n;
};
function conflict(message="请求与已有记录冲突"): never { throw new ApiError(409,"VERSION_CONFLICT",message); }
export const testProduct = { id:"test-100", ruleVersion:"mock-v1", channel:"mock", amountMinor:100, points:100, testOnly:true };

export class WalletService {
  constructor(readonly pool:Pool, readonly config:ApiConfig) {}

  async assertFinanceActor(client:PoolClient,actor:PlatformActor) {
    return this.actor(client,actor,undefined,["super_admin","finance"]);
  }
  private async environment(c:Client, generation?:number, exclusive=false) {
    const r=await c.query<{generation:number;accepting_access:boolean}>(
      `SELECT generation,accepting_access FROM environments WHERE id=$1 AND mode=$2 FOR ${exclusive?"UPDATE":"SHARE"}`,
      [this.config.environmentId,this.config.mode]);
    const env=r.rows[0];
    if(!env || (generation!==undefined&&env.generation!==generation)) throw new ApiError(403,"ENVIRONMENT_MISMATCH","测试环境已变更");
    return env;
  }
  private async account(c:Client,userId:string) {
    const user=await c.query("SELECT id FROM users WHERE id=$1 AND environment_id=$2",[userId,this.config.environmentId]);
    if(!user.rowCount) throw new ApiError(404,"NOT_FOUND","账号不存在");
    await c.query("INSERT INTO point_accounts(environment_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[this.config.environmentId,userId]);
    return (await c.query("SELECT * FROM point_accounts WHERE environment_id=$1 AND user_id=$2 FOR UPDATE",[this.config.environmentId,userId])).rows[0];
  }
  private async actor(c:Client,actor:PlatformActor,capability?:string,roles?:readonly string[]) {
    const env=await this.environment(c,actor.generation);
    if(!env.accepting_access)throw new ApiError(403,"PERMISSION_DENIED","环境已暂停");
    const valid=await c.query(`SELECT s.id FROM account_sessions s JOIN users u ON u.id=s.user_id
      JOIN test_access_sessions a ON a.id=s.access_session_id JOIN test_access_grants g ON g.id=a.grant_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.environment_id=$3 AND s.generation=$4 AND s.access_session_id=$5
        AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'
        AND a.revoked_at IS NULL AND a.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now()
        AND s.kind=$6 FOR SHARE OF s,u,a,g`,
      [actor.sessionId,actor.userId,this.config.environmentId,actor.generation,actor.accessSessionId,roles?"admin":"user"]);
    if(!valid.rowCount)throw new ApiError(403,"PERMISSION_DENIED","账号会话已失效");
    const restriction=await c.query(`SELECT id FROM account_restrictions WHERE user_id=$1 AND released_at IS NULL
      AND (expires_at IS NULL OR expires_at>now()) AND (capability='all' OR capability=$2)`,[actor.userId,capability??""]);
    if(restriction.rowCount)throw new ApiError(403,"ACCOUNT_RESTRICTED","账号当前不可执行此操作");
    if(roles){
      const assigned=(await c.query("SELECT role FROM role_assignments WHERE user_id=$1 FOR SHARE",[actor.userId])).rows.map(r=>r.role);
      if(!assigned.includes("super_admin")&&!roles.some(role=>assigned.includes(role)))throw new ApiError(403,"PERMISSION_DENIED","后台角色已失效");
    }
    return env;
  }
  private async event(c:Client,userId:string,generation:number,key:string,type:string,payload:unknown) {
    await c.query(`INSERT INTO outbox_events(id,environment_id,generation,business_key,event_type,user_id,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(environment_id,business_key) DO NOTHING`,
    [randomUUID(),this.config.environmentId,generation,key,type,userId,JSON.stringify(payload)]);
  }
  private async audit(c:Client,generation:number,actor:string,action:string,objectId:string) {
    await c.query(`INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(),this.config.environmentId,generation,actor,action,objectId]);
  }
  private async movement(c:Client,input:{userId:string;key:string;kind:string;amount:number;available:number;frozen:number;consumed:number;reason:string;taskId?:string;orderId?:string}) {
    await c.query(`INSERT INTO point_transactions(id,environment_id,user_id,business_key,kind,amount,available_delta,frozen_delta,consumed_delta,reason,task_id,order_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(),this.config.environmentId,input.userId,input.key,input.kind,input.amount,input.available,input.frozen,input.consumed,input.reason,input.taskId??null,input.orderId??null]);
    await c.query(`UPDATE point_accounts SET available=available+$3,frozen=frozen+$4,consumed=consumed+$5,revision=revision+1
      WHERE environment_id=$1 AND user_id=$2`,[this.config.environmentId,input.userId,input.available,input.frozen,input.consumed]);
  }
  private async expire(c:Client,userId:string) {
    const rows=(await c.query(`SELECT id,available FROM point_lots WHERE environment_id=$1 AND user_id=$2 AND expires_at<=now() AND available>0 FOR UPDATE`,
      [this.config.environmentId,userId])).rows;
    for(const lot of rows) {
      const amount=num(lot.available);
      await c.query("UPDATE point_lots SET expired=expired+available,available=0 WHERE id=$1",[lot.id]);
      await this.movement(c,{userId,key:`expire:${lot.id}:${randomUUID()}`,kind:"expire",amount,available:-amount,frozen:0,consumed:0,reason:"测试赠送点数到期"});
    }
  }
  async wallet(actor:PlatformActor) {
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor); await this.account(c,actor.userId); await this.expire(c,actor.userId);
      const row=(await c.query("SELECT available,frozen,consumed FROM point_accounts WHERE environment_id=$1 AND user_id=$2",[this.config.environmentId,actor.userId])).rows[0];
      return {available:num(row.available),frozen:num(row.frozen),consumed:num(row.consumed),testPoints:true};
    });
  }
  async transactions(actor:PlatformActor,cursor?:string) {
    const r=await this.pool.query(`SELECT id,kind,amount,available_delta AS "availableDelta",frozen_delta AS "frozenDelta",consumed_delta AS "consumedDelta",reason,
      task_id AS "taskId",order_id AS "orderId",created_at AS "createdAt" FROM point_transactions
      WHERE environment_id=$1 AND user_id=$2 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM point_transactions WHERE id=$3 AND user_id=$2 AND environment_id=$1))
      ORDER BY created_at DESC,id DESC LIMIT 51`,[this.config.environmentId,actor.userId,cursor??null]);
    const items=r.rows.slice(0,50).map(row=>({...row,amount:num(row.amount),availableDelta:num(row.availableDelta),frozenDelta:num(row.frozenDelta),consumedDelta:num(row.consumedDelta)}));
    return {items,nextCursor:r.rows.length>50?items.at(-1)!.id:null};
  }
  async grant(actor:PlatformActor,userId:string,points:number,reason:string,key:string) {
    if(!Number.isSafeInteger(points)||points<1||points>10000) throw new ApiError(400,"INVALID_REQUEST","测试发点须为1至10000整数");
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor,undefined,["super_admin","finance","operations"]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[this.config.environmentId,`grant:${actor.userId}:${key}`]);
      const businessKey=`grant:${actor.userId}:${key}`;
      const prior=(await c.query("SELECT user_id,amount,reason FROM point_transactions WHERE environment_id=$1 AND business_key=$2",[this.config.environmentId,businessKey])).rows[0];
      if(prior){if(prior.user_id!==userId||num(prior.amount)!==points||prior.reason!==reason)conflict();return {granted:points,replayed:true,testOnly:true};}
      await this.account(c,userId);
      const id=randomUUID();
      await c.query(`INSERT INTO point_lots(id,environment_id,user_id,source,source_key,initial,available,expires_at)
        VALUES($1,$2,$3,'test_grant',$4,$5,$5,now()+interval '30 days')`,[id,this.config.environmentId,userId,businessKey,points]);
      await this.movement(c,{userId,key:businessKey,kind:"grant",amount:points,available:points,frozen:0,consumed:0,reason});
      await this.audit(c,actor.generation,actor.userId,"test_points_granted",id);
      return {granted:points,replayed:false,testOnly:true};
    });
  }
  async quote(actor:PlatformActor,input:{gameId:string;workspaceRevision:number;prompt:string;mode:"create"|"modify"}) {
    return withTransaction(this.pool,async c=>{
      const env=await this.actor(c,actor,"create"); if(!env.accepting_access)throw new ApiError(503,"DEPENDENCY_UNAVAILABLE","环境已暂停");
      const p=(await c.query(`SELECT p.*,g.restricted,g.deleted_at FROM projects p JOIN games g ON g.id=p.game_id
        WHERE p.game_id=$1 AND p.owner_id=$2 AND g.environment_id=$3 FOR SHARE OF p,g`,[input.gameId,actor.userId,this.config.environmentId])).rows[0];
      if(!p||p.deleted_at||p.restricted)throw new ApiError(404,"NOT_FOUND","作品不可用");
      if(p.workspace_revision!==input.workspaceRevision)conflict("工作区已更新，请刷新后报价");
      if(input.mode==="modify"&&!p.base_version_id)throw new ApiError(422,"PACKAGE_UNSUPPORTED","修改前需选择可编辑版本");
      if(input.mode==="modify"){
        const version=(await c.query("SELECT manifest FROM game_versions WHERE id=$1 AND game_id=$2 AND deleted_at IS NULL",[p.base_version_id,input.gameId])).rows[0];
        if(!version?.manifest?.editable)throw new ApiError(422,"PACKAGE_UNSUPPORTED","此版本没有受支持的可编辑源码");
      }
      const id=randomUUID(),points=input.mode==="create"?10:6;
      const r=await c.query(`INSERT INTO ai_quotes(id,environment_id,generation,user_id,game_id,project_id,workspace_revision,base_version_id,prompt,mode,points,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '10 minutes') RETURNING expires_at`,
        [id,this.config.environmentId,actor.generation,actor.userId,input.gameId,p.id,p.workspace_revision,p.base_version_id,input.prompt.trim(),input.mode,points]);
      return {id,points,expiresAt:r.rows[0].expires_at.toISOString(),workspaceRevision:p.workspace_revision,baseVersionId:p.base_version_id,
        summary:input.prompt.trim(),provider:"mock",testOnly:true,pricingVersion:"mock-v1",
        delivery:"固定静态点击计数器模拟产物，用于验证流程；不调用真实AI，不承诺实现自然语言需求"};
    });
  }
  async createTask(actor:PlatformActor,quoteId:string,key:string) {
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor,"create");
      const q=(await c.query("SELECT *,expires_at>now() AS valid FROM ai_quotes WHERE id=$1 AND user_id=$2 AND environment_id=$3 FOR UPDATE",[quoteId,actor.userId,this.config.environmentId])).rows[0];
      if(!q)throw new ApiError(404,"NOT_FOUND","报价不存在");
      await this.account(c,actor.userId);
      const prior=(await c.query("SELECT * FROM ai_tasks WHERE environment_id=$1 AND user_id=$2 AND idempotency_key=$3",[this.config.environmentId,actor.userId,key])).rows[0];
      if(prior){if(prior.request_digest!==hash({quoteId}))conflict();return this.taskView(prior);}
      const consumed=(await c.query("SELECT * FROM ai_tasks WHERE quote_id=$1 AND original_task_id IS NULL",[quoteId])).rows[0];
      if(consumed)return this.taskView(consumed);
      if(!q.valid)throw new ApiError(409,"QUOTE_EXPIRED","报价已过期");
      if(q.generation!==actor.generation)throw new ApiError(403,"ENVIRONMENT_MISMATCH","报价属于旧环境");
      const p=(await c.query(`SELECT p.workspace_revision,g.deleted_at,g.restricted FROM projects p JOIN games g ON g.id=p.game_id
        WHERE p.id=$1 AND p.owner_id=$2 FOR SHARE OF p,g`,[q.project_id,actor.userId])).rows[0];
      if(!p||p.deleted_at||p.restricted||p.workspace_revision!==q.workspace_revision)conflict("报价基线已变更，请重新报价");
      await this.expire(c,actor.userId);
      const count=(await c.query("SELECT count(*)::int AS n FROM ai_tasks WHERE environment_id=$1 AND user_id=$2 AND status='queued'",[this.config.environmentId,actor.userId])).rows[0].n;
      if(count>=3)throw new ApiError(429,"RATE_LIMITED","最多排队3个任务");
      const account=(await c.query("SELECT available FROM point_accounts WHERE environment_id=$1 AND user_id=$2",[this.config.environmentId,actor.userId])).rows[0];
      if(num(account.available)<q.points)throw new ApiError(409,"INSUFFICIENT_POINTS","测试点数不足");
      const id=randomUUID();
      const task=(await c.query(`INSERT INTO ai_tasks(id,environment_id,generation,user_id,quote_id,idempotency_key,request_digest,points,deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '30 minutes') RETURNING *`,
        [id,this.config.environmentId,actor.generation,actor.userId,quoteId,key,hash({quoteId}),q.points])).rows[0];
      let remaining=q.points;
      const lots=(await c.query(`SELECT id,available FROM point_lots WHERE environment_id=$1 AND user_id=$2 AND available>0
        AND (expires_at IS NULL OR expires_at>now()) ORDER BY expires_at ASC NULLS LAST,created_at,id FOR UPDATE`,
        [this.config.environmentId,actor.userId])).rows;
      for(const lot of lots){
        const amount=Math.min(remaining,num(lot.available)); if(!amount)break;
        await c.query("UPDATE point_lots SET available=available-$2,frozen=frozen+$2 WHERE id=$1",[lot.id,amount]);
        await c.query("INSERT INTO point_allocations(task_id,lot_id,amount) VALUES($1,$2,$3)",[id,lot.id,amount]);
        remaining-=amount;
      }
      if(remaining!==0)throw new Error("Point account/lot mismatch");
      await this.movement(c,{userId:actor.userId,key:`freeze:${id}`,kind:"freeze",amount:q.points,available:-q.points,frozen:q.points,consumed:0,reason:"确认模拟AI任务",taskId:id});
      await this.event(c,actor.userId,actor.generation,`task:${id}:queued`,"ai.queued",{taskId:id});
      return this.taskView(task);
    });
  }
  taskView(row:any) {
    return {id:row.id,status:row.status,points:row.points,quoteId:row.quote_id,attempts:row.attempts,
      outputVersionId:row.output_version_id??null,failureCode:row.failure_code??null,createdAt:row.created_at,
      finishedAt:row.finished_at??null,provider:"mock",testOnly:true};
  }
  async getTask(actor:PlatformActor,id:string) {
    const row=(await this.pool.query("SELECT * FROM ai_tasks WHERE id=$1 AND environment_id=$2 AND user_id=$3",[id,this.config.environmentId,actor.userId])).rows[0];
    if(!row)throw new ApiError(404,"NOT_FOUND","任务不存在");
    return this.taskView(row);
  }
  async listTasks(actor:PlatformActor) {
    const rows=(await this.pool.query("SELECT * FROM ai_tasks WHERE environment_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50",[this.config.environmentId,actor.userId])).rows;
    return {items:rows.map(row=>this.taskView(row)),nextCursor:null};
  }
  private async finalizePoints(c:Client,task:TaskRow,outcome:"settled"|"released") {
    const inserted=await c.query("INSERT INTO point_freeze_results(task_id,outcome) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING task_id",[task.id,outcome]);
    if(!inserted.rowCount)conflict("任务冻结已处理");
    const allocations=(await c.query("SELECT a.*,l.expires_at FROM point_allocations a JOIN point_lots l ON l.id=a.lot_id WHERE a.task_id=$1 ORDER BY l.id FOR UPDATE OF l",[task.id])).rows;
    for(const a of allocations){
      if(outcome==="settled")await c.query("UPDATE point_lots SET frozen=frozen-$2,consumed=consumed+$2 WHERE id=$1",[a.lot_id,a.amount]);
      else await c.query(`UPDATE point_lots SET frozen=frozen-$2,available=available+$2,
        expires_at=CASE WHEN expires_at IS NOT NULL AND expires_at<now()+interval '7 days' THEN now()+interval '7 days' ELSE expires_at END WHERE id=$1`,[a.lot_id,a.amount]);
    }
    await this.movement(c,{userId:task.user_id,key:`finalize:${task.id}`,kind:outcome==="settled"?"settle":"release",amount:task.points,
      available:outcome==="released"?task.points:0,frozen:-task.points,consumed:outcome==="settled"?task.points:0,
      reason:outcome==="settled"?"模拟任务交付结算":"任务取消、失败或超时释放",taskId:task.id});
  }
  async cancel(actor:PlatformActor,id:string) {
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor);await this.account(c,actor.userId);
      const task=(await c.query<TaskRow>("SELECT * FROM ai_tasks WHERE id=$1 AND user_id=$2 AND environment_id=$3 FOR UPDATE",[id,actor.userId,this.config.environmentId])).rows[0];
      if(!task)throw new ApiError(404,"NOT_FOUND","任务不存在");
      if(task.status==="cancelled")return this.taskView(task);
      if(task.status!=="queued")throw new ApiError(409,"TASK_NOT_CANCELLABLE","仅排队任务可取消");
      await this.finalizePoints(c,task,"released");
      const updated=(await c.query("UPDATE ai_tasks SET status='cancelled',finished_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
      await this.event(c,task.user_id,task.generation,`task:${id}:terminal`,"ai.cancelled",{taskId:id});
      await c.query("UPDATE quality_cases SET status='open',resolution='模拟修复已取消，可继续处理' WHERE repair_task_id=$1 AND status='repairing'",[id]);
      return this.taskView(updated);
    });
  }
  async claim(workerId:string):Promise<ClaimedTask|null> {
    return withTransaction(this.pool,async c=>{
      const env=await this.environment(c,undefined,true);
      if(!env.accepting_access)return null;
      const running=(await c.query(`SELECT count(*)::int AS n FROM ai_tasks WHERE environment_id=$1 AND generation=$2 AND status='running' AND lease_until>now()`,
        [this.config.environmentId,env.generation])).rows[0].n;
      if(running>=2)return null;
      const task=(await c.query<ClaimedTask>(`SELECT t.*,q.game_id,q.base_version_id,q.prompt,q.mode FROM ai_tasks t JOIN ai_quotes q ON q.id=t.quote_id
        JOIN users u ON u.id=t.user_id
        WHERE t.environment_id=$1 AND t.generation=$2 AND t.deadline_at>now() AND t.attempts<3 AND u.status='active'
          AND (t.status='queued' OR (t.status='running' AND t.lease_until<=now()))
          AND NOT EXISTS(SELECT 1 FROM ai_tasks other WHERE other.environment_id=t.environment_id AND other.user_id=t.user_id AND other.id<>t.id AND other.status='running' AND other.lease_until>now())
        ORDER BY t.created_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1`,[this.config.environmentId,env.generation])).rows[0];
      if(!task)return null;
      const row=(await c.query<TaskRow>(`UPDATE ai_tasks SET status='running',worker_id=$2,lease_epoch=lease_epoch+1,lease_until=now()+interval '30 seconds',
        attempts=attempts+1,started_at=COALESCE(started_at,now()),deadline_at=CASE WHEN status='queued' THEN now()+interval '15 minutes' ELSE deadline_at END
        WHERE id=$1 RETURNING *`,[task.id,workerId])).rows[0];
      await c.query("UPDATE ai_attempts SET status='superseded' WHERE task_id=$1 AND status='running'",[task.id]);
      await c.query("INSERT INTO ai_attempts(task_id,lease_epoch,provider,status) VALUES($1,$2,'mock','running')",[task.id,row.lease_epoch]);
      return {...task,...row};
    });
  }
  async heartbeat(task:ClaimedTask):Promise<boolean> {
    const r=await this.pool.query(`UPDATE ai_tasks t SET lease_until=LEAST(now()+interval '30 seconds',deadline_at)
      FROM environments e WHERE t.id=$1 AND t.worker_id=$2 AND t.lease_epoch=$3 AND t.status='running'
      AND t.lease_until>now() AND t.deadline_at>now() AND e.id=t.environment_id AND e.id=$4 AND e.generation=t.generation AND e.accepting_access
      RETURNING t.id`,[task.id,task.worker_id,task.lease_epoch,this.config.environmentId]);
    return !!r.rowCount;
  }
  async complete(task:ClaimedTask,createCandidate:(c:Client)=>Promise<{id:string}>,checks:unknown) {
    return withTransaction(this.pool,async c=>{
      await this.environment(c,task.generation);await this.account(c,task.user_id);
      const current=(await c.query<TaskRow&{valid:boolean}>(`SELECT *,lease_until>now() AND deadline_at>now() AS valid FROM ai_tasks WHERE id=$1 FOR UPDATE`,[task.id])).rows[0];
      if(!current||current.status!=="running"||current.lease_epoch!==task.lease_epoch||current.worker_id!==task.worker_id||!current.valid)conflict("执行租约已失效");
      const version=await createCandidate(c);
      await this.finalizePoints(c,current,"settled");
      await c.query("UPDATE ai_tasks SET status='succeeded',finished_at=now(),output_version_id=$2,lease_until=NULL WHERE id=$1",[task.id,version.id]);
      await c.query("UPDATE ai_attempts SET status='succeeded',checks=$3 WHERE task_id=$1 AND lease_epoch=$2",[task.id,task.lease_epoch,JSON.stringify(checks)]);
      if(task.original_task_id)await c.query("UPDATE quality_cases SET status='repaired',resolution='模拟修复版本已生成，仍需作者确认' WHERE repair_task_id=$1",[task.id]);
      await this.event(c,task.user_id,task.generation,`task:${task.id}:terminal`,"ai.succeeded",{taskId:task.id,versionId:version.id,mock:true});
      return {id:task.id,status:"succeeded",outputVersionId:version.id};
    });
  }
  async fail(task:ClaimedTask,code="MOCK_EXECUTION_FAILED") {
    return withTransaction(this.pool,async c=>{
      await this.environment(c,task.generation);await this.account(c,task.user_id);
      const current=(await c.query<TaskRow&{valid:boolean}>("SELECT *,lease_until>now() AND deadline_at>now() AS valid FROM ai_tasks WHERE id=$1 FOR UPDATE",[task.id])).rows[0];
      if(!current||current.status!=="running"||current.lease_epoch!==task.lease_epoch||current.worker_id!==task.worker_id||!current.valid)return false;
      await this.finalizePoints(c,current,"released");
      await c.query("UPDATE ai_tasks SET status='failed',failure_code=$2,finished_at=now(),lease_until=NULL WHERE id=$1",[task.id,code]);
      await c.query("UPDATE ai_attempts SET status='failed' WHERE task_id=$1 AND lease_epoch=$2",[task.id,task.lease_epoch]);
      await c.query("UPDATE quality_cases SET status='open',resolution='模拟修复失败，可继续处理' WHERE repair_task_id=$1 AND status='repairing'",[task.id]);
      await this.event(c,task.user_id,task.generation,`task:${task.id}:terminal`,"ai.failed",{taskId:task.id,code});
      return true;
    });
  }
  async expireTasks():Promise<number> {
    const rows=(await this.pool.query<TaskRow>(`SELECT t.* FROM ai_tasks t JOIN environments e ON e.id=t.environment_id
      WHERE t.environment_id=$1 AND t.generation=e.generation AND t.status IN ('queued','running')
      AND (t.deadline_at<=now() OR (t.attempts>=3 AND t.lease_until<=now())) LIMIT 100`,[this.config.environmentId])).rows;
    let count=0;
    for(const task of rows)await withTransaction(this.pool,async c=>{
      await this.environment(c,task.generation);await this.account(c,task.user_id);
      const row=(await c.query<TaskRow>(`SELECT * FROM ai_tasks WHERE id=$1 AND status IN ('queued','running')
        AND (deadline_at<=now() OR (attempts>=3 AND lease_until<=now())) FOR UPDATE`,[task.id])).rows[0];
      if(!row)return;
      await this.finalizePoints(c,row,"released");
      await c.query("UPDATE ai_tasks SET status='timed_out',failure_code='TASK_TIMEOUT',finished_at=now(),lease_until=NULL WHERE id=$1",[task.id]);
      await c.query("UPDATE quality_cases SET status='open',resolution='模拟修复超时，可继续处理' WHERE repair_task_id=$1 AND status='repairing'",[task.id]);
      await this.event(c,task.user_id,task.generation,`task:${task.id}:terminal`,"ai.timed_out",{taskId:task.id});
      count++;
    });
    return count;
  }
  async qualityCase(actor:PlatformActor,id:string,description:string) {
    const task=(await this.pool.query("SELECT * FROM ai_tasks WHERE id=$1 AND user_id=$2 AND environment_id=$3 AND status='succeeded'",[id,actor.userId,this.config.environmentId])).rows[0];
    if(!task)throw new ApiError(404,"NOT_FOUND","没有可反馈的成功任务");
    const r=await this.pool.query(`INSERT INTO quality_cases(id,task_id,environment_id,user_id,description) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(task_id) DO UPDATE SET task_id=EXCLUDED.task_id RETURNING *`,[randomUUID(),id,this.config.environmentId,actor.userId,description]);
    return r.rows[0];
  }
  async resolveQuality(actor:PlatformActor,id:string,decision:"repair"|"refund"|"reject",reason:string) {
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor,undefined,["super_admin","support","finance"]);
      const initial=(await c.query("SELECT * FROM quality_cases WHERE id=$1 AND environment_id=$2",[id,this.config.environmentId])).rows[0];
      if(!initial)throw new ApiError(404,"NOT_FOUND","工单不存在");
      await this.account(c,initial.user_id);
      const qcase=(await c.query("SELECT * FROM quality_cases WHERE id=$1 FOR UPDATE",[id])).rows[0];
      const task=(await c.query<TaskRow>("SELECT * FROM ai_tasks WHERE id=$1 FOR UPDATE",[qcase.task_id])).rows[0];
      if(["refunded","rejected"].includes(qcase.status))conflict("工单已处理");
      if(qcase.status==="repairing")conflict("修复任务尚未结束");
      if(decision==="repair"){
        if(qcase.repair_count>=2)throw new ApiError(409,"RESOURCE_IN_USE","已达两轮自动修复上限，请退款或人工处理");
        const repairId=randomUUID();
        await c.query(`INSERT INTO ai_tasks(id,environment_id,generation,user_id,quote_id,idempotency_key,request_digest,points,deadline_at,original_task_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,0,now()+interval '30 minutes',$8)`,
          [repairId,this.config.environmentId,actor.generation,task.user_id,task.quote_id,`repair:${id}:${qcase.repair_count}`,hash({id,round:qcase.repair_count}),task.id]);
        await c.query("UPDATE quality_cases SET status='repairing',repair_task_id=$2,repair_count=repair_count+1,resolution=$3 WHERE id=$1",[id,repairId,reason]);
        await this.event(c,task.user_id,actor.generation,`task:${repairId}:queued`,"ai.queued",{taskId:repairId,repair:true});
      } else if(decision==="refund"){
        const allocations=(await c.query("SELECT * FROM point_allocations WHERE task_id=$1 ORDER BY lot_id FOR UPDATE",[task.id])).rows;
        let total=0;
        for(const a of allocations){
          const amount=num(a.amount)-num(a.refunded);total+=amount;
          await c.query(`UPDATE point_lots SET consumed=consumed-$2,available=available+$2,
            expires_at=CASE WHEN expires_at IS NOT NULL AND expires_at<now()+interval '7 days' THEN now()+interval '7 days' ELSE expires_at END WHERE id=$1`,[a.lot_id,amount]);
          await c.query("UPDATE point_allocations SET refunded=amount WHERE task_id=$1 AND lot_id=$2",[task.id,a.lot_id]);
        }
        await this.movement(c,{userId:task.user_id,key:`quality-refund:${task.id}`,kind:"compensate",amount:total,available:total,frozen:0,consumed:-total,reason,taskId:task.id});
        await c.query("UPDATE quality_cases SET status='refunded',resolution=$2 WHERE id=$1",[id,reason]);
      } else await c.query("UPDATE quality_cases SET status='rejected',resolution=$2 WHERE id=$1",[id,reason]);
      await this.audit(c,actor.generation,actor.userId,`quality_${decision}`,id);
      await this.event(c,task.user_id,actor.generation,`quality:${id}:${decision}:${qcase.repair_count}`,
        "ai.quality_processed",{caseId:id,taskId:task.id,decision});
      return (await c.query("SELECT * FROM quality_cases WHERE id=$1",[id])).rows[0];
    });
  }

  async createOrder(actor:PlatformActor,key:string) {
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor,"billing");await this.account(c,actor.userId);
      const prior=(await c.query("SELECT * FROM payment_orders WHERE environment_id=$1 AND user_id=$2 AND idempotency_key=$3",[this.config.environmentId,actor.userId,key])).rows[0];
      if(prior)return this.orderView(prior);
      const row=(await c.query(`INSERT INTO payment_orders(id,environment_id,generation,user_id,idempotency_key,request_digest,product_id,rule_version,channel,amount_minor,points,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,'test-100','mock-v1','mock',100,100,now()+interval '30 minutes') RETURNING *`,
        [randomUUID(),this.config.environmentId,actor.generation,actor.userId,key,hash(testProduct)])).rows[0];
      return this.orderView(row);
    });
  }
  orderView(row:any) {
    return {id:row.id,status:row.status,productId:row.product_id,amountMinor:row.amount_minor,points:row.points,channel:"mock",testOnly:true,createdAt:row.created_at,expiresAt:row.expires_at};
  }
  async order(actor:PlatformActor,id:string) {
    const row=(await this.pool.query("SELECT * FROM payment_orders WHERE id=$1 AND user_id=$2 AND environment_id=$3",[id,actor.userId,this.config.environmentId])).rows[0];
    if(!row)throw new ApiError(404,"NOT_FOUND","订单不存在");return this.orderView(row);
  }
  mockSignature(orderId:string,eventKey:string,amount:number):string {
    return digest(this.config.tokenSecret,"mock-payment",JSON.stringify({environment:this.config.environmentId,orderId,eventKey,amount}));
  }
  async confirmMockPayment(actor:PlatformActor,input:{orderId:string;eventKey:string;amount:number;signature:string}) {
    if(!tokenEqual(this.mockSignature(input.orderId,input.eventKey,input.amount),input.signature))throw new ApiError(403,"PERMISSION_DENIED","模拟支付签名无效");
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor,undefined,["super_admin","finance"]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[this.config.environmentId,`payment:${input.eventKey}`]);
      const initial=(await c.query("SELECT * FROM payment_orders WHERE id=$1 AND environment_id=$2",[input.orderId,this.config.environmentId])).rows[0];
      if(!initial)throw new ApiError(404,"NOT_FOUND","订单不存在");
      if(initial.generation!==actor.generation)throw new ApiError(403,"ENVIRONMENT_MISMATCH","旧环境订单不可入账");
      await this.account(c,initial.user_id);
      const order=(await c.query("SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE",[input.orderId])).rows[0];
      if(input.amount!==order.amount_minor)throw new ApiError(400,"INVALID_REQUEST","支付金额不匹配");
      const payloadDigest=hash({orderId:input.orderId,amount:input.amount});
      const old=(await c.query("SELECT * FROM payment_events WHERE environment_id=$1 AND provider_event_key=$2",[this.config.environmentId,input.eventKey])).rows[0];
      if(old){if(old.payload_digest!==payloadDigest)conflict("通知编号已用于不同内容");return this.orderView(order);}
      await c.query("INSERT INTO payment_events(id,environment_id,order_id,provider_event_key,event_type,payload_digest) VALUES($1,$2,$3,$4,'paid',$5)",
        [randomUUID(),this.config.environmentId,order.id,input.eventKey,payloadDigest]);
      if(order.status!=="pending"&&order.status!=="closed")return this.orderView(order);
      await c.query(`INSERT INTO point_lots(id,environment_id,user_id,source,source_key,initial,available) VALUES($1,$2,$3,'test_payment',$4,$5,$5)`,
        [randomUUID(),this.config.environmentId,order.user_id,`payment:${order.id}`,order.points]);
      await this.movement(c,{userId:order.user_id,key:`payment:${order.id}`,kind:"grant",amount:order.points,available:order.points,frozen:0,consumed:0,reason:"模拟支付测试入账",orderId:order.id});
      const updated=(await c.query("UPDATE payment_orders SET status='paid',paid_at=now() WHERE id=$1 RETURNING *",[order.id])).rows[0];
      await this.audit(c,actor.generation,actor.userId,"mock_payment_confirmed",order.id);
      await this.event(c,order.user_id,actor.generation,`payment:${order.id}:paid`,"billing.test_paid",{orderId:order.id,testOnly:true});
      return this.orderView(updated);
    });
  }
  async refundRequest(actor:PlatformActor,orderId:string,reason:string,key:string) {
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor);await this.account(c,actor.userId);
      const existing=(await c.query("SELECT * FROM refund_orders WHERE environment_id=$1 AND user_id=$2 AND idempotency_key=$3",[this.config.environmentId,actor.userId,key])).rows[0];
      if(existing){if(existing.order_id!==orderId||existing.reason!==reason)conflict();return existing;}
      const order=(await c.query("SELECT * FROM payment_orders WHERE id=$1 AND environment_id=$2 AND user_id=$3 FOR UPDATE",[orderId,this.config.environmentId,actor.userId])).rows[0];
      if(!order)throw new ApiError(404,"NOT_FOUND","订单不存在");
      if(order.status!=="paid")conflict("仅已入账测试订单可申请退款");
      const row=(await c.query(`INSERT INTO refund_orders(id,order_id,environment_id,user_id,idempotency_key,reason,amount_minor,points) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [randomUUID(),orderId,this.config.environmentId,actor.userId,key,reason,order.amount_minor,order.points])).rows[0];
      return row;
    });
  }
  async resolveRefund(actor:PlatformActor,id:string,approve:boolean,reason:string) {
    return withTransaction(this.pool,async c=>{
      await this.actor(c,actor,undefined,["super_admin","finance"]);
      const initial=(await c.query("SELECT * FROM refund_orders WHERE id=$1 AND environment_id=$2",[id,this.config.environmentId])).rows[0];
      if(!initial)throw new ApiError(404,"NOT_FOUND","退款申请不存在");
      await this.account(c,initial.user_id);
      const refund=(await c.query("SELECT * FROM refund_orders WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(refund.status!=="requested")conflict("退款申请已处理");
      const order=(await c.query("SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE",[refund.order_id])).rows[0];
      if(approve){
        const lot=(await c.query("SELECT * FROM point_lots WHERE environment_id=$1 AND source_key=$2 FOR UPDATE",[this.config.environmentId,`payment:${order.id}`])).rows[0];
        if(!lot||num(lot.available)!==order.points||num(lot.frozen)!==0||num(lot.consumed)!==0)throw new ApiError(409,"RESOURCE_IN_USE","本批只支持完全未使用的模拟订单全额退款，部分消费需后续规则");
        await c.query("UPDATE point_lots SET available=0,expired=expired+$2 WHERE id=$1",[lot.id,order.points]);
        await this.movement(c,{userId:order.user_id,key:`payment-refund:${order.id}`,kind:"refund",amount:order.points,available:-order.points,frozen:0,consumed:0,reason,orderId:order.id});
        await c.query("UPDATE payment_orders SET status='refunded' WHERE id=$1",[order.id]);
      }
      await c.query("UPDATE refund_orders SET status=$2,resolution=$3 WHERE id=$1",[id,approve?"succeeded":"rejected",reason]);
      await this.audit(c,actor.generation,actor.userId,"mock_refund_resolved",id);
      await this.event(c,order.user_id,actor.generation,`refund:${id}:resolved`,"billing.test_refund_processed",
        {refundId:id,orderId:order.id,approved:approve,testOnly:true});
      return {id,status:approve?"succeeded":"rejected",testOnly:true};
    });
  }
  async reconcile():Promise<{consistent:boolean;differences:unknown[]}> {
    const result=await this.pool.query(`SELECT a.user_id,a.available,a.frozen,a.consumed,
      COALESCE(SUM(l.available),0) AS lot_available,COALESCE(SUM(l.frozen),0) AS lot_frozen,COALESCE(SUM(l.consumed),0) AS lot_consumed
      FROM point_accounts a LEFT JOIN point_lots l ON l.environment_id=a.environment_id AND l.user_id=a.user_id
      WHERE a.environment_id=$1 GROUP BY a.environment_id,a.user_id
      HAVING a.available<>COALESCE(SUM(l.available),0) OR a.frozen<>COALESCE(SUM(l.frozen),0) OR a.consumed<>COALESCE(SUM(l.consumed),0)`,
      [this.config.environmentId]);
    const ledger=await this.pool.query(`SELECT a.user_id,a.available,a.frozen,a.consumed,
      COALESCE(SUM(t.available_delta),0) AS ledger_available,COALESCE(SUM(t.frozen_delta),0) AS ledger_frozen,COALESCE(SUM(t.consumed_delta),0) AS ledger_consumed
      FROM point_accounts a LEFT JOIN point_transactions t ON t.environment_id=a.environment_id AND t.user_id=a.user_id
      WHERE a.environment_id=$1 GROUP BY a.environment_id,a.user_id
      HAVING a.available<>COALESCE(SUM(t.available_delta),0) OR a.frozen<>COALESCE(SUM(t.frozen_delta),0) OR a.consumed<>COALESCE(SUM(t.consumed_delta),0)`,
      [this.config.environmentId]);
    const differences=[...result.rows.map(row=>({kind:"lot",...row})),...ledger.rows.map(row=>({kind:"ledger",...row}))];
    return {consistent:differences.length===0,differences};
  }
  /** Called only inside the reset transaction while it holds the environment FOR UPDATE lock. */
  async releaseForReset(c:Client,generation:number,operator:string):Promise<number> {
    const tasks=(await c.query<TaskRow>("SELECT * FROM ai_tasks WHERE environment_id=$1 AND status IN ('queued','running') ORDER BY user_id,id FOR UPDATE",
      [this.config.environmentId])).rows;
    for(const task of tasks){
      await this.account(c,task.user_id);
      await this.finalizePoints(c,task,"released");
      await c.query("UPDATE ai_tasks SET status='cancelled',failure_code='ENVIRONMENT_RESET',finished_at=now(),lease_until=NULL,lease_epoch=lease_epoch+1 WHERE id=$1",[task.id]);
      await c.query("UPDATE ai_attempts SET status='superseded' WHERE task_id=$1 AND status='running'",[task.id]);
      await c.query("UPDATE quality_cases SET status='open',resolution='环境重置取消修复，请人工继续处理' WHERE repair_task_id=$1 AND status='repairing'",[task.id]);
      await this.audit(c,generation,operator,"task_cancelled_for_reset",task.id);
      await this.event(c,task.user_id,generation+1,`task:${task.id}:terminal`,"ai.cancelled",{taskId:task.id,reason:"environment-reset"});
    }
    return tasks.length;
  }
}
