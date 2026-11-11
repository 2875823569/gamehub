import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../services/api/config";
import { createPool } from "../services/api/db";

const config = loadConfig();
const pool = createPool(config);
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  environment: config.environmentId, mode: config.mode,
  realAi: "disabled", realSms: "disabled", realPayments: "disabled",
};
try {
  const result = await pool.query("SHOW server_version");
  report.database = { reachable: true, version: result.rows[0].server_version };
} catch { report.database = { reachable: false }; }
finally { await pool.end(); }
const docker = spawnSync("docker", ["info", "--format", "{{json .Runtimes}}"], {
  encoding: "utf8", windowsHide: true, timeout: 15000,
});
let runtimes: string[] = [];
try { if (docker.status === 0) runtimes = Object.keys(JSON.parse(docker.stdout)); } catch { /* report unavailable */ }
report.sandbox = {
  dockerAvailable: docker.status === 0, runtimes,
  runscRegistered: runtimes.includes("runsc"),
  validated: false,
  reason: runtimes.includes("runsc") ? "需完成资源、出网、恶意样例及兼容性验收" : "缺少独立 Linux 强隔离执行运行时；普通 runc 不作为验收通过",
};
await mkdir(resolve("work/platform"), { recursive: true });
await writeFile(resolve("work/platform/doctor.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
