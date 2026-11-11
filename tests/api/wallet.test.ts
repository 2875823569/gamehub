import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { walletFixture } from "./wallet-fixture";
import { ProviderBudget } from "../../services/api/ai-budget";
import { runMockTask,deliverNotifications,workerOnce } from "../../services/ai-worker/worker";

test("AI-01/02: concurrent task creation never over-freezes; duplicate keys are bound to requests",async t=>{
  const f=await walletFixture(t,10);
  const quotes=await Promise.all([f.quote(),f.quote(),f.quote()]);
  const results=await Promise.allSettled(quotes.map(q=>f.service.createTask(f.actor,q.id,randomUUID())));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.ok(results.filter(r=>r.status==="rejected").every(r=>(r as PromiseRejectedResult).reason.code==="INSUFFICIENT_POINTS"));
  assert.deepEqual(await f.service.wallet(f.actor),{available:0,frozen:10,consumed:0,testPoints:true});
  assert.equal((await f.service.reconcile()).consistent,true);
  const winner=(results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<any>).value;
  const db=(await f.pool.query("SELECT idempotency_key FROM ai_tasks WHERE id=$1",[winner.id])).rows[0];
  assert.equal((await f.service.createTask(f.actor,winner.quoteId,db.idempotency_key)).id,winner.id);
  const other=quotes.find(q=>q.id!==winner.quoteId)!;
  await assert.rejects(()=>f.service.createTask(f.actor,other.id,db.idempotency_key),{code:"VERSION_CONFLICT"});
});

test("AI-03: cancellation and execution claim have one winner and release at most once",async t=>{
  const f=await walletFixture(t,10);
  const task=await f.task();
  const [cancel,claim]=await Promise.allSettled([f.service.cancel(f.actor,task.id),f.service.claim("worker-race")]);
  const current=await f.service.getTask(f.actor,task.id);
  assert.ok(["running","cancelled"].includes(current.status));
  if(current.status==="cancelled"){
    assert.equal(cancel.status,"fulfilled");
    assert.equal((await f.service.wallet(f.actor)).available,10);
    await f.service.cancel(f.actor,task.id);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM point_freeze_results")).rows[0].n,1);
  } else {
    assert.equal(claim.status,"fulfilled");
    assert.equal(cancel.status,"rejected");
    assert.equal((await f.service.wallet(f.actor)).frozen,10);
  }
});

test("AI-04/06: mock worker saves candidate and settles atomically without replacing newer workspace",async t=>{
  const f=await walletFixture(t,20);
  const task=await f.task();
  await f.pool.query("UPDATE projects SET workspace_revision=1,draft=$2 WHERE id=$1",[f.projectId,{text:"作者较新内容"}]);
  const claimed=await f.service.claim("test-worker");
  assert.ok(claimed);
  assert.equal(await runMockTask(f.service,claimed),true);
  const completed=await f.service.getTask(f.actor,task.id);
  assert.equal(completed.status,"succeeded");assert.ok(completed.outputVersionId);
  assert.deepEqual(await f.service.wallet(f.actor),{available:10,frozen:0,consumed:10,testPoints:true});
  const p=(await f.pool.query("SELECT workspace_revision,draft,base_version_id FROM projects WHERE id=$1",[f.projectId])).rows[0];
  assert.equal(p.workspace_revision,1);assert.equal(p.draft.text,"作者较新内容");assert.equal(p.base_version_id,null);
  const v=(await f.pool.query("SELECT source_label,check_evidence FROM game_versions WHERE id=$1",[completed.outputVersionId])).rows[0];
  assert.equal(v.source_label,"mock-static-template");assert.equal(v.check_evidence.browserVerified,false);
  await deliverNotifications(f.pool,f.config);await deliverNotifications(f.pool,f.config);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1",[f.actor.userId])).rows[0].n,2);
  assert.equal((await f.service.reconcile()).consistent,true);
});

