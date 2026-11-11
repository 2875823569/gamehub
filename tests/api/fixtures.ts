import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { createPool } from "../../services/api/db";
import { migrate } from "../../services/api/migrations";
import { buildApp, accessCookieName } from "../../services/api/app";
import type { ApiConfig } from "../../services/api/config";

export const origin = "https://platform.example";
export async function fixture(t: TestContext) {
  const databaseUrl = process.env.GAMEHUB_TEST_DATABASE_URL ??
    "postgresql://gamehub:gamehub-local-only@127.0.0.1:55432/gamehub_dev";
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  // Only this fresh random schema is created/dropped. Existing app tables are never truncated.
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const config: ApiConfig = {
    mode: "internal", environmentId: "gamehub-test", host: "127.0.0.1", port: 8788,
    databaseUrl, databaseSchema: schema, tokenSecret: randomUUID() + randomUUID(),
    allowedOrigins: [origin], secureCookies: true, accessTtlSeconds: 3600,
  };
  const pool = createPool(config);
  let closeApp: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {
      await closeApp?.();
      await pool.end();
      if (!/^test_[0-9a-f]{32}$/.test(schema)) throw new Error("Unsafe test schema");
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await admin.end(); }
  });
  await migrate(pool);
  await pool.query("INSERT INTO environments(id, mode) VALUES ($1,$2)", [config.environmentId, config.mode]);
  const { app, store } = await buildApp(config, pool);
  closeApp = () => app.close();
  await app.ready();
  const exchange = async (invitation?: string) => {
    const grant = invitation ?? (await store.issueInvitation(1, 3600, "test-operator")).invitation;
    return app.inject({ method: "POST", url: "/api/v1/test-access/exchanges", headers: { origin }, payload: { invitation: grant } });
  };
  const enter = async () => {
    const response = await exchange();
    if (response.statusCode !== 201) throw new Error(`Exchange failed: ${response.body}`);
    const token = response.cookies.find(value => value.name === accessCookieName(config))!.value;
    return {
      token, cookie: `${accessCookieName(config)}=${token}`, csrf: response.json().data.csrfToken as string,
    };
  };
  return { app, store, pool, admin, config, exchange, enter };
}
