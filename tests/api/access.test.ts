import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../services/api/app";
import { newToken } from "../../services/api/tokens";
import { fixture, origin } from "./fixtures";

test("INT-01: concurrent redemption cannot exceed one-use invitation; credentials never stored in plaintext", async t => {
  const f = await fixture(t);
  const grant = await f.store.issueInvitation(1, 3600, "operator");
  const results = await Promise.all(Array.from({ length: 16 }, () => f.exchange(grant.invitation)));
  assert.equal(results.filter(result => result.statusCode === 201).length, 1);
  assert.equal(results.filter(result => result.statusCode === 403).length, 15);
  assert.equal((await f.pool.query("SELECT used_count FROM test_access_grants")).rows[0].used_count, 1);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM test_access_sessions")).rows[0].n, 1);
  const stored = JSON.stringify((await f.pool.query("SELECT * FROM test_access_grants")).rows);
  assert.ok(!stored.includes(grant.invitation));
  const response = results.find(result => result.statusCode === 201)!;
  assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(response.headers["set-cookie"]), /Secure/);
  assert.match(String(response.headers["set-cookie"]), /SameSite=Strict/);
  assert.ok(!String(response.headers["set-cookie"]).includes("Domain="));
  assert.equal(response.headers["cache-control"], "no-store");
});

test("INT-02: access grants guest identity only; concurrent creation is stable and nickname does not identify a person", async t => {
  const f = await fixture(t);
  const a = await f.enter();
  const headers = { origin, cookie: a.cookie, "x-csrf-token": a.csrf };
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.app.inject({
    method: "POST", url: "/api/v1/guest-sessions", headers, payload: { nickname: "测试游客" },
  })));
  assert.ok(replies.every(reply => reply.statusCode === 200), replies.map(r => r.body).join("\n"));
  assert.equal(new Set(replies.map(reply => reply.json().data.id)).size, 1);
  const b = await f.enter();
  const other = await f.app.inject({
    method: "POST", url: "/api/v1/guest-sessions",
    headers: { origin, cookie: b.cookie, "x-csrf-token": b.csrf }, payload: { nickname: "测试游客" },
  });
  assert.notEqual(other.json().data.id, replies[0].json().data.id);
  const current = await f.app.inject({ url: "/api/v1/test-access/sessions/current", headers: { cookie: a.cookie } });
  assert.deepEqual(current.json().data.capabilities, { play: true, create: false, admin: false });
  const unauthorized = await f.app.inject({ url: "/api/v1/guest-sessions/current" });
  assert.equal(unauthorized.statusCode, 403);
  assert.equal(unauthorized.json().error.code, "TEST_ACCESS_REQUIRED");
});

test("Origin, CSRF, strict request schema and nickname validation cannot be bypassed", async t => {
  const f = await fixture(t);
  const a = await f.enter();
  const request = { method: "POST" as const, url: "/api/v1/guest-sessions", payload: { nickname: "游客" } };
  for (const headers of [
    { cookie: a.cookie, origin: "https://attacker.example", "x-csrf-token": a.csrf },
    { cookie: a.cookie, origin, "x-csrf-token": newToken() },
    { cookie: a.cookie, origin, "x-csrf-token": a.csrf, "sec-fetch-site": "cross-site" },
  ]) {
    assert.equal((await f.app.inject({ ...request, headers })).statusCode, 403);
  }
  assert.equal((await f.app.inject({ ...request, headers: { cookie: a.cookie } })).statusCode, 403);
  const headers = { origin, cookie: a.cookie, "x-csrf-token": a.csrf };
  for (const payload of [{ nickname: " " }, { nickname: "坏\u0000名" }, { nickname: "a", userId: "admin" }, { nickname: 42 }]) {
    assert.equal((await f.app.inject({ ...request, headers, payload })).statusCode, 400);
  }
  const invalidScope = await f.app.inject({
    method: "POST", url: "/api/v1/test-access/exchanges", headers: { origin },
    payload: { invitation: newToken(), scope: "public", generation: 999 },
  });
  assert.equal(invalidScope.statusCode, 400);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM guest_sessions")).rows[0].n, 0);
});

