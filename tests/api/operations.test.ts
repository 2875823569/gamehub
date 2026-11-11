import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { walletFixture } from "./wallet-fixture";
import { ProviderBudget } from "../../services/api/ai-budget";
import { previewReset,resetEnvironment,resumeEnvironment } from "../../scripts/platform-operations-store";

test("INT-06: reset cancels active tasks, releases points, revokes credentials and preserves unresolved external costs",async t=>{
  const f=await walletFixture(t,30);
  const queued=await f.task(),running=await f.task();
  const claimed=await f.service.claim("reset-worker");assert.ok(claimed);
  const budget=new ProviderBudget(f.pool,f.config);
  await budget.configure("external",100,500);
  const cost=await budget.reserve("external","inflight-call",50);await budget.uncertain(cost);
  const before=await previewReset(f.pool,f.config);
  assert.equal(before.counts.activeTasks,2);assert.equal(before.counts.frozenPoints,"20");assert.equal(before.counts.unresolvedCosts,1);
  const result=await resetEnvironment(f.pool,f.config,{generation:before.generation,confirmation:before.confirmation,operator:"test-reset"});
  assert.equal(result.cancelledTasks,2);assert.equal(result.generation,before.generation+1);assert.equal(result.acceptingAccess,false);
  const balance=(await f.pool.query("SELECT available,frozen,consumed FROM point_accounts WHERE user_id=$1",[f.actor.userId])).rows[0];
  assert.deepEqual(balance,{available:"30",frozen:"0",consumed:"0"});
  const tasks=(await f.pool.query("SELECT status,failure_code FROM ai_tasks WHERE id=ANY($1::uuid[])",[[queued.id,running.id]])).rows;
  assert.ok(tasks.every(task=>task.status==="cancelled"&&task.failure_code==="ENVIRONMENT_RESET"));
  await assert.rejects(()=>f.store.current(f.login.access.token),{code:"TEST_ACCESS_REQUIRED"});
  await assert.rejects(()=>f.service.complete(claimed,async()=>({id:randomUUID()}),{}),{code:"ENVIRONMENT_MISMATCH"});
  const reservation=(await f.pool.query("SELECT status,amount_micros FROM provider_cost_reservations WHERE id=$1",[cost])).rows[0];
  assert.deepEqual(reservation,{status:"uncertain",amount_micros:"50"});
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM games WHERE id=$1",[f.gameId])).rows[0].n,1);
  assert.equal((await f.service.reconcile()).consistent,true);
  await resumeEnvironment(f.pool,f.config,{generation:result.generation,confirmation:`RESUME ${f.config.environmentId} GENERATION ${result.generation}`,operator:"test-reset"});
  const invite=await f.store.issueInvitation(1,3600,"test-reset");
  assert.equal((await f.exchange(invite.invitation)).statusCode,201);
});

test("reset rejects wrong confirmation and stale generation without partial changes",async t=>{
  const f=await walletFixture(t,10);
  await f.task();
  const before=await previewReset(f.pool,f.config);
  await assert.rejects(()=>resetEnvironment(f.pool,f.config,{generation:before.generation,confirmation:"RESET another-env",operator:"test"}),{code:"INVALID_REQUEST"});
  await assert.rejects(()=>resetEnvironment(f.pool,f.config,{generation:before.generation+1,confirmation:`RESET ${f.config.environmentId} GENERATION ${before.generation+1}`,operator:"test"}),{code:"VERSION_CONFLICT"});
  assert.equal((await previewReset(f.pool,f.config)).generation,before.generation);
  assert.equal((await f.service.wallet(f.actor)).frozen,10);
});

test("reset audit and ledger changes roll back when an unknown room structure would leave active rooms",async t=>{
  const f=await walletFixture(t,10);await f.task();
  const exists=(await f.pool.query("SELECT to_regclass('rooms') IS NOT NULL AS present")).rows[0].present;
  if(exists){
    // Keep the real schema intact: simulate a failed reset before the common transaction commit.
    await f.pool.query(`CREATE FUNCTION fail_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='environment_generation_reset' THEN RAISE EXCEPTION 'forced reset failure'; END IF; RETURN NEW; END $$`);
    await f.pool.query("CREATE TRIGGER test_fail_reset BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_reset_audit()");
  }else await f.pool.query("CREATE TABLE rooms(id uuid PRIMARY KEY)");
  const before=await previewReset(f.pool,f.config);
  await assert.rejects(()=>resetEnvironment(f.pool,f.config,{generation:before.generation,confirmation:before.confirmation,operator:"test"}));
  const after=await previewReset(f.pool,f.config);
  assert.equal(after.generation,before.generation);assert.equal(after.acceptingAccess,true);
  assert.equal(after.counts.activeTasks,1);assert.equal(after.counts.frozenPoints,"10");
  assert.ok(await f.store.current(f.login.access.token));
});
