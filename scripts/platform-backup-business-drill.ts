import { randomUUID,createHash } from "node:crypto";
import { resolve,join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile,writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig,type ApiConfig } from "../services/api/config";
import { createPool,withTransaction } from "../services/api/db";
import { migrate } from "../services/api/migrations";
import { prepareAiCandidate,createAiCandidate } from "../services/api/catalog-store";
import { mockFiles } from "../services/ai-worker/worker";
import type { ClaimedTask } from "../services/api/wallet-store";
import { backupLocalDatabase,restoreDrill } from "./platform-backup";
import { assertLocalBackup,backupPrivateObjects,restorePrivateObjectsDrill } from "./platform-object-backup";

const tables=["environments","users","games","projects","game_versions","point_accounts","point_lots","point_transactions",
  "payment_orders","ai_quotes","ai_tasks","point_allocations","point_freeze_results","audit_events"] as const;
async function fingerprints(pool:Pool) {
  const output:Record<string,{count:number;sha256:string}>={};
  for(const table of tables){
    const rows=(await pool.query(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
    output[table]={count:rows.length,sha256:createHash("sha256").update(JSON.stringify(rows)).digest("hex")};
  }
  return output;
}
export async function businessRestoreDrill(base:ApiConfig) {
  assertLocalBackup(base);
  const started=Date.now(),schema=`backup_drill_${randomUUID().replaceAll("-","")}`;
  if(!/^backup_drill_[0-9a-f]{32}$/.test(schema))throw new Error("无效演练 Schema");
  const config={...base,databaseSchema:schema},admin=new Pool({connectionString:base.databaseUrl,connectionTimeoutMillis:5000});
  const pool=createPool(config);let created=false;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(pool);
    const userId=randomUUID(),gameId=randomUUID(),projectId=randomUUID(),orderId=randomUUID(),taskId=randomUUID(),quoteId=randomUUID(),lotId=randomUUID();
    await pool.query("INSERT INTO environments(id,mode) VALUES($1,'development')",[config.environmentId]);
    await pool.query("INSERT INTO users(id,environment_id,nickname,terms_version) VALUES($1,$2,'恢复演练账号','internal-v1')",[userId,config.environmentId]);
    await pool.query("INSERT INTO games(id,environment_id,owner_id,title) VALUES($1,$2,$3,'恢复演练私有作品')",[gameId,config.environmentId,userId]);
    await pool.query("INSERT INTO projects(id,game_id,owner_id,draft) VALUES($1,$2,$3,$4)",[projectId,gameId,userId,{text:"恢复后必须保留的私有草稿"}]);
    const generated=mockFiles({prompt:"备份恢复演练",mode:"create"} as ClaimedTask);
    const prepared=await prepareAiCandidate(config,generated.files,generated.manifest);
    const version=await withTransaction(pool,client=>createAiCandidate(client,{environmentId:config.environmentId,generation:1,userId,gameId,prepared,sourceLabel:"backup-drill-mock"}));
    await pool.query(`INSERT INTO payment_orders(id,environment_id,generation,user_id,idempotency_key,request_digest,product_id,rule_version,channel,amount_minor,points,status,expires_at,paid_at)
      VALUES($1,$2,1,$3,'backup-drill','backup-drill','test-100','mock-v1','mock',100,100,'paid',now()+interval '1 day',now())`,[orderId,config.environmentId,userId]);
    await pool.query(`INSERT INTO ai_quotes(id,environment_id,generation,user_id,game_id,project_id,workspace_revision,prompt,mode,points,expires_at)
      VALUES($1,$2,1,$3,$4,$5,0,'恢复演练','create',10,now()+interval '1 day')`,[quoteId,config.environmentId,userId,gameId,projectId]);
    await pool.query(`INSERT INTO ai_tasks(id,environment_id,generation,user_id,quote_id,idempotency_key,request_digest,points,status,deadline_at,finished_at,output_version_id)
      VALUES($1,$2,1,$3,$4,'backup-drill','backup-drill',10,'succeeded',now(),now(),$5)`,[taskId,config.environmentId,userId,quoteId,version.id]);
    await pool.query("INSERT INTO point_accounts(environment_id,user_id,available,consumed) VALUES($1,$2,90,10)",[config.environmentId,userId]);
    await pool.query(`INSERT INTO point_lots(id,environment_id,user_id,source,source_key,initial,available,consumed)
      VALUES($1,$2,$3,'test_payment',$4,100,90,10)`,[lotId,config.environmentId,userId,`payment:${orderId}`]);
    const movements=[["grant",100,100,0,0],["freeze",10,-10,10,0],["settle",10,0,-10,10]];
    for(const [kind,amount,available,frozen,consumed] of movements)await pool.query(
      `INSERT INTO point_transactions(id,environment_id,user_id,business_key,kind,amount,available_delta,frozen_delta,consumed_delta,reason,task_id,order_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'备份恢复演练',$10,$11)`,
      [randomUUID(),config.environmentId,userId,`drill:${kind}`,kind,amount,available,frozen,consumed,kind==="grant"?null:taskId,kind==="grant"?orderId:null]);
    await pool.query("INSERT INTO point_allocations(task_id,lot_id,amount) VALUES($1,$2,10)",[taskId,lotId]);
    await pool.query("INSERT INTO point_freeze_results(task_id,outcome) VALUES($1,'settled')",[taskId]);
    await pool.query("INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id) VALUES($1,$2,1,'backup-drill','recovery_fixture_created',$3)",[randomUUID(),config.environmentId,gameId]);
    const expected=await fingerprints(pool);
    const databaseBackup=await backupLocalDatabase(config);
    const objectsBackup=await backupPrivateObjects(config),objectsRestore=await restorePrivateObjectsDrill(config,objectsBackup.path);
    const databaseRestore=await restoreDrill(config,databaseBackup.path,async restored=>{
      const actual=await fingerprints(restored);
      if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error("恢复后的业务记录与备份前不一致");
      const references=(await restored.query("SELECT files FROM game_versions")).rows;
      let verifiedReferences=0;
      for(const row of references)for(const file of Object.values(row.files) as {digest:string}[]){
        if(!/^[0-9a-f]{64}$/.test(file.digest))throw new Error("数据库对象引用无效");
        const bytes=await readFile(join(objectsRestore.path,file.digest));
        if(createHash("sha256").update(bytes).digest("hex")!==file.digest)throw new Error("恢复数据库的对象引用不完整");
        verifiedReferences++;
      }
      return {businessTablesVerified:tables.length,recordFingerprints:actual,verifiedObjectReferences:verifiedReferences};
    });
    const report={schema,fixtureOnly:true,sourceBusinessDataUntouched:true,sourceSchemaRemovedOnExit:true,databaseBackup,objectsBackup,objectsRestore,databaseRestore,elapsedMs:Date.now()-started};
    const reportPath=join(resolve("work/platform-backups"),`gamehub-business-drill-${randomUUID()}.json`);
    await writeFile(reportPath,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
    return {reportPath,...report};
  }finally{
    await pool.end();
    try{if(created){if(!/^backup_drill_[0-9a-f]{32}$/.test(schema))throw new Error("禁止清理非演练 Schema");await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}}
    finally{await admin.end();}
  }
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await businessRestoreDrill(loadConfig()),null,2));}
  catch(error){console.error(error instanceof Error?error.message:"业务恢复演练失败");process.exitCode=1;}
}
