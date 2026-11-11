import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientAction } from "../../packages/protocol";
import { roomActionBody, roomCreateBody, roomJoinBody, roomStartBody } from "../../packages/contracts/rooms";
import { dataResponse, genericObject, idParams } from "../../packages/contracts/identity";
import type { PlatformModuleContext } from "./platform-auth";
import type { AccessIdentity } from "./access-store";
import { ApiError } from "./errors";
import { RoomsStore } from "./rooms-store";

/** Runs trusted built-in official rules. This is deliberately not a UGC sandbox. */
export async function registerRoomsModule({ app, config, pool, auth }: PlatformModuleContext) {
  const store = new RoomsStore(pool,config);
  type Subscriber={access:AccessIdentity;send:(data:unknown)=>void;fail:(error:unknown)=>void};
  type Group={members:Set<Subscriber>;busy:boolean;pending:boolean;timer:ReturnType<typeof setInterval>};
  const subscribers=new Map<string,Group>();
  const broadcasts=new Set<Promise<void>>();
  let shuttingDown=false;
  const broadcast=async(roomId:string)=>{
    const group=subscribers.get(roomId);if(!group||shuttingDown)return;
    if(group.busy){group.pending=true;return;}
    group.busy=true;
    try{
      const members=[...group.members],views=await store.projections(members.map(member=>member.access),roomId);
      for(const member of members){
        const view=views.get(member.access.id);
        if(view instanceof ApiError)member.fail(view);else if(view)member.send(view);
      }
    }catch(error){for(const member of group.members)member.fail(error);}
    finally{group.busy=false;if(group.pending){group.pending=false;void publish(roomId);}}
  };
  const publish=(roomId:string)=>{
    const operation=broadcast(roomId);broadcasts.add(operation);
    void operation.finally(()=>broadcasts.delete(operation));
    return operation;
  };
  const replySchema = {200:dataResponse(genericObject)};
  app.post("/api/v1/rooms",{schema:{body:roomCreateBody,response:{201:dataResponse(genericObject)}}},async(request,reply)=>{
    const data=await store.create(await auth.access(request),(request.body as {gameId:string}).gameId);
    return reply.code(201).send({data,requestId:request.id});
  });
  app.post("/api/v1/rooms/:id/join",{schema:{params:idParams,body:roomJoinBody,response:replySchema}},async request=>{
    const data=await store.join(await auth.access(request),(request.params as {id:string}).id,(request.body as {inviteToken:string}).inviteToken);
    publish(data.roomId);
    return {data,requestId:request.id};
  });
  app.get("/api/v1/rooms/:id/state",{schema:{params:idParams,response:replySchema}},async request=>{
    return {data:await store.state(await auth.access(request),(request.params as {id:string}).id),requestId:request.id};
  });
  app.post("/api/v1/rooms/:id/actions",{schema:{params:idParams,body:roomActionBody,response:replySchema}},async request=>{
    const body=request.body as {actionId:string;expectedSequence:number;action:ClientAction};
    const data=await store.action(await auth.access(request),(request.params as {id:string}).id,body.actionId,body.expectedSequence,body.action);
    publish(data.roomId);
    return {data,requestId:request.id};
  });
  app.post("/api/v1/rooms/:id/start",{schema:{params:idParams,body:roomStartBody,response:replySchema}},async request=>{
    const body=request.body as {actionId:string;expectedSequence:number};
    const data=await store.action(await auth.access(request),(request.params as {id:string}).id,body.actionId,body.expectedSequence,{type:"start"});
    publish(data.roomId);
    return {data,requestId:request.id};
  });
  app.post("/api/v1/rooms/:id/leave",{schema:{params:idParams,response:replySchema}},async request=>{
    const id=(request.params as {id:string}).id,data=await store.leave(await auth.access(request),id);
    publish(id);
    return {data,requestId:request.id};
  });
  app.post("/api/v1/rooms/:id/connection-tickets",{schema:{params:idParams,response:replySchema}},async request=>{
    return {data:await store.ticket(await auth.access(request),(request.params as {id:string}).id),requestId:request.id};
  });

  const wss=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
  const upgrade=(request:IncomingMessage,socket:Duplex,head:Buffer)=>{
    const match=/^\/api\/v1\/rooms\/([0-9a-f-]{36})\/stream$/i.exec(request.url??"");
    if (!match) { socket.destroy(); return; }
    if (!request.headers.origin || !config.allowedOrigins.includes(request.headers.origin) || wss.clients.size>=500) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");socket.destroy();return;
    }
    wss.handleUpgrade(request,socket,head,ws=>{
      const roomId=match[1];
      let access:AccessIdentity|undefined,authenticating=false,lastState="",closed=false,subscriber:Subscriber|undefined;
      const fail=(error:unknown)=>{
        if (closed) return;
        const known=error instanceof ApiError;
        if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:"error",code:known?error.code:"INTERNAL_ERROR",message:known?error.message:"房间连接暂不可用"}));
        ws.close(1008,"Room authorization ended");
      };
      const send=(data:unknown)=>{
        if(closed||ws.readyState!==WebSocket.OPEN)return;
        const state=JSON.stringify({type:"state",data});
        if(state!==lastState){
          if(ws.bufferedAmount>262144){ws.close(1013,"Slow consumer");return;}
          ws.send(state);lastState=state;
        }
      };
      const deadline=setTimeout(()=>{if(!access)ws.close(1008,"Authentication timeout");},5000);
      ws.on("message",raw=>{
        // No action writes on this channel: mutations retain HTTP Origin + access CSRF checks.
        if(access || authenticating) {ws.close(1008,"Unexpected message");return;}
        let payload:unknown;
        try{payload=JSON.parse(raw.toString());}catch{ws.close(1008,"Invalid message");return;}
        if(!payload || typeof payload!=="object" || !("type" in payload) || payload.type!=="authenticate" ||
          !("ticket" in payload) || typeof payload.ticket!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.ticket)){
          ws.close(1008,"Invalid authentication");return;
        }
        authenticating=true;
        void store.consumeTicket(roomId,payload.ticket).then(value=>{
          if(closed||shuttingDown)return;
          access=value;clearTimeout(deadline);
          let group=subscribers.get(roomId);
          if(!group){group={members:new Set(),busy:false,pending:false,timer:setInterval(()=>publish(roomId),3000)};subscribers.set(roomId,group);}
          subscriber={access,send,fail};group.members.add(subscriber);
          return publish(roomId);
        }).catch(fail);
      });
      ws.on("error",()=>{ws.terminate();});
      ws.on("close",()=>{
        closed=true;clearTimeout(deadline);
        const group=subscribers.get(roomId);if(subscriber)group?.members.delete(subscriber);
        if(group&&!group.members.size){clearInterval(group.timer);subscribers.delete(roomId);}
      });
    });
  };
  app.server.on("upgrade",upgrade);
  app.addHook("onClose",async()=>{
    app.server.off("upgrade",upgrade);
    shuttingDown=true;
    for(const group of subscribers.values())clearInterval(group.timer);
    for(const ws of wss.clients)ws.terminate();
    await new Promise<void>(resolve=>wss.close(()=>resolve()));
    await Promise.allSettled([...broadcasts]);
    if(store.hasClaims)await pool.query("UPDATE rooms SET lease_until=now() WHERE lease_owner=$1",[store.instanceId]);
  });
  return store;
}
