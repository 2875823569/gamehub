import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./fixtures";
import { migrate } from "../../services/api/migrations";
import { withTransaction } from "../../services/api/db";
const migrationRoot = new URL("../../infra/migrations/", import.meta.url);
async function copyMigrations(directory: string) {
  for (const name of await readdir(migrationRoot)) {
    if (name.endsWith(".sql")) await writeFile(join(directory, name), await readFile(new URL(name, migrationRoot)));
  }
}

test("migrations are serialized and repeatable; changed applied files are rejected", async t => {
  const f = await fixture(t);
  assert.deepEqual(await Promise.all([migrate(f.pool), migrate(f.pool)]), [[], []]);
  const directory = await mkdtemp(join(tmpdir(), "gamehub-migrations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyMigrations(directory);
  const before = (await f.pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n;
  const original = await readFile(new URL("../../infra/migrations/0001_test_access.sql", import.meta.url), "utf8");
  await writeFile(join(directory, "0001_test_access.sql"), `${original}\n-- changed\n`);
  await assert.rejects(() => migrate(f.pool, directory), /内容被修改/);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, before);
});

test("a failed transaction rolls back all writes and releases its connection", async t => {
  const f = await fixture(t);
  await assert.rejects(() => withTransaction(f.pool, async client => {
    await client.query("INSERT INTO environments(id,mode) VALUES ('must-rollback','internal')");
    throw new Error("forced failure");
  }), /forced failure/);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM environments WHERE id='must-rollback'")).rows[0].n, 0);
  assert.deepEqual(await withTransaction(f.pool, async client => (await client.query("SELECT 1 AS n")).rows[0]), { n: 1 });
});

test("failed DDL is rolled back and not recorded as applied", async t => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "gamehub-migrations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyMigrations(directory);
  const before = (await f.pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n;
  await writeFile(join(directory, "9999_failure.sql"), "CREATE TABLE rollback_probe(id integer); SELECT no_such_column;");
  await assert.rejects(() => migrate(f.pool, directory));
  assert.equal((await f.pool.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name, null);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, before);
});
