import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".env") || !existsSync("dist/platform.html")) {
  console.error("请先执行 npm run setup:local、数据库初始化及 npm run build。");
  process.exit(1);
}
const entries = ["services/api/server.ts", "services/assets/server.ts",
  "scripts/platform-worker.ts", "scripts/platform-artifact-worker.ts"];
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const entry of entries) {
  const child = spawn(process.execPath, ["--env-file=.env", ...(existsSync(".env.runtime") ? ["--env-file=.env.runtime"] : []), "--import", "tsx", entry], {
    stdio: "inherit", windowsHide: true,
  });
  children.push(child);
  child.on("error", () => { console.error(`无法启动 ${entry}`); stop(1); });
  child.on("exit", code => { if (!stopping) { console.error(`${entry} 已退出，关闭同组服务`); stop(code || 1); } });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
