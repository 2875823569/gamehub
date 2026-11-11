import test from "node:test";
import assert from "node:assert/strict";
import { fixture, origin } from "./fixtures";
import { testLogin } from "./identity-fixture";
import { IdentityService, accountCookieName } from "../../services/api/identity-store";
import type { FastifyRequest } from "fastify";
import { accessCookieName } from "../../services/api/app";
import { seedOfficialCatalog } from "../../services/api/catalog-seed";

test("AUTH-02: whitelisted random-code registration encrypts phone and separates guest/account CSRF", async t => {
  const f = await fixture(t), login = await testLogin(f);
  const me = await f.app.inject({ url: "/api/v1/me", headers: { cookie: login.cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().data.id, login.user.id);
  assert.equal(me.json().data.avatarKey,"dice");
  const records = await f.pool.query("SELECT phone_ciphertext,phone_digest FROM phone_bindings");
  assert.ok(!JSON.stringify(records.rows).includes("13800000001"));
  assert.equal(login.service.decrypt(records.rows[0].phone_ciphertext, "phone"), "13800000001");
  const denied = await f.app.inject({ method: "PATCH", url: "/api/v1/me/profile",
    headers: { ...login.headers, "x-csrf-token": login.access.csrf }, payload: { nickname: "新昵称" } });
  assert.equal(denied.statusCode, 403);
  const updated = await f.app.inject({ method: "PATCH", url: "/api/v1/me/profile", headers: login.headers, payload: { nickname: "新昵称",avatarKey:"fox" } });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().data.nickname, "新昵称");
  assert.equal(updated.json().data.avatarKey,"fox");
  assert.equal((await f.app.inject({method:"PATCH",url:"/api/v1/me/profile",headers:login.headers,payload:{avatarKey:"https://outside.example/avatar.png"}})).statusCode,400);
  assert.equal((await f.app.inject({method:"PATCH",url:"/api/v1/me/profile",headers:login.headers,payload:{}})).statusCode,400);
  const avatarOnly=await f.app.inject({method:"PATCH",url:"/api/v1/me/profile",headers:login.headers,payload:{avatarKey:"panda"}});
  assert.equal(avatarOnly.statusCode,200);assert.equal(avatarOnly.json().data.nickname,"新昵称");
  const compatible=await f.app.inject({method:"PATCH",url:"/api/v1/me/profile",headers:login.headers,payload:{nickname:"只改昵称"}});
  assert.equal(compatible.statusCode,200);assert.equal(compatible.json().data.avatarKey,"panda");
  assert.equal((await f.app.inject({url:"/api/v1/auth/sessions/current",headers:{cookie:login.cookie}})).json().data.user.avatarKey,"panda");
  await assert.rejects(()=>f.pool.query("UPDATE users SET avatar_key='unknown' WHERE id=$1",[login.user.id]),{code:"23514"});
  const guest = await f.app.inject({ url: "/api/v1/me", headers: { cookie: login.access.cookie } });
  assert.equal(guest.statusCode, 401);
  assert.equal((await f.app.inject({ url: "/api/v1/admin/users", headers: { cookie: login.cookie } })).statusCode, 401);
});

test("PROFILE: invited guest sees only approved published author works without private account fields",async t=>{
  const f=await fixture(t),login=await testLogin(f,"13800000221");
  await seedOfficialCatalog(f.pool,f.config);
  const author=(await f.pool.query("SELECT id FROM users WHERE terms_version='official-system'")).rows[0];
  const games=(await f.pool.query("SELECT id,current_version_id FROM games WHERE owner_id=$1 ORDER BY id",[author.id])).rows;
  await f.pool.query("UPDATE game_versions SET review_status='pending' WHERE id=$1",[games[0].current_version_id]);
  await f.pool.query("UPDATE games SET restricted=true WHERE id=$1",[games[1].id]);
  await f.pool.query("UPDATE games SET deleted_at=now() WHERE id=$1",[games[2].id]);
  await f.pool.query("DELETE FROM publication_heads WHERE game_id=$1",[games[3].id]);
  await f.pool.query("UPDATE games SET archived_at=now() WHERE id=$1",[games[4].id]);
  const visible=await f.app.inject({url:`/api/v1/authors/${author.id}`,headers:{cookie:login.access.cookie}});
  assert.equal(visible.statusCode,200,visible.body);
  const profile=visible.json().data;
  assert.deepEqual(Object.keys(profile).sort(),["avatarKey","games","id","nickname"]);
  assert.equal(profile.games.length,7);
  for(const hidden of games.slice(0,5))assert.ok(!profile.games.some((game:{id:string})=>game.id===hidden.id));
  for(const game of profile.games)assert.deepEqual(Object.keys(game).sort(),["category","description","id","title","versionId"]);
  assert.ok(!/phone|balance|wallet|session|status|terms_version/.test(visible.body));
  assert.equal((await f.app.inject({url:`/api/v1/authors/${author.id}`})).statusCode,403);
  const draft=await f.app.inject({method:"POST",url:"/api/v1/creator/games",headers:login.headers,payload:{title:"私有草稿"}});
  assert.equal(draft.statusCode,200);
  const own=await f.app.inject({url:`/api/v1/authors/${login.user.id}`,headers:{cookie:login.access.cookie}});
  assert.deepEqual(own.json().data.games,[]);
  await f.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[author.id]);
  assert.equal((await f.app.inject({url:`/api/v1/authors/${author.id}`,headers:{cookie:login.access.cookie}})).statusCode,404);
  const otherEnvironment="profile-other";
  await f.pool.query("INSERT INTO environments(id,mode)VALUES($1,'internal')",[otherEnvironment]);
  const foreign=(await f.pool.query("INSERT INTO users(id,environment_id,nickname,terms_version)VALUES(gen_random_uuid(),$1,'其他环境','test') RETURNING id",[otherEnvironment])).rows[0];
  assert.equal((await f.app.inject({url:`/api/v1/authors/${foreign.id}`,headers:{cookie:login.access.cookie}})).statusCode,404);
});

