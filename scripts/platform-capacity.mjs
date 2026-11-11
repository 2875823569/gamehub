import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { cpus, totalmem, platform, release } from "node:os";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import WebSocket from "ws";
import { buildApp, accessCookieName } from "../services/api/app.ts";
import { createPool } from "../services/api/db.ts";
import { migrate } from "../services/api/migrations.ts";
import { seedOfficialCatalog } from "../services/api/catalog-seed.ts";
import { AccessStore } from "../services/api/access-store.ts";
import { csrfToken,digest,newToken } from "../services/api/tokens.ts";
import { WalletService } from "../services/api/wallet-store.ts";
import { runMockTask,deliverNotifications } from "../services/ai-worker/worker.ts";

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const round=value=>Number(value.toFixed(2));
const mib=value=>round(value/1048576);
const percentile=(values,p)=>{
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]);
};
const distribution=values=>({samples:values.length,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),p99Ms:percentile(values,.99),maxMs:values.length?round(Math.max(...values)):null});

// Run the API in a separate process so its CPU/memory excludes the load generator.
if(process.argv.includes("--worker")){
  process.once("message",async config=>{
    const pool=createPool(config),{app}=await buildApp(config,pool);
    const metrics={rssPeakMiB:0,heapUsedPeakMiB:0,poolConnectionsPeak:0,poolWaitingPeak:0};
    const loop=monitorEventLoopDelay({resolution:10});loop.enable();
    const sample=()=>{const memory=process.memoryUsage();metrics.rssPeakMiB=Math.max(metrics.rssPeakMiB,mib(memory.rss));metrics.heapUsedPeakMiB=Math.max(metrics.heapUsedPeakMiB,mib(memory.heapUsed));metrics.poolConnectionsPeak=Math.max(metrics.poolConnectionsPeak,pool.totalCount);metrics.poolWaitingPeak=Math.max(metrics.poolWaitingPeak,pool.waitingCount);};
    const timer=setInterval(sample,100);sample();
    let cpu=process.cpuUsage(),started=performance.now(),measurementStarted=false,stopped=false;
    process.on("message",async message=>{
      if(message.type==="measure"){
        Object.assign(metrics,{rssPeakMiB:0,heapUsedPeakMiB:0,poolConnectionsPeak:0,poolWaitingPeak:0});
        loop.reset();cpu=process.cpuUsage();started=performance.now();measurementStarted=true;sample();process.send?.({type:"measuring"});
      }
      if(message.type!=="stop"||stopped)return;
      stopped=true;sample();clearInterval(timer);loop.disable();
      const usage=process.cpuUsage(cpu),wallMs=performance.now()-started;
      const report={...metrics,measurementStarted,wallMs:round(wallMs),cpuUserMs:round(usage.user/1000),cpuSystemMs:round(usage.system/1000),cpuCorePercent:round((usage.user+usage.system)/10/wallMs),eventLoopP95Ms:round(loop.percentile(95)/1e6),eventLoopP99Ms:round(loop.percentile(99)/1e6),eventLoopMaxMs:round(loop.max/1e6)};
      await app.close();await pool.end();process.send?.({type:"stopped",metrics:report},()=>process.exit(0));
    });
    const address=await app.listen({host:"127.0.0.1",port:0});
    process.send?.({type:"ready",address});
  });
}else{
  const args=process.argv.slice(2),option=(key,fallback)=>{const at=args.indexOf(key);return at<0?fallback:args[at+1];};
  const levels=option("--rooms","10,25,50").split(",").map(Number);
  const rounds=Number(option("--rounds","5"));
  const playersPerRoom=Number(option("--players","2")),mockWorkers=Number(option("--mock-workers","0")),label=option("--label","uncontrolled-local");
  const poolMax=Number(option("--pool-max","10"));
  if(levels.some(n=>![10,20,25,50].includes(n))||!Number.isInteger(rounds)||rounds<1||rounds>5||
    !Number.isInteger(playersPerRoom)||playersPerRoom<2||playersPerRoom>5||levels.some(n=>n*playersPerRoom>100)||![0,2].includes(mockWorkers)||
    !Number.isInteger(poolMax)||poolMax<1||poolMax>30){
    throw new Error("仅支持10/20/25/50房间、每房2—5人、总人数不超过100、每房间1—5动作；mock worker为0或2，连接池上限1—30");
  }
  const databaseUrl=process.env.GAMEHUB_TEST_DATABASE_URL??"postgresql://gamehub:gamehub-local-only@127.0.0.1:55432/gamehub_dev";
  const database=new URL(databaseUrl);
  if(!["127.0.0.1","localhost","[::1]"].includes(database.hostname))throw new Error("容量脚本只允许本机PostgreSQL；不会对远程或生产库施压");
  const output=resolve("work/platform/capacity.json");
  let document;
  try{document=JSON.parse(await readFile(output,"utf8"));}catch{document={formatVersion:1,runs:[]};}
  const machine={platform:platform(),release:release(),node:process.version,cpuModel:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryMiB:mib(totalmem())};
  async function save(){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(document,null,2)+"\n");}
  for(const roomCount of levels){
    const result=await stage(roomCount,rounds,databaseUrl,machine,{playersPerRoom,mockWorkers,label,poolMax});
    document.runs.push(result);await save();
    console.log(JSON.stringify({rooms:roomCount,players:roomCount*playersPerRoom,status:result.status,latency:result.actionToOtherPlayerWs,errorRate:result.errorRate,server:result.server,ai:result.ai,output}));
    if(result.status!=="complete"||result.errorRate>.1){console.log("达到保护性停止条件，后续档位不再运行；已保存实际失败数据。");break;}
  }
}

