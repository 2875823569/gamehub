import type { PlatformModuleContext } from "./platform-auth";
import { WalletService, testProduct } from "./wallet-store";
import { ProviderBudget } from "./ai-budget";
import { IdentityService } from "./identity-store";
import { errorSchema } from "../../packages/contracts/access";
import { idParams,idempotencyHeaders,grantBody,orderBody,refundBody,walletResponse,jsonEnvelope,listEnvelope } from "../../packages/contracts/wallet";
import { quoteBody,taskBody,qualityBody,qualityResolutionBody } from "../../packages/contracts/ai";

export async function registerWalletModule({app,config,pool,auth}:PlatformModuleContext) {
  const service=new WalletService(pool,config);
  const errors={400:errorSchema,401:errorSchema,403:errorSchema,404:errorSchema,409:errorSchema,422:errorSchema,429:errorSchema,503:errorSchema};
  const response=(schema:unknown=jsonEnvelope)=>({200:schema,...errors});
  const id=(req:any)=>(req.params as {id:string}).id;
  const key=(req:any)=>req.headers["idempotency-key"] as string;
  const data=(req:any,result:unknown)=>({data:result,requestId:req.id});
  app.get("/api/v1/wallet",{schema:{operationId:"getWallet",response:response(walletResponse)}},async req=>data(req,await service.wallet(await auth.user(req))));
  app.get("/api/v1/wallet/transactions",{schema:{operationId:"listPointTransactions",querystring:{type:"object",additionalProperties:false,properties:{cursor:{type:"string",format:"uuid"}}},response:response(listEnvelope)}},
    async req=>data(req,await service.transactions(await auth.user(req),(req.query as {cursor?:string}).cursor)));
  app.post("/api/v1/admin/point-grants",{schema:{operationId:"grantTestPoints",headers:idempotencyHeaders,body:grantBody,response:response()}},async req=>{
    const actor=await auth.admin(req,["super_admin","finance","operations"]);
    const body=req.body as {userId:string;points:number;reason:string};
    return data(req,await service.grant(actor,body.userId,body.points,body.reason,key(req)));
  });
  app.post("/api/v1/ai/quotes",{schema:{operationId:"quoteMockAiTask",body:quoteBody,response:response()}},async req=>
    data(req,await service.quote(await auth.user(req,"create"),req.body as {gameId:string;workspaceRevision:number;prompt:string;mode:"create"|"modify"})));
  app.post("/api/v1/ai/tasks",{schema:{operationId:"createAiTask",headers:idempotencyHeaders,body:taskBody,response:response()}},async req=>
    data(req,await service.createTask(await auth.user(req,"create"),(req.body as {quoteId:string}).quoteId,key(req))));
  app.get("/api/v1/ai/tasks",{schema:{operationId:"listAiTasks",response:response(listEnvelope)}},async req=>data(req,await service.listTasks(await auth.user(req))));
  app.get("/api/v1/ai/tasks/:id",{schema:{operationId:"getAiTask",params:idParams,response:response()}},async req=>data(req,await service.getTask(await auth.user(req),id(req))));
  app.post("/api/v1/ai/tasks/:id/cancel",{schema:{operationId:"cancelAiTask",params:idParams,response:response()}},async req=>data(req,await service.cancel(await auth.user(req),id(req))));
  app.post("/api/v1/ai/tasks/:id/quality-cases",{schema:{operationId:"createAiQualityCase",params:idParams,body:qualityBody,response:response()}},async req=>
    data(req,await service.qualityCase(await auth.user(req),id(req),(req.body as {description:string}).description)));
  app.get("/api/v1/admin/quality-cases",{schema:{operationId:"listQualityCases",response:response(listEnvelope)}},async req=>{
    await auth.admin(req,["super_admin","support","finance"]);
    return data(req,{items:(await pool.query("SELECT * FROM quality_cases WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100",[config.environmentId])).rows});
  });
  app.post("/api/v1/admin/quality-cases/:id/resolve",{schema:{operationId:"resolveAiQualityCase",params:idParams,body:qualityResolutionBody,response:response()}},async req=>{
    const actor=await auth.admin(req,["super_admin","support","finance"]);
    const body=req.body as {decision:"repair"|"refund"|"reject";reason:string};
    return data(req,await service.resolveQuality(actor,id(req),body.decision,body.reason));
  });
  app.get("/api/v1/billing/products",{schema:{operationId:"listTestProducts",response:response(listEnvelope)}},async req=>{
    await auth.user(req,"billing");return data(req,{items:[testProduct]});
  });
  app.post("/api/v1/billing/orders",{schema:{operationId:"createTestPaymentOrder",headers:idempotencyHeaders,body:orderBody,response:response()}},async req=>
    data(req,await service.createOrder(await auth.user(req,"billing"),key(req))));
  app.get("/api/v1/billing/orders",{schema:{operationId:"listTestPaymentOrders",response:response(listEnvelope)}},async req=>{
    const actor=await auth.user(req);
    return data(req,{items:(await pool.query("SELECT * FROM payment_orders WHERE environment_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50",
      [config.environmentId,actor.userId])).rows.map(row=>service.orderView(row)),nextCursor:null});
  });
  app.get("/api/v1/admin/billing/orders",{schema:{operationId:"listAllTestPaymentOrders",response:response(listEnvelope)}},async req=>{
    await auth.admin(req,["super_admin","finance"]);
    return data(req,{items:(await pool.query("SELECT * FROM payment_orders WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100",
      [config.environmentId])).rows.map(row=>({...service.orderView(row),userId:row.user_id})),nextCursor:null});
  });
  app.get("/api/v1/support/billing/orders",{schema:{operationId:"listRestrictedSupportOrders",response:response(listEnvelope)}},async req=>{
    const actor=await new IdentityService(pool,config).authenticate(req,"support");
    return data(req,{items:(await pool.query("SELECT * FROM payment_orders WHERE environment_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50",
      [config.environmentId,actor.userId])).rows.map(row=>service.orderView(row)),nextCursor:null});
  });
  app.get("/api/v1/billing/orders/:id",{schema:{operationId:"getTestPaymentOrder",params:idParams,response:response()}},async req=>
    data(req,await service.order(await auth.user(req),id(req))));
  app.post("/api/v1/billing/orders/:id/refund-requests",{schema:{operationId:"requestTestRefund",params:idParams,headers:idempotencyHeaders,body:refundBody,response:response()}},async req=>
    data(req,await service.refundRequest(await auth.user(req),id(req),(req.body as {reason:string}).reason,key(req))));
  app.post("/api/v1/admin/billing/orders/:id/mock-confirm",{schema:{operationId:"confirmMockPayment",params:idParams,
    body:{type:"object",required:["eventKey"],additionalProperties:false,properties:{eventKey:{type:"string",minLength:8,maxLength:100}}},
    response:response()}},async req=>{
    const actor=await auth.admin(req,["super_admin","finance"]);
    const body=req.body as {eventKey:string};
    const row=(await pool.query("SELECT amount_minor FROM payment_orders WHERE id=$1 AND environment_id=$2",[id(req),config.environmentId])).rows[0];
    const amount=row?.amount_minor??0;
    return data(req,await service.confirmMockPayment(actor,{orderId:id(req),eventKey:body.eventKey,amount,
      signature:service.mockSignature(id(req),body.eventKey,amount)}));
  });
  app.get("/api/v1/admin/refunds",{schema:{operationId:"listTestRefunds",response:response(listEnvelope)}},async req=>{
    await auth.admin(req,["super_admin","finance"]);return data(req,{items:(await pool.query("SELECT * FROM refund_orders WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 100",[config.environmentId])).rows});
  });
  app.post("/api/v1/admin/refunds/:id/resolve",{schema:{operationId:"resolveTestRefund",params:idParams,
    body:{type:"object",required:["approve","reason"],additionalProperties:false,properties:{approve:{type:"boolean"},reason:{type:"string",minLength:3,maxLength:1000}}},
    response:response()}},async req=>{
    const body=req.body as {approve:boolean;reason:string};
    return data(req,await service.resolveRefund(await auth.admin(req,["super_admin","finance"]),id(req),body.approve,body.reason));
  });
  app.get("/api/v1/admin/reconciliation",{schema:{operationId:"reconcileTestPoints",response:response()}},async req=>{
    await auth.admin(req,["super_admin","finance"]);return data(req,await service.reconcile());
  });
  app.post("/api/v1/admin/provider-budgets",{schema:{operationId:"configureProviderBudget",
    body:{type:"object",required:["provider","dayLimitMicros","monthLimitMicros"],additionalProperties:false,properties:{
      provider:{type:"string",pattern:"^[a-z0-9_-]{1,40}$"},dayLimitMicros:{type:"integer",minimum:0,maximum:1000000000000},monthLimitMicros:{type:"integer",minimum:0,maximum:1000000000000}}},
    response:response()}},async req=>{
    const actor=await auth.admin(req,["super_admin","finance"]);
    const body=req.body as {provider:string;dayLimitMicros:number;monthLimitMicros:number};
    await new ProviderBudget(pool,config).configure(body.provider,body.dayLimitMicros,body.monthLimitMicros,
      {actorId:actor.userId,generation:actor.generation},client=>service.assertFinanceActor(client,actor));
    // Budgets configure the ledger only; they do not enable a real provider.
    return data(req,{configured:true,realProviderEnabled:false,actorId:actor.userId});
  });
  return service;
}
