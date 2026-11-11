import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { fixture, origin } from "./fixtures";
import { seedOfficialCatalog } from "../../services/api/catalog-seed";
import { RoomsStore } from "../../services/api/rooms-store";
import { partyGames } from "../../packages/games/registry";
import { buildApp } from "../../services/api/app";
import type { Pool } from "pg";

async function player(f:Awaited<ReturnType<typeof fixture>>,name:string) {
  const entry=await f.enter();
  const guest=await f.store.guest(entry.token,name);
  const access=await f.store.current(entry.token);
  return {...entry,guest,access,headers:{origin,cookie:entry.cookie,"x-csrf-token":entry.csrf}};
}

test("all twelve official games start against persisted authority with private projections",async t=>{
  const f=await fixture(t),catalog=await seedOfficialCatalog(f.pool,f.config),store=new RoomsStore(f.pool,f.config);
  assert.equal(catalog.length,12);
  const players=await Promise.all(Array.from({length:4},(_,i)=>player(f,`玩家${i+1}`)));
  for(const game of catalog){
    const minimum=partyGames.get(game.officialKey)?.minPlayers??2;
    assert.ok(minimum<=players.length);
    const created=await store.create(players[0].access,game.id);
    let sequence=created.sequence;
    for(let i=1;i<minimum;i++) sequence=(await store.join(players[i].access,created.roomId,created.inviteToken)).sequence;
    const started=await store.action(players[0].access,created.roomId,randomUUID(),sequence,{type:"start"});
    assert.equal(started.result.type,"ack",`${game.officialKey}: ${JSON.stringify(started.result)}`);
    assert.equal(started.view.phase,"playing",game.officialKey);
    assert.equal(started.view.gameId,game.officialKey);
    assert.equal((started as Record<string,unknown>).snapshot,undefined);
    const snapshot=(await f.pool.query("SELECT snapshot FROM rooms WHERE id=$1",[created.roomId])).rows[0].snapshot;
    assert.equal(snapshot.phase,"playing");
    if(game.officialKey==="liars-dice"){
      const other=await store.state(players[1].access,created.roomId);
      assert.equal(other.view.round!.yourDice.length,5);
      assert.equal(other.view.round!.revealedDice,undefined);
      assert.equal((other.view.round as unknown as Record<string,unknown>).dice,undefined);
      assert.notEqual(other.view.you,started.view.you);
      const batched=await store.projections(players.slice(0,2).map(player=>player.access),created.roomId);
      for(const player of players.slice(0,2)){
        const projection=batched.get(player.access.id)!;
        assert.ok(!(projection instanceof Error));
        assert.equal(projection.view.you,player.guest.id);
        assert.deepEqual(projection.view.round!.yourDice,snapshot.round.dice[player.guest.id]);
        assert.equal(projection.view.round!.revealedDice,undefined);
      }
    }
    for(let i=minimum-1;i>=0;i--) await store.leave(players[i].access,created.roomId);
  }
});