test("AUTH-03: non-whitelisted numbers, cooldown, exhausted codes, expiry and replay fail closed", async t => {
  const f = await fixture(t), service = new IdentityService(f.pool, f.config), access = await f.enter();
  const headers = { origin, cookie: access.cookie, "x-csrf-token": access.csrf };
  const requestSms = () => f.app.inject({ method: "POST", url: "/api/v1/auth/sms-challenges", headers, payload: { phone: "13800000002", purpose: "login" } });
  assert.equal((await requestSms()).statusCode, 403);
  await service.allowTestPhone("13800000002", "test");
  const sms = await requestSms();
  assert.equal(sms.statusCode, 200);
  assert.ok(!sms.body.includes("code"));
  assert.equal((await requestSms()).statusCode, 429);
  const challengeId = sms.json().data.challengeId, real = await service.readTestCode(challengeId);
  const submit = (code: string) => f.app.inject({ method: "POST", url: "/api/v1/auth/sessions", headers,
    payload: { challengeId, code, acceptTerms: true, termsVersion: "internal-v1" } });
  for (let i = 0; i < 5; i++) assert.equal((await submit(real === "000000" ? "111111" : "000000")).statusCode, 400);
  assert.equal((await submit(real)).statusCode, 400);
  assert.equal((await f.pool.query("SELECT attempts FROM sms_challenges WHERE id=$1", [challengeId])).rows[0].attempts, 5);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 0);
});

