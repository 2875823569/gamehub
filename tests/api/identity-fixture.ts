import assert from "node:assert/strict";
import type { fixture } from "./fixtures";
import { origin } from "./fixtures";
import { IdentityService, accountCookieName } from "../../services/api/identity-store";

type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function testLogin(f: Fixture, phone = "13800000001", roles: string[] = []) {
  const service = new IdentityService(f.pool, f.config);
  await service.allowTestPhone(phone, "test-operator");
  const access = await f.enter();
  const accessHeaders = { origin, cookie: access.cookie, "x-csrf-token": access.csrf };
  const sms = await f.app.inject({ method: "POST", url: "/api/v1/auth/sms-challenges", headers: accessHeaders, payload: { phone, purpose: "login" } });
  assert.equal(sms.statusCode, 200, sms.body);
  const challengeId = sms.json().data.challengeId as string;
  const code = await service.readTestCode(challengeId);
  const response = await f.app.inject({ method: "POST", url: "/api/v1/auth/sessions", headers: accessHeaders,
    payload: { challengeId, code, acceptTerms: true, termsVersion: "internal-v1" } });
  assert.equal(response.statusCode, 201, response.body);
  const user = response.json().data.user as { id: string; nickname: string; status: string };
  const token = response.cookies.find(c => c.name === accountCookieName(f.config, "user"))!.value;
  const cookie = `${access.cookie}; ${accountCookieName(f.config, "user")}=${token}`;
  const csrf = response.json().data.csrfToken as string;
  for (const role of roles) await service.grantRole(user.id, role, "test-operator");
  const base = { service, access, user, token, cookie, csrf, headers: { origin, cookie, "x-csrf-token": csrf } };
  if (!roles.length) return { ...base, admin: undefined };
  // Test-only SQL moves the already-created challenge's send time past its cooldown.
  await f.pool.query("UPDATE sms_challenges SET created_at=now()-interval '61 seconds' WHERE id=$1", [challengeId]);
  const adminSms = await f.app.inject({ method: "POST", url: "/api/v1/auth/sms-challenges", headers: accessHeaders, payload: { phone, purpose: "admin" } });
  assert.equal(adminSms.statusCode, 200, adminSms.body);
  const adminId = adminSms.json().data.challengeId;
  const adminResponse = await f.app.inject({ method: "POST", url: "/api/v1/auth/sessions", headers: accessHeaders,
    payload: { challengeId: adminId, code: await service.readTestCode(adminId) } });
  assert.equal(adminResponse.statusCode, 201, adminResponse.body);
  const adminToken = adminResponse.cookies.find(c => c.name === accountCookieName(f.config, "admin"))!.value;
  const adminCookie = `${cookie}; ${accountCookieName(f.config, "admin")}=${adminToken}`;
  const adminCsrf = adminResponse.json().data.csrfToken as string;
  return { ...base, admin: { token: adminToken, cookie: adminCookie, csrf: adminCsrf,
    headers: { origin, cookie: adminCookie, "x-csrf-token": adminCsrf } } };
}