test("AI-05: expired lease and timeout reject late success and release exactly once",async t=>{
  const f=await walletFixture(t,10);
  const task=await f.task(),first=await f.service.claim("old");
  assert.ok(first);
  await f.pool.query("UPDATE ai_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",[task.id]);
  const second=await f.service.claim("new");assert.ok(second);
  assert.equal(second.lease_epoch,first.lease_epoch+1);
  await assert.rejects(()=>f.service.complete(first,async()=>({id:randomUUID()}),{}),{code:"VERSION_CONFLICT"});
  assert.equal(await f.service.fail(first),false);
  await f.pool.query("UPDATE ai_tasks SET deadline_at=now()-interval '1 second' WHERE id=$1",[task.id]);
  assert.equal(await f.service.expireTasks(),1);
  assert.equal(await f.service.expireTasks(),0);
  await assert.rejects(()=>f.service.complete(second,async()=>({id:randomUUID()}),{}),{code:"VERSION_CONFLICT"});
  assert.deepEqual(await f.service.wallet(f.actor),{available:10,frozen:0,consumed:0,testPoints:true});
});

test("AI-06: candidate write failure rolls back both version and point settlement",async t=>{
  const f=await walletFixture(t,10);await f.task();
  const claimed=await f.service.claim("failure");assert.ok(claimed);
  await assert.rejects(()=>f.service.complete(claimed,async c=>{
    await c.query("UPDATE projects SET workspace_revision=55 WHERE id=$1",[f.projectId]);
    throw new Error("forced artifact commit failure");
  },{}),/forced/);
  assert.equal((await f.pool.query("SELECT workspace_revision FROM projects WHERE id=$1",[f.projectId])).rows[0].workspace_revision,0);
  assert.equal((await f.service.wallet(f.actor)).frozen,10);
  assert.equal(await f.service.fail(claimed),true);
  assert.equal((await f.service.wallet(f.actor)).available,10);
});

test("DRAFT-02: stale quote and foreign task access fail; mock worker queue is executable",async t=>{
  const f=await walletFixture(t,20);
  const q=await f.quote();
  await f.pool.query("UPDATE projects SET workspace_revision=1 WHERE id=$1",[f.projectId]);
  await assert.rejects(()=>f.service.createTask(f.actor,q.id,randomUUID()),{code:"VERSION_CONFLICT"});
  await f.pool.query("UPDATE projects SET workspace_revision=0 WHERE id=$1",[f.projectId]);
  const task=await f.task();
  const result=await workerOnce(f.service,"one-shot");assert.equal(result.claimed,task.id);assert.equal(result.succeeded,true);
  await assert.rejects(()=>f.service.getTask({...f.actor,userId:randomUUID()},task.id),{code:"NOT_FOUND"});
});

test("AI-07/09: compensation preserves batch source and cannot be applied twice",async t=>{
  const f=await walletFixture(t,10);
  const task=await f.task();const claimed=await f.service.claim("success");assert.ok(claimed);
  await runMockTask(f.service,claimed);
  const quality=await f.service.qualityCase(f.actor,task.id,"已确认的需求未能按说明完成，请核查");
  await f.service.resolveQuality(f.adminActor,quality.id,"refund","核实为未实现需求，退还测试点数");
  await assert.rejects(()=>f.service.resolveQuality(f.adminActor,quality.id,"refund","再次退点"),{code:"VERSION_CONFLICT"});
  const lot=(await f.pool.query("SELECT source,available,consumed FROM point_lots WHERE user_id=$1",[f.actor.userId])).rows[0];
  assert.equal(lot.source,"test_grant");assert.equal(Number(lot.available),10);assert.equal(Number(lot.consumed),0);
  assert.equal((await f.service.reconcile()).consistent,true);
});

test("AI-09: expired frozen grants are not expired twice and failure gives seven-day grace",async t=>{
  const f=await walletFixture(t,20);
  const task=await f.task();
  await f.pool.query("UPDATE point_lots SET expires_at=now()-interval '1 second'");
  assert.deepEqual(await f.service.wallet(f.actor),{available:0,frozen:10,consumed:0,testPoints:true});
  await f.service.cancel(f.actor,task.id);
  assert.deepEqual(await f.service.wallet(f.actor),{available:10,frozen:0,consumed:0,testPoints:true});
  assert.equal((await f.pool.query("SELECT expires_at>now()+interval '6 days' AS extended FROM point_lots")).rows[0].extended,true);
});

