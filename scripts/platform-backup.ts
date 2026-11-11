import { spawn } from "node:child_process";
import { randomUUID,createHash } from "node:crypto";
import { createReadStream,createWriteStream } from "node:fs";
import { mkdir,readFile,writeFile,rename,stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { resolve,join,basename,dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadConfig,type ApiConfig } from "../services/api/config";

const backupRoot=fileURLToPath(new URL("../work/platform-backups/",import.meta.url));
function docker(args:string[],input?:NodeJS.ReadableStream,output?:NodeJS.WritableStream):Promise<string> {
  return new Promise((resolvePromise,reject)=>{
    const child=spawn("docker",args,{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const chunks:Buffer[]=[];let total=0,streamError:unknown;
    const streams:Promise<unknown>[]=[];
    if(input)streams.push(pipeline(input,child.stdin).catch(error=>{streamError=error;}));else child.stdin.end();
    if(output)streams.push(pipeline(child.stdout,output).catch(error=>{streamError=error;}));
    else child.stdout.on("data",(chunk:Buffer)=>{total+=chunk.length;if(total>1024*1024){child.kill();reject(new Error("Docker结果过大"));}else chunks.push(chunk);});
    child.stderr.resume();
    child.on("error",()=>reject(new Error("Docker不可用")));
    child.on("close",async code=>{
      await Promise.all(streams);
      if(code!==0||streamError)reject(new Error(`Docker ${args[0]} 操作失败，请检查本项目容器`));
      else resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}
export async function verifyLocalDatabaseTarget(config:ApiConfig) {
  const url=new URL(config.databaseUrl);
  if(config.mode!=="development"||!["127.0.0.1","localhost"].includes(url.hostname)||url.port!=="55432"||url.pathname!=="/gamehub_dev"||url.username!=="gamehub")
    throw new Error("此脚本仅操作本项目本机 development/gamehub_dev 数据库");
  const ids=(await docker(["ps","--filter","label=com.docker.compose.project=gamehub-platform-dev","--filter","label=com.docker.compose.service=postgres","--format","{{.ID}}"])).split(/\r?\n/).filter(Boolean);
  if(ids.length!==1||!/^[0-9a-f]{12,64}$/.test(ids[0]))throw new Error("无法唯一确定本项目 PostgreSQL 容器");
  const labels=JSON.parse(await docker(["inspect","--format","{{json .Config.Labels}}",ids[0]]));
  if(labels["com.docker.compose.project"]!=="gamehub-platform-dev"||labels["com.docker.compose.service"]!=="postgres")throw new Error("容器归属不匹配");
  return {containerId:ids[0],url};
}
export async function backupLocalDatabase(config:ApiConfig) {
  const {containerId}=await verifyLocalDatabaseTarget(config);
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(config.databaseSchema))throw new Error("无效备份 Schema");
  await mkdir(backupRoot,{recursive:true});
  const file=join(backupRoot,`gamehub-dev-${randomUUID()}.dump`),temporary=`${file}.tmp`;
  await docker(["exec",containerId,"pg_dump","-U","gamehub","-d","gamehub_dev",`--schema=${config.databaseSchema}`,"--format=custom","--no-owner","--no-acl"],undefined,createWriteStream(temporary,{flags:"wx",mode:0o600}));
  await rename(temporary,file);
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(file))hash.update(chunk);
  const metadata={file:basename(file),createdAt:new Date().toISOString(),database:"gamehub_dev",schema:config.databaseSchema,sha256:hash.digest("hex"),bytes:(await stat(file)).size,scope:"database-schema-only",includesObjectFiles:false,includesSecrets:false};
  await writeFile(`${file}.json`,JSON.stringify(metadata,null,2)+"\n",{flag:"wx",mode:0o600});
  return {path:file,...metadata};
}
export async function restoreDrill(config:ApiConfig,file:string,verify?:(pool:Pool)=>Promise<Record<string,unknown>>) {
  const {containerId,url}=await verifyLocalDatabaseTarget(config);
  const path=resolve(file);
  if(dirname(path)!==resolve(backupRoot)||!/^gamehub-dev-[0-9a-f-]{36}\.dump$/.test(basename(path)))throw new Error("仅接受本脚本生成的备份文件");
  const metadata=JSON.parse(await readFile(`${path}.json`,"utf8"));
  const schema=metadata.schema??"public";
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema)||schema!==config.databaseSchema)throw new Error("备份 Schema 与配置不匹配");
  const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);
  if(hash.digest("hex")!==metadata.sha256)throw new Error("备份摘要不匹配");
  const database=`gamehub_restore_${randomUUID().replaceAll("-","")}`;
  if(!/^gamehub_restore_[0-9a-f]{32}$/.test(database))throw new Error("恢复数据库名称不安全");
  let created=false;const started=Date.now();
  try {
    await docker(["exec",containerId,"createdb","-U","gamehub",database]);created=true;
    await docker(["exec","-i",containerId,"pg_restore","-U","gamehub","-d",database,"--exit-on-error","--no-owner","--no-acl"],createReadStream(path));
    const restored=new URL(url);restored.pathname=`/${database}`;
    const pool=new Pool({connectionString:restored.toString(),options:`-c search_path=${schema}`,connectionTimeoutMillis:5000});
    try {
      const migrations=(await pool.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
      const counts=(await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM games) AS games,(SELECT count(*)::int FROM point_transactions) AS "pointTransactions",
        (SELECT count(*)::int FROM payment_orders) AS "paymentOrders"`)).rows[0];
      const violations=(await pool.query(`SELECT a.user_id FROM point_accounts a LEFT JOIN point_lots l ON l.environment_id=a.environment_id AND l.user_id=a.user_id
        GROUP BY a.environment_id,a.user_id HAVING a.available<>COALESCE(sum(l.available),0) OR a.frozen<>COALESCE(sum(l.frozen),0) OR a.consumed<>COALESCE(sum(l.consumed),0)`)).rowCount;
      if(violations)throw new Error("恢复后点数批次与账户不一致");
      const ledgerViolations=(await pool.query(`SELECT a.user_id FROM point_accounts a LEFT JOIN point_transactions t ON t.environment_id=a.environment_id AND t.user_id=a.user_id
        GROUP BY a.environment_id,a.user_id HAVING a.available<>COALESCE(sum(t.available_delta),0) OR a.frozen<>COALESCE(sum(t.frozen_delta),0) OR a.consumed<>COALESCE(sum(t.consumed_delta),0)`)).rowCount;
      if(ledgerViolations)throw new Error("恢复后点数流水与账户不一致");
      const verification=verify?await verify(pool):undefined;
      return {restored:true,temporaryDatabase:database,temporaryDatabaseRemovedOnExit:true,migrations:migrations.length,counts,elapsedMs:Date.now()-started,
        schema,verification,scope:"database-schema-only",productionRpoRtoVerified:false};
    } finally { await pool.end(); }
  } finally {
    if(created)await docker(["exec",containerId,"dropdb","-U","gamehub",database]);
  }
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)){
  try {
    const config=loadConfig(),command=process.argv[2]??"backup";
    if(command==="backup")console.log(JSON.stringify(await backupLocalDatabase(config),null,2));
    else if(command==="drill"&&process.argv[3])console.log(JSON.stringify(await restoreDrill(config,process.argv[3]),null,2));
    else throw new Error("支持 backup 或 drill <本脚本生成的备份路径>");
  }catch(error){console.error(error instanceof Error?error.message:"备份恢复失败");process.exitCode=1;}
}