test("AUTH-02/03: register consent required; concurrent same challenge creates only one account and consumed code is rejected", async t => {
  const f = await fixture(t), service = new IdentityService(f.pool, f.config), access = await f.enter();
  const headers = { origin, cookie: access.cookie, "x-csrf-token": access.csrf };
  await service.allowTestPhone("13800000003", "test");
  const sms = await f.app.inject({ method: "POST", url: "/api/v1/auth/sms-challenges", headers, payload: { phone: "13800000003", purpose: "login" } });
  const challengeId = sms.json().data.challengeId, code = await service.readTestCode(challengeId);
  const noConsent = await f.app.inject({ method: "POST", url: "/api/v1/auth/sessions", headers, payload: { challengeId, code } });
  assert.equal(noConsent.statusCode, 400);
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.app.inject({
    method: "POST", url: "/api/v1/auth/sessions", headers, payload: { challengeId, code, acceptTerms: true, termsVersion: "internal-v1" },
  })));
  assert.equal(responses.filter(r => r.statusCode === 201).length, 1);
  assert.equal(responses.filter(r => r.statusCode === 400).length, 3);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 1);
  await assert.rejects(() => service.readTestCode(challengeId));
});

test("AUTH-04/05: session ownership, revocation and test generation apply to registered users", async t => {
  const f = await fixture(t), first = await testLogin(f, "13800000004"), second = await testLogin(f, "13800000005");
  const sessions = await f.app.inject({ url: "/api/v1/me/sessions", headers: { cookie: second.cookie } });
  const id = sessions.json().data[0].id;
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/v1/me/sessions/${id}`, headers: first.headers })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/v1/me/sessions/${id}`, headers: second.headers })).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/api/v1/me", headers: { cookie: second.cookie } })).statusCode, 401);
  await f.pool.query("UPDATE environments SET generation=generation+1");
  assert.equal((await f.app.inject({ url: "/api/v1/me", headers: { cookie: first.cookie } })).statusCode, 403);
});

test("AUTH-06: independent administrator login restricts capabilities and all restriction revokes ordinary sessions", async t => {
  const f = await fixture(t), admin = await testLogin(f, "13800000006", ["super_admin"]), member = await testLogin(f, "13800000007");
  assert.ok(admin.admin);
  const current = await f.app.inject({ url: "/api/v1/admin/auth/sessions/current", headers: { cookie: admin.admin.cookie } });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().data.kind, "admin");
  const denied = await f.app.inject({ method: "POST", url: `/api/v1/admin/users/${member.user.id}/restrictions`,
    headers: { ...admin.admin.headers, "x-csrf-token": admin.csrf }, payload: { capability: "comment", reason: "test" } });
  assert.equal(denied.statusCode, 403);
  const restricted = await f.app.inject({ method: "POST", url: `/api/v1/admin/users/${member.user.id}/restrictions`,
    headers: admin.admin.headers, payload: { capability: "comment", reason: "test" } });
  assert.equal(restricted.statusCode, 200, restricted.body);
  await assert.rejects(() => member.service.checkRestrictions(f.pool, member.user.id, "comment"), { code: "ACCOUNT_RESTRICTED" });
  await member.service.checkRestrictions(f.pool, member.user.id, "create");
  const all = await f.app.inject({ method: "POST", url: `/api/v1/admin/users/${member.user.id}/restrictions`,
    headers: admin.admin.headers, payload: { capability: "all", reason: "test" } });
  assert.equal(all.statusCode, 200);
  assert.equal((await f.app.inject({ url: "/api/v1/me", headers: { cookie: member.cookie } })).statusCode, 401);
});

