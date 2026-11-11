import test from "node:test";
import assert from "node:assert/strict";
import { fixture, origin } from "./fixtures";
import { testLogin } from "./identity-fixture";
import { sampleFiles, sampleManifest, sampleZip } from "./catalog-fixture";
import { sha256 } from "../../services/api/artifact-files";
import { runArtifactJob } from "../../services/api/artifact-worker";
import { readPlayResource } from "../../services/api/play-store";
import { createAiCandidate, prepareAiCandidate } from "../../services/api/catalog-store";
import { withTransaction } from "../../services/api/db";
import { seedOfficialCatalog } from "../../services/api/catalog-seed";

type F=Awaited<ReturnType<typeof fixture>>;
type Login=Awaited<ReturnType<typeof testLogin>>;
async function createVersion(f:F,login:Login){
  const created=await f.app.inject({method:"POST",url:"/api/v1/creator/games",headers:login.headers,payload:{title:"上传测试",description:"原创"}});
  assert.equal(created.statusCode,200,created.body);const game=created.json().data;
  const bytes=sampleZip();
  const intent=await f.app.inject({method:"POST",url:"/api/v1/creator/uploads",headers:login.headers,payload:{size:bytes.length,sha256:sha256(bytes),purpose:"game-package"}});
  assert.equal(intent.statusCode,200,intent.body);const upload=intent.json().data;
  const sent=await f.app.inject({method:"PUT",url:upload.uploadUrl,headers:{...login.headers,"content-type":"application/octet-stream"},payload:bytes});
  assert.equal(sent.statusCode,200,sent.body);
  const completed=await f.app.inject({method:"POST",url:`/api/v1/creator/uploads/${upload.id}/complete`,headers:login.headers,payload:{}});
  assert.equal(completed.statusCode,200,completed.body);
  const jobId=completed.json().data.jobId;
  for(let i=0;i<100;i++){
    await runArtifactJob(f.pool,f.config);
    const row=(await f.pool.query("SELECT status,failure_reason FROM artifact_jobs WHERE id=$1",[jobId])).rows[0];
    if(row.status==="succeeded")break;
    assert.notEqual(row.status,"failed",row.failure_reason);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const versionResponse=await f.app.inject({method:"POST",url:`/api/v1/creator/games/${game.id}/versions`,headers:login.headers,payload:{uploadId:upload.id}});
  assert.equal(versionResponse.statusCode,200,versionResponse.body);
  return {game,version:versionResponse.json().data,upload};
}
async function preview(f:F,login:Login,versionId:string){
  const response=await f.app.inject({method:"POST",url:`/api/v1/creator/versions/${versionId}/preview-sessions`,headers:login.headers,payload:{}});
  assert.equal(response.statusCode,200,response.body);return response.json().data;
}
async function approve(f:F,login:Login,admin:Login,versionId:string){
  await preview(f,login,versionId);
  const submitted=await f.app.inject({method:"POST",url:`/api/v1/creator/versions/${versionId}/submissions`,
    headers:{...login.headers,"idempotency-key":"review-request-key"},payload:{publishOnApproval:true}});
  assert.equal(submitted.statusCode,200,submitted.body);const id=submitted.json().data.id;
  const claimed=await f.app.inject({method:"POST",url:`/api/v1/admin/reviews/${id}/claim`,headers:admin.admin!.headers,payload:{}});
  assert.equal(claimed.statusCode,200,claimed.body);
  const reviewPreview=await f.app.inject({method:"POST",url:`/api/v1/admin/reviews/${id}/preview-sessions`,headers:admin.admin!.headers,payload:{}});
  assert.equal(reviewPreview.statusCode,200,reviewPreview.body);
  const approved=await f.app.inject({method:"POST",url:`/api/v1/admin/reviews/${id}/decision`,headers:admin.admin!.headers,
    payload:{decision:"approved",reason:"静态样例预览确认",previewConfirmed:true}});
  assert.equal(approved.statusCode,200,approved.body);
  assert.equal(approved.json().data.published,true);
}

test("PKG/PUB/SAVE: upload -> owner preview -> reviewer publish -> play/save -> force revoke",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000101"),admin=await testLogin(f,"13800000102",["reviewer"]);
  const {game,version}=await createVersion(f,owner);
  const forbidden=await f.app.inject({method:"POST",url:`/api/v1/games/${game.id}/play-sessions`,headers:owner.headers,payload:{}});
  assert.equal(forbidden.statusCode,409);
  await approve(f,owner,admin,version.id);
  const started=await f.app.inject({method:"POST",url:`/api/v1/games/${game.id}/play-sessions`,headers:owner.headers,payload:{}});
  assert.equal(started.statusCode,200,started.body);const play=started.json().data;
  const resource=await readPlayResource(f.pool,f.config,{sessionId:play.id,resourceToken:play.resourceToken,path:play.entry});
  assert.match(resource.body.toString(),/开始/);
  await assert.rejects(()=>readPlayResource(f.pool,f.config,{sessionId:play.id,resourceToken:play.resourceToken,path:"game.json"}),{code:"PERMISSION_DENIED"});
  const saved=await f.app.inject({method:"PUT",url:`/api/v1/play-sessions/${play.id}/save`,headers:owner.headers,payload:{expectedRevision:0,data:{level:2}}});
  assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().data.revision,1);
  const stale=await f.app.inject({method:"PUT",url:`/api/v1/play-sessions/${play.id}/save`,headers:owner.headers,payload:{expectedRevision:0,data:{level:1}}});
  assert.equal(stale.statusCode,409);
  const read=await f.app.inject({url:`/api/v1/play-sessions/${play.id}/save`,headers:{cookie:owner.cookie}});
  assert.equal(read.json().data.data.level,2);
  const forced=await f.app.inject({method:"POST",url:`/api/v1/admin/games/${game.id}/restrictions`,headers:admin.admin!.headers,payload:{restricted:true,reason:"测试撤销"}});
  assert.equal(forced.statusCode,200,forced.body);
  await assert.rejects(()=>readPlayResource(f.pool,f.config,{sessionId:play.id,resourceToken:play.resourceToken,path:play.entry}),{code:"GAME_UNAVAILABLE"});
  assert.equal((await f.app.inject({url:`/api/v1/play-sessions/${play.id}`,headers:{cookie:owner.cookie}})).statusCode,409);
  assert.equal((await f.app.inject({method:"POST",url:`/api/v1/creator/games/${game.id}/releases`,headers:owner.headers,payload:{versionId:version.id,reason:"尝试绕过"}})).statusCode,409);
});

