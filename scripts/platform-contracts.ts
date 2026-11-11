import { readFile, writeFile } from "node:fs/promises";
import { buildApp } from "../services/api/app";
import { createPool } from "../services/api/db";
import type { ApiConfig } from "../services/api/config";

// Generating contracts requires no running database and never loads deployment secrets.
const config: ApiConfig = {
  mode: "internal", environmentId: "contract-generation", host: "127.0.0.1", port: 8788,
  databaseUrl: "postgresql://unused@127.0.0.1/unused", databaseSchema: "public",
  tokenSecret: "contract-generation-not-a-deployment-secret",
  allowedOrigins: ["https://platform.example"], secureCookies: true, accessTtlSeconds: 3600,
};
const pool = createPool(config);
const { app } = await buildApp(config, pool);
try {
  await app.ready();
  const document = `${JSON.stringify(app.swagger(), null, 2)}\n`;
  const path = new URL("../packages/contracts/openapi.json", import.meta.url);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")).replace(/\r\n/g, "\n") !== document) {
      throw new Error("OpenAPI 已过期，请运行 npm run contracts:generate");
    }
    console.log("OpenAPI 与已实现路由一致");
  } else {
    await writeFile(path, document);
    console.log("已生成 packages/contracts/openapi.json");
  }
} finally {
  await app.close();
  await pool.end();
}
