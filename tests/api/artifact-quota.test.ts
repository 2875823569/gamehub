import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixtures";
import { testLogin } from "./identity-fixture";
import { artifactLimits,assertPhysicalCapacity,uploadReservation } from "../../services/api/artifact-quota";
import { sha256,withObjectLock,putObject,objectDirectory } from "../../services/api/artifact-files";
import { collectArtifactOrphans } from "../../services/api/artifact-gc";
import { utimes } from "node:fs/promises";
import { join } from "node:path";

const MiB=1024*1024;
type F=Awaited<ReturnType<typeof fixture>>;
type Login=Awaited<ReturnType<typeof testLogin>>;
const intent=(f:F,login:Login,size=1024,digest="a".repeat(64))=>f.app.inject({
  method:"POST",url:"/api/v1/creator/uploads",headers:login.headers,payload:{size,sha256:digest,purpose:"game-package"},
});

test("QUOTA: concurrent intents cannot exceed per-account slots; expired untouched reservations are released",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000121");
  const responses=await Promise.all(Array.from({length:12},()=>intent(f,owner)));
  assert.equal(responses.filter(r=>r.statusCode===200).length,2);
  assert.equal(responses.filter(r=>r.statusCode===429).length,10);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM artifact_uploads")).rows[0].n,2);
  await f.pool.query("UPDATE artifact_uploads SET expires_at=now()-interval '1 second'");
  assert.equal((await intent(f,owner)).statusCode,200);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM artifact_uploads WHERE storage_released_at IS NOT NULL")).rows[0].n,2);
  for(let i=0;i<9;i++){
    const id=randomUUID();await f.pool.query("INSERT INTO users(id,environment_id,nickname,terms_version)VALUES($1,$2,'并发容量样例','test')",[id,f.config.environmentId]);
    for(let n=0;n<2;n++)await f.pool.query(`INSERT INTO artifact_uploads(id,environment_id,generation,owner_id,expected_size,expected_digest)
      VALUES($1,$2,1,$3,1,$4)`,[randomUUID(),f.config.environmentId,id,"c".repeat(64)]);
  }
  const second=await testLogin(f,"13800000127");
  const environmentRace=await Promise.all([intent(f,owner),intent(f,second)]);
  assert.equal(environmentRace.filter(r=>r.statusCode===200).length,1);
  assert.equal(environmentRace.filter(r=>r.statusCode===429).length,1);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM artifact_uploads WHERE expires_at>now()")).rows[0].n,20);
});

test("QUOTA: compressed plus expansion reservations enforce account bytes and environment bytes under races",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000122");
  // Completed/failed scans retain storage reservations until actual cleanup; no giant test files are allocated.
  for(let i=0;i<5;i++){
    const response=await intent(f,owner,100*MiB);assert.equal(response.statusCode,200,response.body);
    await f.pool.query("UPDATE artifact_uploads SET status='failed',content_started_at=now() WHERE id=$1",[response.json().data.id]);
  }
  const tooMany=await Promise.all([intent(f,owner,100*MiB),intent(f,owner,100*MiB)]);
  assert.deepEqual(tooMany.map(r=>r.statusCode),[429,429]);
  // Separate owners each remain below 2 GiB, but share the environment limit.
  for(let i=0;i<9;i++){
    const userId=randomUUID();
    await f.pool.query("INSERT INTO users(id,environment_id,nickname,terms_version)VALUES($1,$2,'容量样例','test')",[userId,f.config.environmentId]);
    for(let n=0;n<5;n++)await f.pool.query(`INSERT INTO artifact_uploads(id,environment_id,generation,owner_id,expected_size,expected_digest,status,content_started_at)
      VALUES($1,$2,1,$3,$4,$5,'failed',now())`,[randomUUID(),f.config.environmentId,userId,100*MiB,"b".repeat(64)]);
  }
  const one=await testLogin(f,"13800000123"),two=await testLogin(f,"13800000124");
  const race=await Promise.all([intent(f,one,100*MiB),intent(f,two,100*MiB)]);
  assert.equal(race.filter(r=>r.statusCode===200).length,1);
  assert.equal(race.filter(r=>r.statusCode===429).length,1);
  const total=(await f.pool.query("SELECT sum(expected_size)::bigint::text AS n FROM artifact_uploads")).rows[0].n;
  assert.equal(Number(total),51*100*MiB);
});

test("QUOTA: a repeated content PUT is rejected before body processing while the first receive lease is held",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000125"),bytes=Buffer.from("zip-check-is-a-separate-step");
  const created=await intent(f,owner,bytes.length,sha256(bytes));assert.equal(created.statusCode,200,created.body);
  const upload=created.json().data;
  let release!:()=>void,ready!:()=>void;
  const readyPromise=new Promise<void>(resolve=>{ready=resolve;});
  const held=withObjectLock(f.config,async()=>{ready();await new Promise<void>(resolve=>{release=resolve;});});
  await readyPromise;
  let first:Promise<{statusCode:number;body:string}>|undefined;
  try{
    first=f.app.inject({method:"PUT",url:upload.uploadUrl,headers:{...owner.headers,"content-type":"application/octet-stream"},payload:bytes});
    let leased=false;
    for(let n=0;n<100;n++){
      leased=Boolean((await f.pool.query("SELECT receiving_token FROM artifact_uploads WHERE id=$1",[upload.id])).rows[0].receiving_token);
      if(leased)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(leased,true);
    const duplicate=await f.app.inject({method:"PUT",url:upload.uploadUrl,headers:{...owner.headers,"content-type":"application/octet-stream"},payload:bytes});
    assert.equal(duplicate.statusCode,409,duplicate.body);
  }finally{release();await held;}
  const success=await first!;assert.equal(success.statusCode,200,success.body);
  const state=(await f.pool.query("SELECT status,receiving_token FROM artifact_uploads WHERE id=$1",[upload.id])).rows[0];
  assert.equal(state.status,"uploaded");assert.equal(state.receiving_token,null);
});

test("QUOTA: orphan GC releases expired touched reservations; physical guard accounts for uncommitted bytes",async t=>{
  const f=await fixture(t),owner=await testLogin(f,"13800000126");
  const bytes=Buffer.from("old-private-upload"),digest=await putObject(f.config,bytes),created=await intent(f,owner,bytes.length,digest);
  const id=created.json().data.id,old=new Date(Date.now()-72*3600000);
  await f.pool.query(`UPDATE artifact_uploads SET status='failed',object_digest=$2,content_started_at=now()-interval '3 days',
    expires_at=now()-interval '2 days' WHERE id=$1`,[id,digest]);
  await utimes(join(objectDirectory(f.config),digest),old,old);
  const result=await collectArtifactOrphans(f.pool,f.config,{apply:true,confirmEnvironment:f.config.environmentId});
  assert.ok(result.deleted.includes(digest));
  const upload=(await f.pool.query("SELECT storage_released_at,object_digest FROM artifact_uploads WHERE id=$1",[id])).rows[0];
  assert.ok(upload.storage_released_at);assert.equal(upload.object_digest,null);
  assert.equal(uploadReservation(100*MiB),400*MiB);
  assert.throws(()=>assertPhysicalCapacity(artifactLimits.environmentBytes,1,1,1),{code:"RATE_LIMITED"});
  assert.throws(()=>assertPhysicalCapacity(0,artifactLimits.physicalObjectCount,0,1),{code:"RATE_LIMITED"});
  assert.doesNotThrow(()=>assertPhysicalCapacity(artifactLimits.environmentBytes-1,1,1,0));
});