async function stage(roomCount,rounds,databaseUrl,machine,{playersPerRoom,mockWorkers,label,poolMax}){
  const began=performance.now(),schema=`capacity_${randomUUID().replaceAll("-","")}`,environmentId="gamehub-capacity";
  if(!/^capacity_[0-9a-f]{32}$/.test(schema))throw new Error("Invalid isolated schema");
  const appName=`capacity-${schema}`,url=new URL(databaseUrl);url.searchParams.set("application_name",appName);
  const config={mode:"development",environmentId,host:"127.0.0.1",port:8788,databaseUrl:url.toString(),databaseSchema:schema,databasePoolMax:poolMax,tokenSecret:randomUUID()+randomUUID(),allowedOrigins:["http://127.0.0.1:5173"],secureCookies:false,accessTtlSeconds:3600};
  const admin=new Pool({connectionString:databaseUrl,max:2,connectionTimeoutMillis:5000});
  const pool=createPool(config),accessStore=new AccessStore(pool,config),sockets=[];
  let worker,created=false,serverMetrics=null,dbSampleTimer,dbSampling=false,measuredStarted=0;
  const errors=[],httpLatency=[],wsLatency=[],actionKinds={},dbMetrics={activeBackendsPeak:0,idleBackendsPeak:0,waitingLocksPeak:0};
  const counts={attempted:0,successful:0,httpRequests:0,httpErrors:0,wsErrors:0};
  dbMetrics.sampleScope="API worker plus fixture pool connections; fixture pool is idle during measurement";
  const ai={requestedWorkers:mockWorkers,mode:mockWorkers?"Two independent asynchronous worker loops in the load-generator process; actual claim, lease, static artifact generation, settlement and notification delivery; 500ms simulated provider latency":"No AI workload",claimed:0,succeeded:0,failed:0,peakRunning:0,overlapMs:0};
  let stopAi=false,aiLoops=[],runningAi=0,overlapSince=0;
  let address="";
  const error=(phase,failure)=>errors.push({phase,code:failure.code??failure.name??"ERROR",message:failure.message??String(failure)});
  const request=async(path,player,body)=>{
    counts.httpRequests++;
    const response=await fetch(address+"/api/v1"+path,{method:body===undefined?"GET":"POST",headers:{origin:config.allowedOrigins[0],cookie:player.cookie,"x-csrf-token":player.csrf,...(body===undefined?{}:{"content-type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    const envelope=await response.json();
    if(!response.ok){counts.httpErrors++;throw Object.assign(new Error(envelope.error?.message??`HTTP ${response.status}`),{code:envelope.error?.code??`HTTP_${response.status}`});}
    return envelope.data;
  };
  const ipc=type=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.off("message",message);reject(new Error(`API worker ${type} timeout`));},15000);
    const message=value=>{if(value.type===type){clearTimeout(timer);worker.off("message",message);resolve(value);}};
    worker.on("message",message);
  });
  const observer=async(room,player)=>{
    const ticket=await request(`/rooms/${room.id}/connection-tickets`,player,{});
    const ws=new WebSocket(address.replace("http:","ws:")+ticket.path,{origin:config.allowedOrigins[0]});sockets.push(ws);
    const frames=new Map(),waiters=new Set();
    const channel={latest:null,at(sequence){if(frames.has(sequence))return Promise.resolve(frames.get(sequence));return new Promise((resolve,reject)=>{const item={sequence,resolve,reject};item.timer=setTimeout(()=>{waiters.delete(item);reject(Object.assign(new Error("Remote WS projection timeout"),{code:"WS_TIMEOUT"}));},10000);waiters.add(item);});}};
    ws.on("message",raw=>{
      const frame=JSON.parse(raw.toString());
      if(frame.type==="error"){counts.wsErrors++;error("websocket",Object.assign(new Error(frame.message),{code:frame.code}));return;}
      if(frame.type!=="state")return;
      channel.latest=frame.data;const received=performance.now();if(!frames.has(frame.data.sequence))frames.set(frame.data.sequence,received);
      for(const item of waiters)if(item.sequence===frame.data.sequence){clearTimeout(item.timer);waiters.delete(item);item.resolve(received);}
    });
    ws.on("error",failure=>{counts.wsErrors++;error("websocket",failure);});
    await once(ws,"open");ws.send(JSON.stringify({type:"authenticate",ticket:ticket.ticket}));
    await channel.at(room.sequence);player.channel=channel;
  };
  const provision=async index=>{
    const invitation=await accessStore.issueInvitation(1,3600,"capacity-isolated-fixture");
    const entry=await accessStore.exchange(invitation.invitation,randomUUID());
    const guest=await accessStore.guest(entry.token,`测试玩家${index}`);
    return {id:guest.id,access:await accessStore.current(entry.token),cookie:`${accessCookieName(config)}=${entry.token}`,csrf:csrfToken(config.tokenSecret,entry.token)};
  };
  const each=async(items,concurrency,fn)=>{
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(items.length,concurrency)},async()=>{while(cursor<items.length){const index=cursor++;await fn(items[index],index);}}));
  };
  const report={startedAt:new Date().toISOString(),implementation:"shared-room-projections-v2",label,databasePoolMax:poolMax,rooms:roomCount,players:roomCount*playersPerRoom,playersPerRoom,roundsPerRoom:rounds,machine,network:"localhost HTTP/WebSocket; PostgreSQL localhost; API and load generator are separate Node processes",scope:"Trusted official number-bomb. No iframe, UGC sandbox, browser rendering, real AI, slow-client or sustained-load claim. Setup provisions test access directly through AccessStore; room requests use actual HTTP and Origin/CSRF.",status:"failed"};
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(pool);
    await pool.query("INSERT INTO environments(id,mode) VALUES($1,'development')",[environmentId]);
    dbMetrics.postgresVersion=(await pool.query("SHOW server_version")).rows[0].server_version;
    const games=await seedOfficialCatalog(pool,config),game=games.find(item=>item.officialKey==="number-bomb");
    worker=fork(fileURLToPath(import.meta.url),["--worker"],{execArgv:process.execArgv,stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});
    // Only bounded stderr metadata is retained; connection strings and tokens are never logged.
    let stderr="";worker.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-1000);});
    const ready=ipc("ready");worker.send(config);address=(await ready).address;
    const participants=[];
    await each(Array.from({length:roomCount*playersPerRoom}),4,async(_item,index)=>{participants[index]=await provision(index);});
    const rooms=[];
    await each(Array.from({length:roomCount}),4,async(_item,index)=>{
      const players=participants.slice(index*playersPerRoom,index*playersPerRoom+playersPerRoom),createdRoom=await request("/rooms",players[0],{gameId:game.id});
      let sequence=createdRoom.sequence;
      for(const player of players.slice(1))sequence=(await request(`/rooms/${createdRoom.roomId}/join`,player,{inviteToken:createdRoom.inviteToken})).sequence;
      const room={id:createdRoom.roomId,sequence,players};
      await Promise.all(players.map(player=>observer(room,player)));rooms[index]=room;
    });
    const aiContexts=[],wallet=new WalletService(pool,config);
    if(mockWorkers){
      const actors=[];
      for(let index=0;index<2;index++){
        const access=participants[index].access,userId=randomUUID(),sessionId=randomUUID(),gameId=randomUUID(),projectId=randomUUID();
        await pool.query("INSERT INTO users(id,environment_id,nickname,terms_version) VALUES($1,$2,$3,'capacity-fixture')",[userId,environmentId,`压测模拟作者${index}`]);
        await pool.query("INSERT INTO account_sessions(id,environment_id,generation,user_id,access_session_id,kind,token_digest,expires_at) VALUES($1,$2,$3,$4,$5,'user',$6,now()+interval '1 hour')",[sessionId,environmentId,access.generation,userId,access.id,digest(config.tokenSecret,"account",newToken())]);
        const actor={userId,sessionId,accessSessionId:access.id,generation:access.generation,roles:[]};actors.push(actor);
        await pool.query("INSERT INTO games(id,environment_id,owner_id,title) VALUES($1,$2,$3,'容量模拟任务')",[gameId,environmentId,userId]);
        await pool.query("INSERT INTO projects(id,game_id,owner_id) VALUES($1,$2,$3)",[projectId,gameId,userId]);
        aiContexts.push({actor,gameId,projectId});
      }
      const adminActor={...actors[0],sessionId:randomUUID(),roles:["super_admin"]};
      await pool.query("INSERT INTO role_assignments(user_id,role,assigned_by) VALUES($1,'super_admin','capacity-fixture')",[adminActor.userId]);
      await pool.query("INSERT INTO account_sessions(id,environment_id,generation,user_id,access_session_id,kind,token_digest,expires_at) VALUES($1,$2,$3,$4,$5,'admin',$6,now()+interval '1 hour')",[adminActor.sessionId,environmentId,adminActor.generation,adminActor.userId,adminActor.accessSessionId,digest(config.tokenSecret,"account",newToken())]);
      for(const context of aiContexts)await wallet.grant(adminActor,context.actor.userId,10000,"隔离容量测试点数",randomUUID());
    }
    const enqueue=async context=>{
      const revision=(await pool.query("SELECT workspace_revision FROM projects WHERE id=$1",[context.projectId])).rows[0].workspace_revision;
      const quote=await wallet.quote(context.actor,{gameId:context.gameId,workspaceRevision:revision,prompt:"容量测试固定模拟计数器",mode:"create"});
      await wallet.createTask(context.actor,quote.id,randomUUID());
    };
    for(const context of aiContexts)await enqueue(context);
    // Start the entire cohort only after all sockets are connected.
    await each(rooms,roomCount,async room=>{
      const data=await request(`/rooms/${room.id}/start`,room.players[0],{actionId:randomUUID(),expectedSequence:room.players[0].channel.latest.sequence});
      if(data.result?.type!=="ack")throw new Error(data.result?.message??"Start rejected");
      await Promise.all(room.players.map(player=>player.channel.at(data.sequence)));
    });
    const sampleDb=async()=>{
      if(dbSampling)return;dbSampling=true;
      try{
        const rows=(await admin.query("SELECT state,count(*)::int AS n,count(*) FILTER(WHERE wait_event_type='Lock')::int AS locks FROM pg_stat_activity WHERE application_name=$1 GROUP BY state",[appName])).rows;
        for(const row of rows){if(row.state==="active")dbMetrics.activeBackendsPeak=Math.max(dbMetrics.activeBackendsPeak,row.n);if(row.state==="idle")dbMetrics.idleBackendsPeak=Math.max(dbMetrics.idleBackendsPeak,row.n);dbMetrics.waitingLocksPeak=Math.max(dbMetrics.waitingLocksPeak,row.locks);}
      }finally{dbSampling=false;}
    };
    dbSampleTimer=setInterval(()=>{void sampleDb().catch(failure=>error("db_sample",failure));},200);
    const measuring=ipc("measuring");worker.send({type:"measure"});await measuring;
    measuredStarted=performance.now();
    if(mockWorkers){
      dbMetrics.sampleScope="API worker plus fixture/mock-worker pool connections; mock generation runs concurrently";
      aiLoops=Array.from({length:2},(_,index)=>(async()=>{
        while(!stopAi){
          const task=await wallet.claim(`capacity-worker-${index}`);
          if(!task){await pause(25);continue;}
          ai.claimed++;runningAi++;ai.peakRunning=Math.max(ai.peakRunning,runningAi);
          if(runningAi===2)overlapSince=performance.now();
          try{
            await pause(500);
            if(await runMockTask(wallet,task))ai.succeeded++;else ai.failed++;
            await deliverNotifications(pool,config);
          }finally{
            if(runningAi===2){ai.overlapMs+=performance.now()-overlapSince;overlapSince=0;}
            runningAi--;
          }
          if(!stopAi)await enqueue(aiContexts.find(context=>context.actor.userId===task.user_id));
        }
      })().catch(failure=>{ai.failed++;error("mock_worker",failure);}));
    }
    for(let cycle=0;cycle<rounds;cycle++){
      await pause(200);
      await each(rooms,roomCount,async room=>{
        counts.attempted++;
        try{
          const current=room.players[0].channel.latest;
          const actor=current.view.phase==="finished"?room.players[0]:room.players.find(player=>player.id===current.view.party.display.turnId);
          if(!actor)throw new Error("Current actor missing");
          const other=room.players.find(player=>player!==actor),view=actor.channel.latest.view;
          const action=view.phase==="finished"?{type:"start"}:{type:"game",action:{type:"guess",value:view.party.display.input?.min}};
          actionKinds[action.type]=(actionKinds[action.type]??0)+1;
          const begin=performance.now();
          const data=await request(`/rooms/${room.id}/actions`,actor,{actionId:randomUUID(),expectedSequence:current.sequence,action});
          httpLatency.push(performance.now()-begin);
          if(data.result?.type!=="ack")throw Object.assign(new Error(data.result?.message??"Rule rejected"),{code:"RULE_REJECTED"});
          actor.channel.latest=data;
          const received=await other.channel.at(data.sequence);
          wsLatency.push(received-begin);counts.successful++;
        }catch(failure){error("action",failure);}
      });
      if(performance.now()-measuredStarted>45000){error("protective_stop",new Error("Measurement exceeded 45 seconds"));break;}
      if(counts.attempted && (counts.attempted-counts.successful)/counts.attempted>.1)break;
    }
    report.measurementMs=round(performance.now()-measuredStarted);
    stopAi=true;await Promise.allSettled(aiLoops);ai.overlapMs=round(ai.overlapMs);
    clearInterval(dbSampleTimer);dbSampleTimer=undefined;
    while(dbSampling)await pause(20);
    dbMetrics.persisted=(await pool.query(`SELECT
      (SELECT count(*)::int FROM rooms) AS rooms,
      (SELECT count(*)::int FROM room_members WHERE left_at IS NULL) AS members,
      (SELECT count(*)::int FROM room_actions) AS actions,
      (SELECT count(*)::int FROM room_events) AS events,
      (SELECT round(avg(pg_column_size(snapshot)))::int FROM rooms) AS averageSnapshotBytes`)).rows[0];
    report.status=counts.attempted===roomCount*rounds?"complete":"stopped";
  }catch(failure){error("stage",failure);}
  finally{
    if(dbSampleTimer)clearInterval(dbSampleTimer);
    stopAi=true;await Promise.allSettled(aiLoops);
    for(const ws of sockets)ws.terminate();
    if(worker && worker.exitCode===null){
      try{const stopped=ipc("stopped");worker.send({type:"stop"});serverMetrics=(await stopped).metrics;}catch(failure){error("cleanup_worker",failure);worker.kill();}
    }
    await pool.end();
    if(created){
      if(!/^capacity_[0-9a-f]{32}$/.test(schema))throw new Error("Unsafe cleanup target");
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await admin.end();
    if(mockWorkers){
      const root=resolve("work/platform"),taskDirectory=resolve(root,schema);
      if(dirname(taskDirectory)!==root||!/^capacity_[0-9a-f]{32}$/.test(schema))throw new Error("Unsafe capacity artifact cleanup");
      await rm(taskDirectory,{recursive:true,force:true});
    }
  }
  return {...report,completedAt:new Date().toISOString(),totalMs:round(performance.now()-began),counts,actionKinds,errorRate:counts.attempted?Number(((counts.attempted-counts.successful)/counts.attempted).toFixed(6)):null,actionToOtherPlayerWs:distribution(wsLatency),httpActionResponse:distribution(httpLatency),server:serverMetrics,database:dbMetrics,ai,errors,isolatedSchemaRemoved:created};
}
