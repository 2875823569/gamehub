import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Pool } from "pg";

const migrationDirectory = fileURLToPath(new URL("../../infra/migrations/", import.meta.url));

export async function migrate(pool: Pool, directory = migrationDirectory): Promise<string[]> {
  const files = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length || new Set(files.map(name => name.slice(0, 4))).size !== files.length) {
    throw new Error("迁移文件为空或版本号重复");
  }
  const client = await pool.connect();
  const applied: string[] = [];
  let locked = false;
  let broken = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext(current_database()), hashtext(current_schema() || ':gamehub-migrations'))");
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations ORDER BY version");
    if (existing.rows.some(row => !files.includes(row.version))) throw new Error("数据库包含当前代码缺失的迁移，停止执行");
    const sources = await Promise.all(files.map(async version => {
      const sql = await readFile(join(directory, version), "utf8");
      return { version, sql, checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex") };
    }));
    for (const row of existing.rows) {
      if (sources.find(source => source.version === row.version)?.checksum !== row.checksum) {
        throw new Error(`已应用迁移内容被修改：${row.version}`);
      }
    }
    for (const source of sources) {
      if (existing.rows.some(row => row.version === source.version)) continue;
      if (existing.rows.some(row => row.version > source.version)) throw new Error("不得插入早于已应用版本的新迁移");
      await client.query("BEGIN");
      try {
        await client.query(source.sql);
        await client.query("INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)", [source.version, source.checksum]);
        await client.query("COMMIT");
        applied.push(source.version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext(current_database()), hashtext(current_schema() || ':gamehub-migrations'))"); }
      catch { broken = true; }
    }
    client.release(broken);
  }
}
