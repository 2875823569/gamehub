import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db";
import { registerPlatformWeb } from "./web";

const config = loadConfig();
const pool = createPool(config);
const { app, store } = await buildApp(config, pool, true);
await registerPlatformWeb(app, config);
pool.on("error", () => app.log.error({ category: "database_pool" }, "数据库连接异常"));
let maintenance: ReturnType<typeof setInterval> | undefined;
let shuttingDown: Promise<void> | undefined;
function shutdown() {
  return shuttingDown ??= (async () => {
  if (maintenance) clearInterval(maintenance);
  try { await app.close(); } finally { await pool.end(); }
  })();
}
try {
  await store.assertEnvironment();
  maintenance = setInterval(() => {
    void store.pruneRateLimits().catch(() => app.log.error({ category: "rate_limit_cleanup" }, "限流记录清理失败"));
  }, 60000);
  maintenance.unref();
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.error("API 启动失败，请检查配置、迁移与环境初始化");
  await shutdown();
  process.exitCode = 1;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void shutdown(); });
}