test("DRAFT: concurrent saves conflict, restore creates revision, and AI candidate never replaces workspace",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000103"),{game,version}=await createVersion(f,owner);
  const replies=await Promise.all(Array.from({length:6},(_,i)=>f.app.inject({method:"PATCH",
    url:`/api/v1/creator/projects/${game.projectId}/workspace`,headers:owner.headers,payload:{expectedRevision:0,draft:{prompt:`想法${i}`},baseVersionId:version.id}})));
  assert.equal(replies.filter(r=>r.statusCode===200).length,1);
  assert.equal(replies.filter(r=>r.statusCode===409).length,5);
  const before=(await f.pool.query("SELECT * FROM projects WHERE id=$1",[game.projectId])).rows[0];
  const prepared=await prepareAiCandidate(f.config,Object.fromEntries(Object.entries(sampleFiles()).map(([k,v])=>[k,v.toString()])),sampleManifest);
  await withTransaction(f.pool,client=>createAiCandidate(client,{environmentId:f.config.environmentId,generation:1,userId:owner.user.id,
    gameId:game.id,baseVersionId:version.id,prepared,sourceLabel:"mock-test"}));
  const after=(await f.pool.query("SELECT * FROM projects WHERE id=$1",[game.projectId])).rows[0];
  assert.deepEqual(after,before);
  const snapshots=await f.app.inject({url:`/api/v1/creator/projects/${game.projectId}/draft-snapshots`,headers:{cookie:owner.cookie}});
  const restore=await f.app.inject({method:"POST",url:`/api/v1/creator/projects/${game.projectId}/draft-restores`,headers:owner.headers,
    payload:{expectedRevision:1,snapshotId:snapshots.json().data.items[0].id}});
  assert.equal(restore.statusCode,200,restore.body);assert.equal(restore.json().data.workspaceRevision,2);
});

