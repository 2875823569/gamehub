import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { ApiConfig } from "./config";
import { withTransaction } from "./db";
import { ApiError } from "./errors";

/** Amounts are integer millionths of the configured provider currency, never user points. */
export class ProviderBudget {
  constructor(readonly pool:Pool,readonly config:ApiConfig) {}
  async configure(provider:string,dayLimit:number,monthLimit:number,audit?:{actorId:string;generation:number},authorize?:(client:PoolClient)=>Promise<unknown>) {
    if(!provider||![dayLimit,monthLimit].every(n=>Number.isSafeInteger(n)&&n>=0))throw new ApiError(400,"INVALID_REQUEST","预算必须为非负整数");
    await withTransaction(this.pool,async c=>{
      if(authorize)await authorize(c);
      await c.query("SELECT id FROM environments WHERE id=$1 FOR SHARE",[this.config.environmentId]);
      const keys=(await c.query("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,to_char(now() AT TIME ZONE 'UTC','YYYY-MM') AS month")).rows[0];
      for(const [kind,key,limit] of [["day",keys.day,dayLimit],["month",keys.month,monthLimit]]) {
        await c.query(`INSERT INTO provider_budget_accounts(environment_id,provider,period_kind,period_key,limit_micros)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(environment_id,provider,period_kind,period_key) DO UPDATE SET limit_micros=EXCLUDED.limit_micros`,
          [this.config.environmentId,provider,kind,key,limit]);
      }
      if(audit)await c.query(`INSERT INTO audit_events(id,environment_id,generation,actor,action,metadata) VALUES($1,$2,$3,$4,'provider_budget_configured',$5)`,
        [randomUUID(),this.config.environmentId,audit.generation,audit.actorId,{provider,dayLimit,monthLimit}]);
    });
  }
  async reserve(provider:string,callKey:string,amount:number):Promise<string> {
    if(!Number.isSafeInteger(amount)||amount<=0)throw new ApiError(400,"INVALID_REQUEST","成本预留必须是正整数");
    return withTransaction(this.pool,async c=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[this.config.environmentId,`provider:${provider}:${callKey}`]);
      const prior=(await c.query("SELECT * FROM provider_cost_reservations WHERE environment_id=$1 AND provider=$2 AND call_key=$3",[this.config.environmentId,provider,callKey])).rows[0];
      if(prior){
        if(Number(prior.amount_micros)!==amount)throw new ApiError(409,"VERSION_CONFLICT","调用编号已用于不同成本");
        return prior.id;
      }
      const keys=(await c.query("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,to_char(now() AT TIME ZONE 'UTC','YYYY-MM') AS month")).rows[0];
      for(const [kind,key] of [["day",keys.day],["month",keys.month]]) {
        const row=(await c.query(`SELECT * FROM provider_budget_accounts WHERE environment_id=$1 AND provider=$2 AND period_kind=$3 AND period_key=$4 FOR UPDATE`,
          [this.config.environmentId,provider,kind,key])).rows[0];
        if(!row||Number(row.limit_micros)-Number(row.reserved_micros)-Number(row.spent_micros)<amount)
          throw new ApiError(503,"PROVIDER_BUDGET_UNAVAILABLE","真实供应商预算未配置或不足");
        await c.query(`UPDATE provider_budget_accounts SET reserved_micros=reserved_micros+$5 WHERE environment_id=$1 AND provider=$2 AND period_kind=$3 AND period_key=$4`,
          [this.config.environmentId,provider,kind,key,amount]);
      }
      const id=randomUUID();
      await c.query(`INSERT INTO provider_cost_reservations(id,environment_id,provider,call_key,day_key,month_key,amount_micros) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id,this.config.environmentId,provider,callKey,keys.day,keys.month,amount]);
      return id;
    });
  }
  async uncertain(id:string) {
    await this.pool.query("UPDATE provider_cost_reservations SET status='uncertain' WHERE id=$1 AND environment_id=$2 AND status='reserved'",[id,this.config.environmentId]);
  }
  async settle(id:string,actual:number) {
    if(!Number.isSafeInteger(actual)||actual<0)throw new ApiError(400,"INVALID_REQUEST","实际费用必须为非负整数");
    await withTransaction(this.pool,async c=>{
      const reservation=(await c.query("SELECT * FROM provider_cost_reservations WHERE id=$1 AND environment_id=$2 FOR UPDATE",[id,this.config.environmentId])).rows[0];
      if(!reservation)throw new ApiError(404,"NOT_FOUND","成本记录不存在");
      if(reservation.status==="settled"){
        if(Number(reservation.actual_micros)!==actual)throw new ApiError(409,"VERSION_CONFLICT","费用已按不同金额结算");
        return;
      }
      if(actual>Number(reservation.amount_micros))throw new ApiError(409,"RESOURCE_IN_USE","实际费用超过预留，保留占用并转人工核实");
      for(const [kind,key] of [["day",reservation.day_key],["month",reservation.month_key]]) {
        await c.query(`UPDATE provider_budget_accounts SET reserved_micros=reserved_micros-$5,spent_micros=spent_micros+$6
          WHERE environment_id=$1 AND provider=$2 AND period_kind=$3 AND period_key=$4`,
          [this.config.environmentId,reservation.provider,kind,key,reservation.amount_micros,actual]);
      }
      await c.query("UPDATE provider_cost_reservations SET status='settled',actual_micros=$2 WHERE id=$1",[id,actual]);
    });
  }
}
