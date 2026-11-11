import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fixture, origin } from "./fixtures";
import { testLogin } from "./identity-fixture";
import { walletFixture } from "./wallet-fixture";
import { seedOfficialCatalog } from "../../services/api/catalog-seed";
import { RoomsStore } from "../../services/api/rooms-store";

async function seedGame(f: Awaited<ReturnType<typeof fixture>>, ownerId: string) {
  const gameId = randomUUID(), versionId = randomUUID();
  await f.pool.query("INSERT INTO games(id,environment_id,owner_id,title,status) VALUES($1,$2,$3,'Community test','published')", [gameId, f.config.environmentId, ownerId]);
  await f.pool.query(
    `INSERT INTO game_versions(id,game_id,number,manifest,files,source,content_digest,check_status,review_status)
     VALUES($1,$2,1,'{}','{}','official',$3,'passed','approved')`, [versionId, gameId, "a".repeat(64)]);
  await f.pool.query("INSERT INTO publication_heads(environment_id,scope,game_id,version_id) VALUES($1,'internal_catalog',$2,$3)", [f.config.environmentId, gameId, versionId]);
  return { gameId, versionId };
}

test("SOC-01/02: comments allow one reply level and only their author can delete; likes/favorites are idempotent", async t => {
  const f = await fixture(t), author = await testLogin(f, "13800000101"), player = await testLogin(f, "13800000102");
  const game = await seedGame(f, author.user.id);
  const posted = await f.app.inject({ method: "POST", url: `/api/v1/games/${game.gameId}/comments`, headers: player.headers, payload: { content: "正常评论" } });
  assert.equal(posted.statusCode, 200, posted.body);
  const commentId = posted.json().data.id;
  const reply = await f.app.inject({ method: "POST", url: `/api/v1/comments/${commentId}/replies`, headers: author.headers, payload: { content: "作者回复" } });
  assert.equal(reply.statusCode, 200);
  const nested = await f.app.inject({ method: "POST", url: `/api/v1/comments/${reply.json().data.id}/replies`, headers: player.headers, payload: { content: "二级回复不支持" } });
  assert.equal(nested.statusCode, 409);
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/v1/comments/${commentId}`, headers: author.headers })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/v1/comments/${commentId}`, headers: player.headers })).statusCode, 200);
  const list = await f.app.inject({ url: `/api/v1/games/${game.gameId}/comments`, headers: { cookie: author.access.cookie } });
  assert.equal(list.json().data.find((row: { id: string }) => row.id === commentId).content, "");
  const likes = await Promise.all(Array.from({ length: 8 }, () => f.app.inject({ method: "PUT", url: `/api/v1/games/${game.gameId}/like`, headers: player.headers })));
  assert.ok(likes.every(r => r.statusCode === 200));
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM likes")).rows[0].n, 1);
  const favorite = await f.app.inject({ method: "PUT", url: `/api/v1/games/${game.gameId}/favorite`, headers: player.headers });
  assert.equal(favorite.statusCode, 200);
  assert.equal((await f.app.inject({ url: "/api/v1/me/favorites", headers: { cookie: player.cookie } })).json().data[0].id, game.gameId);
  assert.equal((await f.app.inject({ method: "DELETE", url: `/api/v1/games/${game.gameId}/like`, headers: player.headers })).json().data.count, 0);
});