test("AUTH/PKG: exports are owner-bound, download authorization expires, referenced versions cannot be deleted",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000104"),other=await testLogin(f,"13800000105"),{game,version}=await createVersion(f,owner);
  const denied=await f.app.inject({url:`/api/v1/creator/versions/${version.id}`,headers:{cookie:other.cookie}});
  assert.equal(denied.statusCode,404);
  await preview(f,owner,version.id);
  assert.equal((await f.app.inject({method:"DELETE",url:`/api/v1/creator/versions/${version.id}`,headers:owner.headers})).statusCode,409);
  const jobResponse=await f.app.inject({method:"POST",url:`/api/v1/creator/versions/${version.id}/exports`,headers:owner.headers,payload:{}});
  assert.equal(jobResponse.statusCode,200,jobResponse.body);const jobId=jobResponse.json().data.jobId;
  await runArtifactJob(f.pool,f.config);
  const grantResponse=await f.app.inject({method:"POST",url:`/api/v1/creator/artifact-jobs/${jobId}/download-grants`,headers:owner.headers,payload:{}});
  assert.equal(grantResponse.statusCode,200,grantResponse.body);const grant=grantResponse.json().data;
  const download=await f.app.inject({url:grant.downloadUrl,headers:{cookie:owner.cookie,"x-download-token":grant.token}});
  assert.equal(download.statusCode,200,download.body);assert.equal(download.headers["content-type"],"application/zip");
  assert.equal((await f.app.inject({url:grant.downloadUrl,headers:{cookie:other.cookie,"x-download-token":grant.token}})).statusCode,410);
  await f.pool.query("UPDATE artifact_download_grants SET expires_at=now()-interval '1 second'");
  assert.equal((await f.app.inject({url:grant.downloadUrl,headers:{cookie:owner.cookie,"x-download-token":grant.token}})).statusCode,410);
  await f.pool.query("UPDATE play_sessions SET revoked_at=now() WHERE game_id=$1",[game.id]);
  assert.equal((await f.app.inject({method:"DELETE",url:`/api/v1/creator/games/${game.id}`,headers:owner.headers})).statusCode,200);
  const restore=await f.app.inject({method:"POST",url:`/api/v1/creator/games/${game.id}/restore`,headers:owner.headers,payload:{}});
  assert.equal(restore.statusCode,200,restore.body);assert.equal(restore.json().data.published,false);
});

test("official metadata import is idempotent; guest lists catalog but cannot create or read cloud saves",async t=>{
  const f=await fixture(t);
  assert.equal((await seedOfficialCatalog(f.pool,f.config)).filter(row=>row.created).length,12);
  assert.equal((await seedOfficialCatalog(f.pool,f.config)).filter(row=>row.created).length,0);
  const access=await f.enter(),headers={origin,cookie:access.cookie,"x-csrf-token":access.csrf};
  const listed=await f.app.inject({url:"/api/v1/games",headers:{cookie:access.cookie}});
  assert.equal(listed.statusCode,200,listed.body);assert.equal(listed.json().data.items.length,12);
  const create=await f.app.inject({method:"POST",url:"/api/v1/creator/games",headers,payload:{title:"越权"}});
  assert.equal(create.statusCode,401);
  const game=listed.json().data.items[0];
  const started=await f.app.inject({method:"POST",url:`/api/v1/games/${game.id}/play-sessions`,headers,payload:{}});
  assert.equal(started.statusCode,200,started.body);
  const save=await f.app.inject({url:`/api/v1/play-sessions/${started.json().data.id}/save`,headers:{cookie:access.cookie}});
  assert.equal(save.statusCode,401);
});

