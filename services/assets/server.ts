import { loadConfig } from "../api/config";
import { createPool } from "../api/db";
import { buildAssetsApp } from "./app";
const config = loadConfig();
if (!config.gameOrigin) throw new Error("需先配置独立的 GAMEHUB_GAME_ORIGIN");
const pool = createPool(config);
pool.on("error", () => console.error("资源服务数据库连接异常"));
const app = await buildAssetsApp(config, pool);
app.addHook("onClose", () => pool.end());
try {
  const host = config.mode === "development" ? new URL(config.gameOrigin).hostname : config.host;
  await app.listen({ host, port: config.assetsPort ?? 8790 });
  console.log(`游戏资源服务已监听 ${host}:${config.assetsPort ?? 8790}`);
} catch { console.error("资源服务启动失败"); await app.close(); process.exitCode = 1; }
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
