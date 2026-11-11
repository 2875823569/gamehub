import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../services/api/config";

const valid = {
  GAMEHUB_MODE: "development", GAMEHUB_ENVIRONMENT_ID: "gamehub-test",
  GAMEHUB_DATABASE_URL: "postgresql://user:password@127.0.0.1/test",
  GAMEHUB_TOKEN_SECRET: "a-test-secret-longer-than-thirty-two-bytes",
  GAMEHUB_ALLOWED_ORIGINS: "http://127.0.0.1:5173",
};
test("configuration fails closed for missing secrets, public mode and real providers", () => {
  assert.throws(() => loadConfig({}), /GAMEHUB_MODE/);
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_TOKEN_SECRET: "short" }), /32/);
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_MODE: "public" }), /尚未实现/);
  for (const key of ["GAMEHUB_REAL_PAYMENTS", "GAMEHUB_REAL_AI", "GAMEHUB_REAL_SMS"]) {
    assert.throws(() => loadConfig({ ...valid, [key]: "true" }), /尚未开放/);
  }
});
test("configuration rejects ambiguous numbers, insecure internal origins and SQL identifiers", () => {
  for (const port of ["0", "-1", "65536", "8788oops", "1.5"]) {
    assert.throws(() => loadConfig({ ...valid, GAMEHUB_API_PORT: port }));
  }
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_MODE: "internal" }), /HTTPS/);
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_DATABASE_SCHEMA: "public;drop schema public" }));
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_ALLOWED_ORIGINS: "https://site.example/path" }));
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_ALLOWED_ORIGINS: "http://public.example" }));
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_API_HOST: "0.0.0.0" }));
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_DATABASE_POOL_MAX: "31" }));
  assert.equal(loadConfig({ ...valid, GAMEHUB_DATABASE_POOL_MAX: "20" }).databasePoolMax, 20);
  const internal = loadConfig({ ...valid, GAMEHUB_MODE: "internal", GAMEHUB_ALLOWED_ORIGINS: "https://platform.example" });
  assert.equal(internal.secureCookies, true);
  assert.equal(internal.port, 8788);
});
test("game resources require a different site, not merely another port or subdomain", () => {
  assert.equal(loadConfig(valid).gameOrigin, "http://127.0.0.2:8790");
  assert.throws(() => loadConfig({ ...valid, GAMEHUB_GAME_ORIGIN: "http://127.0.0.1:8790" }), /不同站点/);
  const internal = { ...valid, GAMEHUB_MODE: "internal", GAMEHUB_ALLOWED_ORIGINS: "https://app.example.co.uk" };
  assert.throws(() => loadConfig({ ...internal, GAMEHUB_GAME_ORIGIN: "https://games.example.co.uk" }), /不同站点/);
  assert.equal(loadConfig({ ...internal, GAMEHUB_GAME_ORIGIN: "https://games.exampleusercontent.co.uk" }).gameOrigin, "https://games.exampleusercontent.co.uk");
});