test("rooms enforce invitations, idempotency, ordering, fencing, leaving and play authorization",async t=>{
  const f=await fixture(t),catalog=await seedOfficialCatalog(f.pool,f.config),store=new RoomsStore(f.pool,f.config);
  const a=await player(f,"房主"),b=await player(f,"队友"),stranger=await player(f,"路人");
  const game=catalog.find(g=>g.officialKey==="liars-dice")!;
  const created=await store.create(a.access,game.id);
  await assert.rejects(store.join(stranger.access,created.roomId,"x".repeat(43)),/邀请无效/);
  await assert.rejects(store.state(stranger.access,created.roomId),/不是有效/);
  const joined=await store.join(b.access,created.roomId,created.inviteToken);
  await assert.rejects(store.action(a.access,created.roomId,randomUUID(),0,{type:"start"}),/状态已更新/);
  const actionId=randomUUID();
  const outcomes=await Promise.all([store.action(a.access,created.roomId,actionId,joined.sequence,{type:"start"}),store.action(a.access,created.roomId,actionId,joined.sequence,{type:"start"})]);
  assert.equal(outcomes[0].sequence,outcomes[1].sequence);
  assert.equal(outcomes[1].duplicate,true);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM room_actions WHERE room_id=$1",[created.roomId])).rows[0].n,1);
  await assert.rejects(store.action(b.access,created.roomId,actionId,outcomes[0].sequence,{type:"start"}),/编号已用于/);
  const base=await store.load(a.access,created.roomId);
  await f.pool.query("UPDATE rooms SET lease_until=now()-interval '1 second' WHERE id=$1",[created.roomId]);
  const replacement=new RoomsStore(f.pool,f.config);
  const recovered=await replacement.state(b.access,created.roomId);
  assert.equal(recovered.view.phase,"playing");
  await assert.rejects(store.commit(a.access,base,base.room.snapshot!,"stale_worker"),/租约已变化/);
  const fence=(await f.pool.query("SELECT lease_epoch,sequence FROM rooms WHERE id=$1",[created.roomId])).rows[0];
  assert.equal(fence.lease_epoch,base.room.lease_epoch+1);
  await replacement.leave(a.access,created.roomId);
  const state=await replacement.state(b.access,created.roomId);
  assert.equal(state.view.hostId,b.guest.id);
  assert.equal(state.view.phase,"finished");
  await f.pool.query("UPDATE play_sessions SET revoked_at=now() WHERE id=(SELECT play_session_id FROM room_members WHERE room_id=$1 AND player_id=$2)",[created.roomId,b.guest.id]);
  await assert.rejects(replacement.state(b.access,created.roomId),/游玩授权已失效/);
});

test("batched projections reject only revoked members and preserve each remaining private view",async t=>{
  const f=await fixture(t),catalog=await seedOfficialCatalog(f.pool,f.config),store=new RoomsStore(f.pool,f.config);
  const a=await player(f,"甲"),b=await player(f,"乙"),c=await player(f,"丙");
  const created=await store.create(a.access,catalog.find(game=>game.officialKey==="liars-dice")!.id);
  await store.join(b.access,created.roomId,created.inviteToken);
  const joined=await store.join(c.access,created.roomId,created.inviteToken);
  await store.action(a.access,created.roomId,randomUUID(),joined.sequence,{type:"start"});
  await f.pool.query("UPDATE test_access_sessions SET revoked_at=now() WHERE id=$1",[a.access.id]);
  const views=await store.projections([a.access,b.access,c.access],created.roomId);
  assert.ok(views.get(a.access.id) instanceof Error);
  const snapshot=(await f.pool.query("SELECT snapshot FROM rooms WHERE id=$1",[created.roomId])).rows[0].snapshot;
  for(const player of [b,c]){
    const result=views.get(player.access.id)!;assert.ok(!(result instanceof Error));
    assert.equal(result.view.you,player.guest.id);
    assert.deepEqual(result.view.round!.yourDice,snapshot.round.dice[player.guest.id]);
    assert.equal(result.view.round!.revealedDice,undefined);
  }
});

test("existing playing room is version pinned; unpublish denies new joins and starts, restriction kills access",async t=>{
  const f=await fixture(t),catalog=await seedOfficialCatalog(f.pool,f.config),store=new RoomsStore(f.pool,f.config);
  const a=await player(f,"甲"),b=await player(f,"乙"),c=await player(f,"丙");
  const game=catalog.find(g=>g.officialKey==="liars-dice")!;
  const created=await store.create(a.access,game.id),joined=await store.join(b.access,created.roomId,created.inviteToken);
  await store.action(a.access,created.roomId,randomUUID(),joined.sequence,{type:"start"});
  await f.pool.query("DELETE FROM publication_heads WHERE game_id=$1",[game.id]);
  const state=await store.state(a.access,created.roomId);
  assert.equal(state.versionId,created.versionId);
  assert.equal(state.view.phase,"playing");
  await assert.rejects(store.join(c.access,created.roomId,created.inviteToken),/已下架/);
  await f.pool.query("UPDATE room_members SET last_action_at=NULL WHERE room_id=$1",[created.roomId]);
  await assert.rejects(store.action(a.access,created.roomId,randomUUID(),state.sequence,{type:"start"}),/已下架/);
  await f.pool.query("UPDATE games SET restricted=true WHERE id=$1",[game.id]);
  await assert.rejects(store.state(a.access,created.roomId),/游玩授权已失效|当前不可游玩/);
});