test("revoking an invitation invalidates issued sessions and prevents future exchanges", async t => {
  const f = await fixture(t);
  const grant = await f.store.issueInvitation(3, 3600, "operator");
  const response = await f.exchange(grant.invitation);
  const token = response.cookies[0].value;
  assert.ok(await f.store.current(token));
  assert.equal(await f.store.revokeInvitation(grant.id, "operator"), true);
  await assert.rejects(() => f.store.current(token), { code: "TEST_ACCESS_REQUIRED" });
  assert.equal((await f.exchange(grant.invitation)).statusCode, 403);
  assert.equal(await f.store.revokeInvitation(grant.id, "operator"), false);
});

test("exiting access revokes the credential server-side and clears the cookie", async t => {
  const f = await fixture(t);
  const a = await f.enter();
  const response = await f.app.inject({
    method: "DELETE", url: "/api/v1/test-access/sessions/current",
    headers: { origin, cookie: a.cookie, "x-csrf-token": a.csrf },
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["set-cookie"]), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await f.app.inject({ url: "/api/v1/test-access/sessions/current", headers: { cookie: a.cookie } })).statusCode, 403);
});

test("INT-06: generation change rejects old invites and sessions; cross-environment credentials fail", async t => {
  const f = await fixture(t);
  const a = await f.enter();
  const grant = await f.store.issueInvitation(2, 3600, "operator");
  await f.pool.query("INSERT INTO environments(id, mode) VALUES ('another-environment', 'internal')");
  const other = await buildApp({ ...f.config, environmentId: "another-environment" }, f.pool);
  try {
    const cross = await other.app.inject({ url: "/api/v1/test-access/sessions/current", headers: { cookie: a.cookie } });
    assert.equal(cross.statusCode, 403);
  } finally { await other.app.close(); }
  await f.pool.query("UPDATE environments SET generation = generation + 1 WHERE id=$1", [f.config.environmentId]);
  await assert.rejects(() => f.store.current(a.token), { code: "TEST_ACCESS_REQUIRED" });
  assert.equal((await f.exchange(grant.invitation)).statusCode, 403);
  assert.equal((await f.exchange()).statusCode, 201);
});

test("expired access and invites fail; pausing environment prevents both old and new access", async t => {
  const f = await fixture(t);
  const grant = await f.store.issueInvitation(2, 3600, "operator");
  await f.pool.query("UPDATE test_access_grants SET expires_at=now()-interval '1 second' WHERE id=$1", [grant.id]);
  assert.equal((await f.exchange(grant.invitation)).statusCode, 403);
  const a = await f.enter();
  await f.pool.query("UPDATE test_access_sessions SET expires_at=now()-interval '1 second'");
  await assert.rejects(() => f.store.current(a.token), { code: "TEST_ACCESS_REQUIRED" });
  const b = await f.enter();
  await f.pool.query("UPDATE environments SET accepting_access=false");
  await assert.rejects(() => f.store.current(b.token), { code: "TEST_ACCESS_REQUIRED" });
  await assert.rejects(() => f.store.issueInvitation(1, 3600, "operator"), { code: "TEST_ACCESS_REQUIRED" });
});

test("failed attempts persist rate limits; arbitrary forwarded IP does not bypass limits", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) {
    const response = await f.app.inject({
      method: "POST", url: "/api/v1/test-access/exchanges",
      headers: { origin, "x-forwarded-for": `192.0.2.${i}` }, payload: { invitation: newToken() },
    });
    assert.equal(response.statusCode, 403);
  }
  const response = await f.exchange(newToken());
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "60");
  assert.equal((await f.pool.query("SELECT sum(attempts)::int AS n FROM access_rate_limits")).rows[0].n, 61);
});

test("API responds with minimal health and sanitized errors, without internal admin shortcuts", async t => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ url: "/health/ready" })).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/api/v1/admin/test-access-grants" })).statusCode, 403);
  const response = await f.app.inject({
    method: "POST", url: "/api/v1/test-access/exchanges",
    headers: { origin, "content-type": "application/json", "x-request-id": "forged-request-id" }, payload: "{",
  });
  assert.equal(response.statusCode, 400);
  assert.notEqual(response.json().requestId, "forged-request-id");
  assert.ok(!response.body.includes("SyntaxError"));
  await f.pool.query("UPDATE environments SET mode='development'");
  const unready = await f.app.inject({ url: "/health/ready" });
  assert.equal(unready.statusCode, 503);
  assert.ok(!unready.body.includes("SELECT"));
  const spec = f.app.swagger();
  assert.ok("openapi" in spec);
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(Object.keys(spec.paths ?? {}).includes("/api/v1/test-access/exchanges"));
  assert.ok(!Object.keys(spec.paths ?? {}).some(path => path.includes("sms-code")));
});