test("AI-10: budget is independent, reserved atomically and retained on uncertain timeouts",async t=>{
  const f=await walletFixture(t,10);
  const budget=new ProviderBudget(f.pool,f.config);
  await assert.rejects(()=>budget.reserve("provider","unconfigured",1),{code:"PROVIDER_BUDGET_UNAVAILABLE"});
  await budget.configure("provider",100,500);
  const attempts=await Promise.allSettled([budget.reserve("provider","call-a",70),budget.reserve("provider","call-b",70)]);
  assert.equal(attempts.filter(r=>r.status==="fulfilled").length,1);
  const id=(attempts.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<string>).value;
  await budget.uncertain(id);
  await assert.rejects(()=>budget.reserve("provider","call-c",40),{code:"PROVIDER_BUDGET_UNAVAILABLE"});
  await budget.settle(id,20);await budget.settle(id,20);
  await budget.reserve("provider","call-c",40);
  assert.equal((await f.service.wallet(f.actor)).available,10);
});

test("PAY-02/04/06: only signed mock notifications credit once and unused-order refund is idempotent",async t=>{
  const f=await walletFixture(t,0);
  const order=await f.service.createOrder(f.actor,randomUUID());
  const input={orderId:order.id,eventKey:randomUUID(),amount:100,signature:"forged"};
  await assert.rejects(()=>f.service.confirmMockPayment(f.adminActor,input),{code:"PERMISSION_DENIED"});
  const wrong={...input,amount:101,signature:f.service.mockSignature(order.id,input.eventKey,101)};
  await assert.rejects(()=>f.service.confirmMockPayment(f.adminActor,wrong),{code:"INVALID_REQUEST"});
  input.signature=f.service.mockSignature(order.id,input.eventKey,input.amount);
  await Promise.all(Array.from({length:6},()=>f.service.confirmMockPayment(f.adminActor,input)));
  assert.equal((await f.service.wallet(f.actor)).available,100);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM payment_events")).rows[0].n,1);
  const request=await f.service.refundRequest(f.actor,order.id,"测试退款申请",randomUUID());
  await f.service.resolveRefund(f.adminActor,request.id,true,"核实未使用测试点数");
  assert.equal((await f.service.wallet(f.actor)).available,0);
  await assert.rejects(()=>f.service.resolveRefund(f.adminActor,request.id,true,"重复处理"),{code:"VERSION_CONFLICT"});
  assert.equal((await f.service.reconcile()).consistent,true);
});

test("HTTP wallet/AI/payment routes enforce user/admin separation and schema-bound test prices",async t=>{
  const f=await walletFixture(t,10);
  const denied=await f.app.inject({method:"POST",url:"/api/v1/admin/point-grants",headers:{...f.login.headers,"idempotency-key":randomUUID()},
    payload:{userId:f.actor.userId,points:100,reason:"不允许使用前台会话"}});
  assert.equal(denied.statusCode,401);
  const wallet=await f.app.inject({url:"/api/v1/wallet",headers:f.login.headers});
  assert.equal(wallet.statusCode,200,wallet.body);assert.equal(wallet.json().data.available,10);
  const forged=await f.app.inject({method:"POST",url:"/api/v1/billing/orders",headers:{...f.login.headers,"idempotency-key":randomUUID()},
    payload:{productId:"test-100",ruleVersion:"mock-v1",channel:"mock",points:100000}});
  assert.equal(forged.statusCode,400);
  const quote=await f.app.inject({method:"POST",url:"/api/v1/ai/quotes",headers:f.login.headers,
    payload:{gameId:f.gameId,workspaceRevision:0,prompt:"创建一个模拟游戏",mode:"create"}});
  assert.equal(quote.statusCode,200,quote.body);assert.equal(quote.json().data.testOnly,true);
  const created=await f.app.inject({method:"POST",url:"/api/v1/ai/tasks",headers:{...f.login.headers,"idempotency-key":randomUUID()},payload:{quoteId:quote.json().data.id}});
  assert.equal(created.statusCode,200,created.body);
});

