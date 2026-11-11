import { loadConfig } from "../services/api/config";
import { createPool } from "../services/api/db";
import { runArtifactJob } from "../services/api/artifact-worker";
const config = loadConfig(), pool = createPool(config);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; });
try {
  do {
    const worked = await runArtifactJob(pool, config);
    if (process.argv.includes("--once")) { console.log(JSON.stringify({ worked })); break; }
    if (!worked) await new Promise(resolve => setTimeout(resolve, 500));
  } while (!stopping);
} catch { console.error("文件任务执行失败，请检查数据库、对象存储与任务记录"); process.exitCode = 1; }
finally { await pool.end(); }