test("reconnect grace expires deterministically and access generation is checked",async t=>{
  const f=await fixture(t),catalog=await seedOfficialCatalog(f.pool,f.config),store=new RoomsStore(f.pool,f.config);
  const a=await player(f,"甲"),b=await player(f,"乙");
  const created=await store.create(a.access,catalog.find(g=>g.officialKey==="liars-dice")!.id);
  const joined=await store.join(b.access,created.roomId,created.inviteToken);
  await store.action(a.access,created.roomId,randomUUID(),joined.sequence,{type:"start"});
  await f.pool.query("UPDATE room_members SET last_seen_at=now()-interval '20 seconds' WHERE room_id=$1 AND player_id=$2",[created.roomId,a.guest.id]);
  const disconnected=await store.state(b.access,created.roomId);
  assert.equal(disconnected.view.players.find(p=>p.id===a.guest.id)!.connected,false);
  assert.equal((await store.state(a.access,created.roomId)).view.phase,"playing");
  await f.pool.query("UPDATE room_members SET last_seen_at=now()-interval '61 seconds' WHERE room_id=$1 AND player_id=$2",[created.roomId,a.guest.id]);
  const expired=await store.state(b.access,created.roomId);
  assert.equal(expired.view.hostId,b.guest.id);
  assert.equal(expired.view.phase,"finished");
  await assert.rejects(store.state(a.access,created.roomId),/不是有效/);
  await f.pool.query("UPDATE environments SET generation=generation+1 WHERE id=$1",[f.config.environmentId]);
  await assert.rejects(store.state(b.access,created.roomId),{code:"TEST_ACCESS_REQUIRED"});
});

test("HTTP rooms require CSRF and websocket tickets are single-use with immediate authorization checks",{timeout:15000},async t=>{
  const f=await fixture(t),catalog=await seedOfficialCatalog(f.pool,f.config),a=await player(f,"甲");
  const denied=await f.app.inject({method:"POST",url:"/api/v1/rooms",headers:{origin,cookie:a.cookie},payload:{gameId:catalog[0].id}});
  assert.equal(denied.statusCode,403);
  const response=await f.app.inject({method:"POST",url:"/api/v1/rooms",headers:a.headers,payload:{gameId:catalog[0].id}});
  assert.equal(response.statusCode,201,response.body);
  const created=response.json().data;
  const ticketResponse=await f.app.inject({method:"POST",url:`/api/v1/rooms/${created.roomId}/connection-tickets`,headers:a.headers});
  assert.equal(ticketResponse.statusCode,200,ticketResponse.body);
  const ticket=ticketResponse.json().data;
  const address=await f.app.listen({port:0,host:"127.0.0.1"});
  const ws=new WebSocket(address.replace("http:","ws:")+ticket.path,{origin});
  t.after(()=>ws.terminate());
  await once(ws,"open");
  const initial=once(ws,"message");ws.send(JSON.stringify({type:"authenticate",ticket:ticket.ticket}));
  const frame=JSON.parse((await initial)[0].toString());
  assert.equal(frame.type,"state");
  assert.equal(frame.data.view.you,a.guest.id);
  const b=await player(f,"乙"),changed=once(ws,"message");
  const joined=await f.app.inject({method:"POST",url:`/api/v1/rooms/${created.roomId}/join`,headers:b.headers,payload:{inviteToken:created.inviteToken}});
  assert.equal(joined.statusCode,200,joined.body);
  assert.equal(JSON.parse((await changed)[0].toString()).data.view.players.length,2);
  const reused=new WebSocket(address.replace("http:","ws:")+ticket.path,{origin});
  t.after(()=>reused.terminate());
  await once(reused,"open");
  const rejected=once(reused,"message");reused.send(JSON.stringify({type:"authenticate",ticket:ticket.ticket}));
  assert.equal(JSON.parse((await rejected)[0].toString()).code,"PERMISSION_DENIED");
  const closed=once(ws,"close");
  const revokedAt=Date.now();
  await f.pool.query("UPDATE test_access_sessions SET revoked_at=now() WHERE id=$1",[a.access.id]);
  await closed;
  assert.ok(Date.now()-revokedAt<5000,"idle WebSocket authorization revocation should propagate within five seconds locally");
});