test("HTTP quality handling allows two free repairs then compensation without additional charges",async t=>{
  const f=await walletFixture(t,10),task=await f.task();
  await workerOnce(f.service,"quality-initial");
  const opened=await f.app.inject({method:"POST",url:`/api/v1/ai/tasks/${task.id}/quality-cases`,headers:f.login.headers,
    payload:{description:"模拟产物没有实现约定需求，请检查并处理"}});
  assert.equal(opened.statusCode,200,opened.body);
  const id=opened.json().data.id;
  const resolve=(decision:string)=>f.app.inject({method:"POST",url:`/api/v1/admin/quality-cases/${id}/resolve`,
    headers:f.login.admin!.headers,payload:{decision,reason:"人工核实后的测试处理"}});
  for(let round=0;round<2;round++){
    const repair=await resolve("repair");assert.equal(repair.statusCode,200,repair.body);
    assert.equal((await resolve("refund")).statusCode,409,"cannot compensate while repair still runs");
    const result=await workerOnce(f.service,`repair-${round}`);assert.equal(result.succeeded,true);
    assert.deepEqual(await f.service.wallet(f.actor),{available:0,frozen:0,consumed:10,testPoints:true});
  }
  assert.equal((await resolve("repair")).statusCode,409);
  assert.equal((await resolve("refund")).statusCode,200);
  assert.deepEqual(await f.service.wallet(f.actor),{available:10,frozen:0,consumed:0,testPoints:true});
  assert.equal((await resolve("refund")).statusCode,409);
  assert.equal((await f.service.reconcile()).consistent,true);
});

test("HTTP mock refunds reject frozen or consumed batches and approval is restricted to admins",async t=>{
  const f=await walletFixture(t,0);
  const order=await f.service.createOrder(f.actor,randomUUID());
  const payment=await f.app.inject({method:"POST",url:`/api/v1/admin/billing/orders/${order.id}/mock-confirm`,
    headers:f.login.admin!.headers,payload:{eventKey:randomUUID()}});
  assert.equal(payment.statusCode,200,payment.body);
  const task=await f.task();
  const request=await f.service.refundRequest(f.actor,order.id,"请退还本次模拟订单",randomUUID());
  const resolve=(headers:Record<string,string>,approve:boolean)=>f.app.inject({method:"POST",url:`/api/v1/admin/refunds/${request.id}/resolve`,
    headers,payload:{approve,reason:"模拟退款审批验证"}});
  assert.equal((await resolve(f.login.headers,true)).statusCode,401);
  const frozen=await resolve(f.login.admin!.headers,true);
  assert.equal(frozen.statusCode,409);assert.equal(frozen.json().error.code,"RESOURCE_IN_USE");
  await workerOnce(f.service,"refund-consumed");
  assert.equal((await f.service.getTask(f.actor,task.id)).status,"succeeded");
  assert.equal((await resolve(f.login.admin!.headers,true)).statusCode,409);
  assert.equal((await resolve(f.login.admin!.headers,false)).statusCode,200);
  assert.equal((await f.service.wallet(f.actor)).available,90);
  await deliverNotifications(f.pool,f.config);await deliverNotifications(f.pool,f.config);
  const notifications=(await f.pool.query("SELECT event_type FROM notifications WHERE user_id=$1",[f.actor.userId])).rows;
  assert.equal(notifications.filter(row=>row.event_type==="billing.test_paid").length,1);
  assert.equal(notifications.filter(row=>row.event_type==="billing.test_refund_processed").length,1);
  assert.equal((await f.service.reconcile()).consistent,true);
});

test("finance writes recheck database roles after an actor was authenticated and while revocation holds the user lock",async t=>{
  const f=await walletFixture(t,10),budget=new ProviderBudget(f.pool,f.config);
  const blocker=await f.pool.connect();
  try{
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[f.adminActor.userId]);
    const pending=budget.configure("revocation-race",100,1000,
      {actorId:f.adminActor.userId,generation:f.adminActor.generation},
      client=>f.service.assertFinanceActor(client,f.adminActor));
    // Model a revocation committing between request authentication and its database mutation.
    await blocker.query("DELETE FROM role_assignments WHERE user_id=$1",[f.adminActor.userId]);
    await blocker.query("COMMIT");
    await assert.rejects(()=>pending,{code:"PERMISSION_DENIED"});
    await assert.rejects(()=>f.service.grant(f.adminActor,f.actor.userId,100,"旧管理员不得发点",randomUUID()),{code:"PERMISSION_DENIED"});
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM provider_budget_accounts")).rows[0].n,0);
    assert.equal((await f.service.wallet(f.actor)).available,10);
  }finally{await blocker.query("ROLLBACK");blocker.release();}
});
