import { randomUUID } from "node:crypto";
import { loadConfig } from "../services/api/config";
import { createPool } from "../services/api/db";
import { WalletService } from "../services/api/wallet-store";
import { workerOnce } from "../services/ai-worker/worker";

const config=loadConfig();
const pool=createPool(config);
const service=new WalletService(pool,config);
const workerId=`mock-worker-${randomUUID()}`;
let stopped=false;
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{stopped=true;});
try {
  do {
    const result=await workerOnce(service,workerId);
    if(result.claimed||result.expired||result.notifications)console.log(JSON.stringify(result));
    if(process.argv.includes("--once"))break;
    if(!result.claimed&&!stopped)await new Promise(resolve=>setTimeout(resolve,1000));
  } while(!stopped);
} catch {
  console.error("模拟任务执行器停止：请检查数据库迁移、环境和私有对象目录；未调用真实AI。");
  process.exitCode=1;
} finally { await pool.end(); }