test("a fresh API instance resumes the committed room after graceful server shutdown",async t=>{
  const f=await fixture(t),catalog=await seedOfficialCatalog(f.pool,f.config),a=await player(f,"重连玩家"),b=await player(f,"队友");
  const created=await f.app.inject({method:"POST",url:"/api/v1/rooms",headers:a.headers,payload:{gameId:catalog.find(g=>g.officialKey==="liars-dice")!.id}});
  assert.equal(created.statusCode,201,created.body);
  const room=created.json().data;
  const joined=await f.app.inject({method:"POST",url:`/api/v1/rooms/${room.roomId}/join`,headers:b.headers,payload:{inviteToken:room.inviteToken}});
  assert.equal(joined.statusCode,200,joined.body);
  const started=await f.app.inject({method:"POST",url:`/api/v1/rooms/${room.roomId}/start`,headers:a.headers,payload:{actionId:randomUUID(),expectedSequence:joined.json().data.sequence}});
  assert.equal(started.statusCode,200,started.body);
  const committed=started.json().data;
  assert.equal(committed.view.phase,"playing");
  await f.app.close();
  const replacement=await buildApp(f.config,f.pool);
  t.after(()=>replacement.app.close());
  await replacement.app.ready();
  const resumed=await replacement.app.inject({url:`/api/v1/rooms/${room.roomId}/state`,headers:{cookie:a.cookie}});
  assert.equal(resumed.statusCode,200,resumed.body);
  const data=resumed.json().data;
  assert.equal(data.versionId,room.versionId);
  assert.equal(data.view.you,a.guest.id);
  assert.equal(data.view.phase,"playing");
  assert.equal(data.sequence,committed.sequence);
  assert.deepEqual(data.view.round.yourDice,committed.view.round.yourDice);
  assert.equal(data.view.round.revealedDice,undefined);
  assert.equal((await f.pool.query("SELECT lease_epoch FROM rooms WHERE id=$1",[room.roomId])).rows[0].lease_epoch,2);
  await replacement.app.close();
});

test("OpenAPI construction and app close need no database when no room lease was used",async()=>{
  let queries=0;
  const unavailable=()=>{queries++;throw new Error("Database is intentionally unavailable");};
  const pool={query:unavailable,connect:unavailable} as unknown as Pool;
  const {app}=await buildApp({
    mode:"development",environmentId:"contract-test",host:"127.0.0.1",port:8788,databaseUrl:"postgresql://unused@127.0.0.1/unused",
    databaseSchema:"public",tokenSecret:"contract-test-without-database-connection",allowedOrigins:["http://127.0.0.1:5173"],secureCookies:false,accessTtlSeconds:3600,
  },pool);
  await app.ready();
  assert.ok(Object.keys(app.swagger().paths??{}).includes("/api/v1/rooms"));
  await app.close();
  assert.equal(queries,0);
});
