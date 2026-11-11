import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApiConfig } from "../api/config";
import { WalletService, type ClaimedTask } from "../api/wallet-store";
import { prepareAiCandidate,createAiCandidate } from "../api/catalog-store";
import type { GameManifest } from "../../packages/contracts/catalog";
import { withTransaction } from "../api/db";

function escapeHtml(value:string):string {
  return value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
}
export function mockFiles(task:ClaimedTask) {
  const title=task.mode==="modify"?"模拟修改：点击练习":"模拟创建：点击练习";
  const manifest:GameManifest={
    schemaVersion:1,entry:"dist/index.html",title,description:"平台固定模拟产物，不是自然语言AI生成",
    instructions:"点击按钮累计次数，点击重置重新开始。",cover:"",mode:"single",minPlayers:1,maxPlayers:1,
    devices:["desktop","mobile"],input:["mouse","touch"],sdkVersion:1,permissions:[],editable:true,
    templateId:"mock-counter-v1",sourceEntry:"src/index.html",assetLicenses:["平台原创测试模板"],saveSchemaVersion:1,
  };
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:18px system-ui;background:#f4f6f8;color:#17212b;display:grid;place-content:center;min-height:90vh;text-align:center;padding:24px}button{padding:16px;margin:8px;font:inherit}p{max-width:600px;overflow-wrap:anywhere}#count{font-size:48px}</style>
<h1>${title}</h1><p>仅验证平台任务与发布流程，不调用真实 AI。</p><p>需求记录：${escapeHtml(task.prompt)}</p><output id="count">0</output><div><button id="add">点击 +1</button><button id="reset">重置</button></div>
<script>(()=>{let n=0;const out=document.getElementById('count');document.getElementById('add').onclick=()=>out.textContent=String(++n);document.getElementById('reset').onclick=()=>{n=0;out.textContent='0'};
addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='gamehub:init'||event.data.protocolVersion!==1||!event.ports[0])return;
const port=event.ports[0];port.start();port.postMessage({protocolVersion:1,nonce:event.data.nonce,id:'ready-1',type:'ready'});},{once:true});})();</script></html>`;
  return {manifest,files:{"game.json":JSON.stringify(manifest),"dist/index.html":html,"src/index.html":html}};
}
export async function runMockTask(service:WalletService,task:ClaimedTask) {
  try {
    const {manifest,files}=mockFiles(task);
    const prepared=await prepareAiCandidate(service.config,files,manifest);
    if(!await service.heartbeat(task))return false;
    await service.complete(task,c=>createAiCandidate(c,{
      environmentId:service.config.environmentId,generation:task.generation,userId:task.user_id,gameId:task.game_id,
      baseVersionId:task.base_version_id,prepared,sourceLabel:"mock-static-template",
    }),{provider:"mock",staticPackage:true,browserVerified:false,naturalLanguageFulfilled:false});
    return true;
  } catch {
    await service.fail(task,"MOCK_ARTIFACT_FAILED");
    return false;
  }
}
export async function deliverNotifications(pool:Pool,config:ApiConfig):Promise<number> {
  return withTransaction(pool,async c=>{
    await c.query("SELECT id FROM environments WHERE id=$1 FOR SHARE",[config.environmentId]);
    const events=(await c.query(`SELECT o.* FROM outbox_events o JOIN environments e ON e.id=o.environment_id
      WHERE o.environment_id=$1 AND o.generation=e.generation AND o.delivered_at IS NULL
      ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 50`,[config.environmentId])).rows;
    for(const event of events){
      const inserted=await c.query("INSERT INTO processed_events(consumer,event_id) VALUES('notifications',$1) ON CONFLICT DO NOTHING RETURNING event_id",[event.id]);
      if(inserted.rowCount)await c.query(`INSERT INTO notifications(id,environment_id,user_id,event_key,event_type,payload)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(environment_id,user_id,event_key) DO NOTHING`,
        [randomUUID(),config.environmentId,event.user_id,event.id,event.event_type,event.payload]);
      await c.query("UPDATE outbox_events SET delivered_at=now(),attempts=attempts+1 WHERE id=$1",[event.id]);
    }
    return events.length;
  });
}
export async function workerOnce(service:WalletService,workerId=`mock-${randomUUID()}`) {
  const expired=await service.expireTasks();
  const task=await service.claim(workerId);
  const succeeded=task?await runMockTask(service,task):false;
  const notifications=await deliverNotifications(service.pool,service.config);
  return {claimed:task?.id??null,succeeded,expired,notifications};
}