test("SOC-02/03: suspicious content stays pending, reports stay private, duplicate processing sends one notification", async t => {
  const f = await fixture(t), reviewer = await testLogin(f, "13800000103", ["reviewer"]), player = await testLogin(f, "13800000104");
  assert.ok(reviewer.admin);
  const game = await seedGame(f, reviewer.user.id);
  const comment = await f.app.inject({ method: "POST", url: `/api/v1/games/${game.gameId}/comments`, headers: player.headers, payload: { content: "<script>review this</script>" } });
  assert.equal(comment.json().data.status, "pending");
  assert.equal((await f.app.inject({ url: `/api/v1/games/${game.gameId}/comments`, headers: { cookie: player.cookie } })).json().data.length, 0);
  const requestReport = () => f.app.inject({ method: "POST", url: "/api/v1/reports", headers: player.headers, payload: { objectType: "game", objectId: game.gameId, reason: "测试举报" } });
  const a = await requestReport(), b = await requestReport();
  assert.equal(a.json().data.id, b.json().data.id);
  const id = a.json().data.id;
  assert.equal((await f.app.inject({ url: `/api/v1/reports/${id}`, headers: { cookie: reviewer.cookie } })).statusCode, 404);
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/v1/admin/reports/${id}`, headers: reviewer.admin.headers, payload: { state: "resolved", reason: "已检查并处理" } })).statusCode, 200);
  }
  const notifications = await f.app.inject({ url: "/api/v1/notifications", headers: { cookie: player.cookie } });
  assert.equal(notifications.json().data.length, 1);
  const noteId = notifications.json().data[0].id;
  assert.equal((await f.app.inject({ method: "PATCH", url: `/api/v1/notifications/${noteId}`, headers: reviewer.headers, payload: { read: true } })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "PATCH", url: `/api/v1/notifications/${noteId}`, headers: player.headers, payload: { read: true } })).statusCode, 200);
  await f.pool.query("DELETE FROM publication_heads WHERE game_id=$1", [game.gameId]);
  assert.equal((await f.app.inject({ url: `/api/v1/games/${game.gameId}/comments`, headers: { cookie: player.cookie } })).statusCode, 404);
});

test("FEED-01/02: visitors own their feedback, diagnostics are allowlisted, fix version and retest form a closed loop", async t => {
  const f = await fixture(t), author = await testLogin(f, "13800000105"), admin = await testLogin(f, "13800000106", ["support"]);
  assert.ok(admin.admin);
  const game = await seedGame(f, author.user.id), visitor = await f.enter(), stranger = await f.enter();
  const headers = { origin, cookie: visitor.cookie, "x-csrf-token": visitor.csrf };
  const invalid = await f.app.inject({ method: "POST", url: "/api/v1/test-feedback", headers,
    payload: { expected: "能进入", actual: "白屏", diagnostics: { token: "must-not-store" } } });
  assert.equal(invalid.statusCode, 400);
  const created = await f.app.inject({ method: "POST", url: "/api/v1/test-feedback", headers,
    payload: { gameId: game.gameId, versionId: game.versionId, expected: "能进入", actual: "白屏", diagnostics: { errorCode: "LOAD_FAILED" } } });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().data.id;
  assert.equal((await f.app.inject({ url: `/api/v1/test-feedback/${id}`, headers: { cookie: stranger.cookie } })).statusCode, 404);
  assert.equal((await f.app.inject({ url: `/api/v1/test-feedback/${id}`, headers: { cookie: author.cookie } })).statusCode, 200);
  const noFix = await f.app.inject({ method: "PATCH", url: `/api/v1/admin/test-feedback/${id}`, headers: admin.admin.headers, payload: { state: "awaiting_retest", reason: "请重试" } });
  assert.equal(noFix.statusCode, 409);
  const fixId = randomUUID();
  await f.pool.query("INSERT INTO game_versions(id,game_id,number,manifest,files,source,content_digest,check_status,review_status) VALUES($1,$2,2,'{}','{}','official',$3,'passed','approved')", [fixId, game.gameId, "b".repeat(64)]);
  assert.equal((await f.app.inject({ method: "PATCH", url: `/api/v1/admin/test-feedback/${id}`, headers: admin.admin.headers,
    payload: { state: "awaiting_retest", reason: "已修复", fixVersionId: fixId } })).statusCode, 200);
  const wrongRetest = await f.app.inject({ method: "POST", url: `/api/v1/test-feedback/${id}/retests`, headers: { origin, cookie: stranger.cookie, "x-csrf-token": stranger.csrf }, payload: { resolved: true, details: "不属于我" } });
  assert.equal(wrongRetest.statusCode, 404);
  const retest = await f.app.inject({ method: "POST", url: `/api/v1/test-feedback/${id}/retests`, headers, payload: { resolved: true, details: "新版本已正常" } });
  assert.equal(retest.json().data.state, "closed");
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM test_feedback_events WHERE feedback_id=$1", [id])).rows[0].n, 2);
});

test("FEED-01: attachment content requires digest/type validation and ownership; another visitor cannot attach or download", async t => {
  const f = await fixture(t), visitor = await f.enter(), other = await f.enter();
  const headers = { origin, cookie: visitor.cookie, "x-csrf-token": visitor.csrf }, text = Buffer.from("errorCode=LOAD_FAILED");
  const upload = await f.app.inject({ method: "POST", url: "/api/v1/test-feedback/uploads", headers, payload: { mime: "text/plain", size: text.length, sha256: createHash("sha256").update(text).digest("hex") } });
  const id = upload.json().data.id;
  const complete = await f.app.inject({ method: "POST", url: `/api/v1/test-feedback/uploads/${id}/complete`, headers, payload: { base64: text.toString("base64") } });
  assert.equal(complete.json().data.status, "passed");
  const stolen = await f.app.inject({ method: "POST", url: "/api/v1/test-feedback", headers: { origin, cookie: other.cookie, "x-csrf-token": other.csrf }, payload: { expected: "正常", actual: "错误", attachmentIds: [id] } });
  assert.equal(stolen.statusCode, 403);
  const feedback = await f.app.inject({ method: "POST", url: "/api/v1/test-feedback", headers, payload: { expected: "正常", actual: "错误", attachmentIds: [id] } });
  assert.equal(feedback.statusCode, 200, feedback.body);
  assert.equal((await f.app.inject({ url: `/api/v1/test-feedback/uploads/${id}/content`, headers: { cookie: other.cookie } })).statusCode, 404);
  const download = await f.app.inject({ url: `/api/v1/test-feedback/uploads/${id}/content`, headers: { cookie: visitor.cookie } });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, text.toString());
  assert.equal(download.headers["x-content-type-options"], "nosniff");
});

test("FEED-01: room/task links bind exact ownership and version, including failed-task context",async t=>{
  const f=await walletFixture(t),task=await f.task(),visitor=await f.enter(),other=await f.enter();
  await f.store.guest(visitor.token,"测试玩家");
  const store=new RoomsStore(f.pool,f.config),catalog=await seedOfficialCatalog(f.pool,f.config);
  const room=await store.create(await f.store.current(visitor.token),catalog[0].id);
  const visitorHeaders={origin,cookie:visitor.cookie,"x-csrf-token":visitor.csrf},otherHeaders={origin,cookie:other.cookie,"x-csrf-token":other.csrf};
  const submitted=await f.app.inject({method:"POST",url:"/api/v1/test-feedback",headers:visitorHeaders,payload:{roomId:room.roomId,expected:"正常开局",actual:"没有变化"}});
  assert.equal(submitted.statusCode,200,submitted.body);
  const detail=await f.app.inject({url:`/api/v1/test-feedback/${submitted.json().data.id}`,headers:{cookie:visitor.cookie}});
  assert.equal(detail.json().data.version_id,room.versionId);
  assert.equal(detail.json().data.room_id,room.roomId);
  assert.equal((await f.app.inject({method:"POST",url:"/api/v1/test-feedback",headers:otherHeaders,payload:{roomId:room.roomId,expected:"正常",actual:"错误"}})).statusCode,404);
  const taskHeaders={origin,cookie:f.login.cookie,"x-csrf-token":f.login.access.csrf};
  const taskFeedback=await f.app.inject({method:"POST",url:"/api/v1/test-feedback",headers:taskHeaders,payload:{taskId:task.id,expected:"生成完成",actual:"仍在排队"}});
  assert.equal(taskFeedback.statusCode,200,taskFeedback.body);
  const row=(await f.pool.query("SELECT game_id,task_id FROM test_feedback WHERE id=$1",[taskFeedback.json().data.id])).rows[0];
  assert.equal(row.game_id,f.gameId);assert.equal(row.task_id,task.id);
  const outsider=await testLogin(f,"13800000317");
  assert.equal((await f.app.inject({method:"POST",url:"/api/v1/test-feedback",headers:{origin,cookie:outsider.cookie,"x-csrf-token":outsider.access.csrf},payload:{taskId:task.id,expected:"正常",actual:"错误"}})).statusCode,404);
});