test("AUTH/PUB: revoked login invalidates existing preview; role removal racing review claim cannot commit",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000113"),admin=await testLogin(f,"13800000114",["reviewer"]);
  const {version}=await createVersion(f,owner),play=await preview(f,owner,version.id);
  const submission=await f.app.inject({method:"POST",url:`/api/v1/creator/versions/${version.id}/submissions`,
    headers:{...owner.headers,"idempotency-key":"role-race-review-key"},payload:{publishOnApproval:false}});
  assert.equal(submission.statusCode,200,submission.body);
  const lock=await f.pool.connect();await lock.query("BEGIN");
  try{
    await lock.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[admin.user.id]);
    const claim=f.app.inject({method:"POST",url:`/api/v1/admin/reviews/${submission.json().data.id}/claim`,headers:admin.admin!.headers,payload:{}});
    // Wait until the request reaches its DB permission lock, so the test exercises stale middleware authorization.
    let waiting=false;
    for(let attempt=0;attempt<100;attempt++){
      const row=(await f.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF e,u,s,a,g%') AS waiting`)).rows[0];
      if(row.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,"review request reached the transaction permission barrier");
    await lock.query("DELETE FROM role_assignments WHERE user_id=$1",[admin.user.id]);
    await lock.query("COMMIT");
    const result=await claim;assert.equal(result.statusCode,403,result.body);
    assert.equal((await f.pool.query("SELECT status FROM review_submissions WHERE id=$1",[submission.json().data.id])).rows[0].status,"pending");
  }finally{await lock.query("ROLLBACK");lock.release();}
  await f.pool.query("UPDATE account_sessions SET revoked_at=now() WHERE user_id=$1",[owner.user.id]);
  await assert.rejects(()=>readPlayResource(f.pool,f.config,{sessionId:play.id,resourceToken:play.resourceToken,path:play.entry}),{code:"GAME_UNAVAILABLE"});
  assert.equal((await f.app.inject({url:`/api/v1/play-sessions/${play.id}`,headers:{cookie:owner.cookie}})).statusCode,409);
});

test("SAVE: schema upgrades preserve old saves; owner isolation, import and delete use expected revision",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000115"),other=await testLogin(f,"13800000116");
  const {game,version}=await createVersion(f,owner),oldPlay=await preview(f,owner,version.id);
  const save=(sessionId:string,expectedRevision:number,data:unknown)=>f.app.inject({method:"PUT",url:`/api/v1/play-sessions/${sessionId}/save`,headers:owner.headers,payload:{expectedRevision,data}});
  assert.equal((await save(oldPlay.id,0,{level:8})).statusCode,200);
  const manifest={...sampleManifest,saveSchemaVersion:2},files=sampleFiles();
  files["game.json"]=Buffer.from(JSON.stringify(manifest));
  const prepared=await prepareAiCandidate(f.config,Object.fromEntries(Object.entries(files).map(([path,data])=>[path,data.toString()])),manifest);
  const next=await withTransaction(f.pool,client=>createAiCandidate(client,{environmentId:f.config.environmentId,generation:1,userId:owner.user.id,gameId:game.id,prepared}));
  const nextPlay=await preview(f,owner,next.id);
  const load=await f.app.inject({url:`/api/v1/play-sessions/${nextPlay.id}/save`,headers:{cookie:owner.cookie}});
  assert.equal(load.statusCode,200);assert.deepEqual(load.json().data.otherSchemaVersions,[1]);assert.equal(load.json().data.data,null);
  assert.equal((await f.app.inject({url:`/api/v1/play-sessions/${oldPlay.id}/save`,headers:{cookie:owner.cookie}})).json().data.data.level,8);
  const denied=await f.app.inject({url:`/api/v1/play-sessions/${oldPlay.id}/save`,headers:{cookie:other.cookie}});assert.notEqual(denied.statusCode,200);
  assert.equal((await save(nextPlay.id,0,{level:1})).statusCode,200);
  const importResponse=await f.app.inject({method:"POST",url:`/api/v1/play-sessions/${nextPlay.id}/save-imports`,headers:owner.headers,payload:{expectedRevision:1,data:{level:7},confirmed:true}});
  assert.equal(importResponse.statusCode,409);
  const remove=await f.app.inject({method:"DELETE",url:`/api/v1/play-sessions/${nextPlay.id}/save`,headers:owner.headers,payload:{expectedRevision:1,confirmed:true}});
  assert.equal(remove.statusCode,200);assert.equal(remove.json().data.revision,2);
  assert.equal((await save(nextPlay.id,1,{level:2})).statusCode,409);
  assert.equal((await save(nextPlay.id,2,{blob:"x".repeat(102401)})).statusCode,413);
});
