import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures";
import { testLogin } from "./identity-fixture";
import { sampleFiles,sampleManifest } from "./catalog-fixture";
import { buildAssetsApp } from "../../services/assets/app";
import { prepareAiCandidate,createAiCandidate } from "../../services/api/catalog-store";
import { withTransaction } from "../../services/api/db";

test("ASSET: independent origin requires scoped token, enforces opaque sandbox CSP, denies traversal and stops on revocation",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000112");
  const response=await f.app.inject({method:"POST",url:"/api/v1/creator/games",headers:owner.headers,payload:{title:"资源权限"}});
  assert.equal(response.statusCode,200,response.body);const game=response.json().data;
  const prepared=await prepareAiCandidate(f.config,Object.fromEntries(Object.entries(sampleFiles()).map(([p,b])=>[p,b.toString()])),sampleManifest);
  const version=await withTransaction(f.pool,client=>createAiCandidate(client,{environmentId:f.config.environmentId,generation:1,userId:owner.user.id,gameId:game.id,prepared}));
  const opened=await f.app.inject({method:"POST",url:`/api/v1/creator/versions/${version.id}/preview-sessions`,headers:owner.headers,payload:{}});
  assert.equal(opened.statusCode,200,opened.body);const play=opened.json().data;
  const assets=await buildAssetsApp(f.config,f.pool);t.after(()=>assets.close());
  const base=`/play/${play.id}/${play.resourceToken}/`;
  const allowed=await assets.inject({url:base+play.entry});
  assert.equal(allowed.statusCode,200,allowed.body);assert.match(allowed.body,/开始/);
  const csp=String(allowed.headers["content-security-policy"]);
  for(const rule of ["default-src 'none'","connect-src 'none'","object-src 'none'","form-action 'none'","sandbox allow-scripts",`frame-ancestors ${f.config.allowedOrigins.join(" ")}`])assert.ok(csp.includes(rule),rule);
  assert.ok(!csp.includes("allow-same-origin"));assert.ok(!csp.includes("unsafe-eval"));
  assert.equal(allowed.headers["cache-control"],"no-store");
  assert.equal(allowed.headers["referrer-policy"],"no-referrer");
  assert.equal(allowed.headers["x-content-type-options"],"nosniff");
  assert.equal(allowed.headers["access-control-allow-credentials"],undefined);
  assert.equal(allowed.headers["set-cookie"],undefined);
  assert.equal((await assets.inject({url:`/play/${play.id}/${"A".repeat(43)}/${play.entry}`,headers:{cookie:owner.cookie}})).statusCode,403);
  assert.equal((await assets.inject({url:base+"game.json"})).statusCode,403);
  assert.equal((await assets.inject({url:base+"dist/missing.js"})).statusCode,404);
  for(const path of ["dist/%2e%2e/%2e%2e/game.json","dist%5c..%5cgame.json","dist/%252e%252e/game.json","C%3a/outside.js"]){
    const denied=await assets.inject({url:base+path});assert.notEqual(denied.statusCode,200,path);
    assert.ok(!denied.body.includes("GAMEHUB"),"errors never disclose internal paths or configuration");
  }
  await f.pool.query("UPDATE test_access_sessions SET revoked_at=now() WHERE id=(SELECT access_session_id FROM play_sessions WHERE id=$1)",[play.id]);
  assert.equal((await assets.inject({url:base+play.entry})).statusCode,409);
});
