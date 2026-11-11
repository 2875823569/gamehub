import test from "node:test";
import assert from "node:assert/strict";
import { lstat,utimes } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./fixtures";
import { testLogin } from "./identity-fixture";
import { collectArtifactOrphans } from "../../services/api/artifact-gc";
import { objectDirectory,putObject } from "../../services/api/artifact-files";
import { sampleFiles,sampleManifest } from "./catalog-fixture";
import { createAiCandidate,prepareAiCandidate } from "../../services/api/catalog-store";
import { withTransaction } from "../../services/api/db";

test("PKG-09: dry-run and apply GC remove only old unreferenced namespace objects, retaining all version evidence",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000111");
  const created=await f.app.inject({method:"POST",url:"/api/v1/creator/games",headers:owner.headers,payload:{title:"保留验证"}});
  const game=created.json().data;
  const prepared=await prepareAiCandidate(f.config,Object.fromEntries(Object.entries(sampleFiles()).map(([p,b])=>[p,b.toString()])),sampleManifest);
  const version=await withTransaction(f.pool,client=>createAiCandidate(client,{environmentId:f.config.environmentId,generation:1,userId:owner.user.id,gameId:game.id,prepared}));
  const old=new Date(Date.now()-48*3600000),root=objectDirectory(f.config);
  const referenced=prepared.files["dist/index.html"].digest,orphan=await putObject(f.config,Buffer.from("unreferenced"));
  const fresh=await putObject(f.config,Buffer.from("fresh-uncommitted"));
  for(const key of [referenced,orphan])await utimes(join(root,key),old,old);
  await f.pool.query("UPDATE game_versions SET deleted_at=now()-interval '60 days' WHERE id=$1",[version.id]);
  const plan=await collectArtifactOrphans(f.pool,f.config);
  assert.ok(plan.candidates.includes(orphan));assert.ok(!plan.candidates.includes(referenced));assert.ok(!plan.candidates.includes(fresh));
  assert.ok(await lstat(join(root,orphan)));
  await assert.rejects(()=>collectArtifactOrphans(f.pool,f.config,{apply:true,confirmEnvironment:"wrong"}),{code:"INVALID_REQUEST"});
  const result=await collectArtifactOrphans(f.pool,f.config,{apply:true,confirmEnvironment:f.config.environmentId});
  assert.deepEqual(result.deleted,[orphan]);
  await assert.rejects(()=>lstat(join(root,orphan)),{code:"ENOENT"});
  assert.ok(await lstat(join(root,referenced)));assert.ok(await lstat(join(root,fresh)));
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='artifact_orphans_collected'")).rows[0].n,1);
  const reused=await putObject(f.config,Buffer.from("concurrent-reuse"));await utimes(join(root,reused),old,old);
  await Promise.all([
    collectArtifactOrphans(f.pool,f.config,{apply:true,confirmEnvironment:f.config.environmentId}),
    putObject(f.config,Buffer.from("concurrent-reuse")),
  ]);
  assert.ok(await lstat(join(root,reused)),"writer lock and refreshed mtime retain concurrently reused bytes");
});
