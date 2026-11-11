import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { fixture } from "./fixtures";
import { testLogin } from "./identity-fixture";
import type { PlatformActor } from "../../services/api/platform-auth";
import { WalletService } from "../../services/api/wallet-store";

export async function walletFixture(t:TestContext,points=100) {
  const f=await fixture(t);
  const login=await testLogin(f,"13800000101",["super_admin","finance"]);
  const access=await f.store.current(login.access.token);
  const userSession=(await f.pool.query("SELECT id FROM account_sessions WHERE user_id=$1 AND kind='user' AND revoked_at IS NULL",[login.user.id])).rows[0];
  const adminSession=(await f.pool.query("SELECT id FROM account_sessions WHERE user_id=$1 AND kind='admin' AND revoked_at IS NULL",[login.user.id])).rows[0];
  const actor:PlatformActor={userId:login.user.id,sessionId:userSession.id,accessSessionId:access.id,generation:access.generation,roles:[]};
  const adminActor:PlatformActor={...actor,sessionId:adminSession.id,roles:["super_admin","finance"]};
  const service=new WalletService(f.pool,f.config);
  if(points)await service.grant(adminActor,actor.userId,points,"测试发放",randomUUID());
  const gameId=randomUUID(),projectId=randomUUID();
  await f.pool.query("INSERT INTO games(id,environment_id,owner_id,title) VALUES($1,$2,$3,'测试作品')",[gameId,f.config.environmentId,actor.userId]);
  await f.pool.query("INSERT INTO projects(id,game_id,owner_id) VALUES($1,$2,$3)",[projectId,gameId,actor.userId]);
  const quote=()=>service.quote(actor,{gameId,workspaceRevision:0,prompt:"创建一个点击计数小游戏",mode:"create"});
  const task=async()=>service.createTask(actor,(await quote()).id,randomUUID());
  return {...f,login,actor,adminActor,service,gameId,projectId,quote,task};
}