test("AUTH-05: phone change verifies old and new numbers, retains account identity and revokes existing sessions", async t => {
  const f = await fixture(t), login = await testLogin(f, "13800000201");
  await login.service.allowTestPhone("13800000202", "test");
  await f.pool.query("UPDATE sms_challenges SET created_at=now()-interval '61 seconds'");
  const headers = { origin, cookie: login.access.cookie, "x-csrf-token": login.access.csrf };
  const challenge = async (phone: string, purpose: string) => {
    const response = await f.app.inject({ method: "POST", url: "/api/v1/auth/sms-challenges", headers, payload: { phone, purpose } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data.challengeId as string;
  };
  const oldId = await challenge("13800000201", "phone-change-old"), newId = await challenge("13800000202", "phone-change-new");
  const response = await f.app.inject({ method: "POST", url: "/api/v1/me/phone-change", headers: login.headers, payload: {
    oldChallengeId: oldId, oldCode: await login.service.readTestCode(oldId),
    newChallengeId: newId, newCode: await login.service.readTestCode(newId),
  } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await f.app.inject({ url: "/api/v1/me", headers: { cookie: login.cookie } })).statusCode, 401);
  const bindings = (await f.pool.query("SELECT user_id,active,phone_ciphertext FROM phone_bindings WHERE user_id=$1 ORDER BY verified_at", [login.user.id])).rows;
  assert.equal(bindings.length, 2);
  assert.equal(bindings.filter(row => row.active).length, 1);
  assert.equal(login.service.decrypt(bindings.find(row => row.active).phone_ciphertext, "phone"), "13800000202");
});

test("AUTH-06: restricted accounts obtain only support sessions; role revocation invalidates admin session", async t => {
  const f = await fixture(t), admin = await testLogin(f, "13800000203", ["super_admin"]), member = await testLogin(f, "13800000204");
  assert.ok(admin.admin);
  await f.app.inject({ method: "POST", url: `/api/v1/admin/users/${member.user.id}/restrictions`, headers: admin.admin.headers, payload: { capability: "all", reason: "support test" } });
  await f.pool.query("UPDATE sms_challenges SET created_at=now()-interval '61 seconds'");
  const headers = { origin, cookie: member.access.cookie, "x-csrf-token": member.access.csrf };
  const sms = await f.app.inject({ method: "POST", url: "/api/v1/auth/sms-challenges", headers, payload: { phone: "13800000204", purpose: "support" } });
  const id = sms.json().data.challengeId;
  const login = await f.app.inject({ method: "POST", url: "/api/v1/auth/sessions", headers, payload: { challengeId: id, code: await member.service.readTestCode(id) } });
  assert.equal(login.statusCode, 201, login.body);
  assert.equal(login.json().data.kind, "support");
  const cookie = `${member.access.cookie}; ${accountCookieName(f.config, "support")}=${login.cookies[0].value}`;
  assert.equal((await f.app.inject({ url: "/api/v1/me", headers: { cookie } })).statusCode, 401);
  const appeal = await f.app.inject({ method: "POST", url: "/api/v1/support/appeals",
    headers: { origin, cookie, "x-csrf-token": login.json().data.csrfToken },
    payload: { objectType: "account", objectId: member.user.id, reason: "请求核查" } });
  assert.equal(appeal.statusCode, 200, appeal.body);
  const ownAppeals=await f.app.inject({url:"/api/v1/support/appeals",headers:{cookie}});
  assert.equal(ownAppeals.statusCode,200);
  assert.equal(ownAppeals.json().data[0].id,appeal.json().data.id);
  await admin.service.revokeRole(admin.user.id, "super_admin", "test");
  assert.equal((await f.app.inject({ url: "/api/v1/admin/users", headers: { cookie: admin.admin.cookie } })).statusCode, 401);
});

test("AUTH-06: a commit rechecks the exact required administrator role and cannot issue an invitation after downgrade",async t=>{
  const f=await fixture(t),login=await testLogin(f,"13800000205",["super_admin","finance"]);
  assert.ok(login.admin);
  const request={method:"GET",headers:{},cookies:{
    [accessCookieName(f.config)]:login.access.token,[accountCookieName(f.config,"admin")]:login.admin.token,
  }} as unknown as FastifyRequest;
  const actor=await login.service.admin(request,["super_admin"]);
  // Inject the authentication-to-commit race without revoking the cookie; role checks still fail.
  await f.pool.query("DELETE FROM role_assignments WHERE user_id=$1 AND role='super_admin'",[login.user.id]);
  const before=(await f.pool.query("SELECT count(*)::int AS n FROM test_access_grants")).rows[0].n;
  const separateService=new IdentityService(f.pool,f.config);
  await assert.rejects(login.service.accessStore.issueInvitation(1,600,actor.userId,client=>separateService.assertActor(client,actor)),{code:"PERMISSION_DENIED"});
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM test_access_grants")).rows[0].n,before);
});
