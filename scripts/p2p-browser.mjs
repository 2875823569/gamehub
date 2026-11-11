import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const base = process.env.GAMEHUB_TEST_URL ?? "http://127.0.0.1:8787";
const browser = await chromium.launch({ channel: process.env.GAMEHUB_BROWSER ?? "msedge", headless: true });
const errors = [];
const clients = [];
async function post(path, body) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}
async function pageFor(session, disableRTC = false) {
  const context = await browser.newContext();
  await context.addInitScript(({ session, disableRTC }) => {
    sessionStorage.setItem("playroom.session", JSON.stringify(session));
    window.testPeers = [];
    window.testWire = [];
    window.testFrames = [];
    const OriginalWS = WebSocket;
    window.WebSocket = class extends OriginalWS {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", e => {
          if (e.data === "pong") return;
          const frame = JSON.parse(e.data);
          if (frame.type === "peer-relay" && frame.payload?.message?.type === "state") window.testState = frame.payload.message.state;
        });
      }
      send(data) {
        if (data !== "ping") window.testWire.push(JSON.parse(data));
        return super.send(data);
      }
    };
    if (disableRTC) window.RTCPeerConnection = undefined;
    else {
      const OriginalRTC = RTCPeerConnection;
      window.RTCPeerConnection = class extends OriginalRTC {
        constructor(config) {
          // Local RTC tests do not depend on an external STUN service.
          super({ ...config, iceServers: [] });
          window.testPeers.push(this);
          this.addEventListener("datachannel", e => instrument(e.channel));
        }
        createDataChannel(...args) { const dc = super.createDataChannel(...args); instrument(dc); return dc; }
      };
      function instrument(dc) {
        const originalSend = dc.send.bind(dc);
        dc.send = data => { if (!window.dropPeerOutput) originalSend(data); };
        dc.addEventListener("message", e => {
          const frame = JSON.parse(e.data);
          window.testFrames.push(frame);
          if (frame.payload?.message?.type === "state") window.testState = frame.payload.message.state;
        });
      }
    }
    // UI status and DOM remain the assertion surface; frames additionally verify privacy.
  }, { session, disableRTC });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.locator(".room-code-block button").waitFor();
  clients.push({ page, session });
  return page;
}
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
try {
  const hostSession = await post("/api/rooms", { name: "直连房主", network: "p2p" });
  const host = await pageFor(hostSession);
  const guestSession = await post(`/api/rooms/${hostSession.code}/join`, { name: "直连朋友" });
  const guest = await pageFor(guestSession);
  await until(async () => (await guest.locator(".connection-status").innerText()).includes("P2P 直连"), "real data channel connected");
  await host.locator('[data-action="start"]').click();
  await until(() => guest.evaluate(() => window.testState?.phase === "playing"), "private game view over data channel");
  let state = await guest.evaluate(() => window.testState);
  assert.equal(state.round.yourDice.length, 5);
  assert.equal(state.round.revealedDice, undefined);
  assert.equal(state.round.dice, undefined);
  assert.equal(JSON.stringify(state).includes(hostSession.token), false);
  const first = state.round.turnId === hostSession.playerId ? host : guest;
  const second = first === host ? guest : host;
  await first.waitForTimeout(200);
  await first.locator('[data-action="bid"]').click();
  await until(() => guest.evaluate(() => window.testState?.round?.bids.length === 1), "bid arrives directly");
  // Neither player sends gameplay actions through the signaling WebSocket while RTC works.
  assert.equal(await guest.evaluate(() => window.testWire.some(m => m.type === "peer-relay" && m.payload?.type === "action")), false);
  await second.waitForTimeout(200);
  await second.locator('[data-action="challenge"]').click();
  await until(() => guest.evaluate(() => window.testState?.phase === "finished"), "settlement over RTC");
  console.log("PASS real WebRTC: private hands, direct action, shared settlement without action relay");

  await host.waitForTimeout(200);
  await host.locator('[data-action="start"]').click();
  await until(() => guest.evaluate(() => window.testState?.round?.number === 2), "rematch");
  const secondDice = await guest.evaluate(() => window.testState.round.yourDice);
  await host.reload();
  await until(async () => (await guest.locator(".connection-status").innerText()).includes("P2P 直连"), "host refreshed, RTC rebuilt");
  await until(() => guest.evaluate(() => window.testState?.round?.number === 2), "host state restored");
  assert.deepEqual(await guest.evaluate(() => window.testState.round.yourDice), secondDice);
  await guest.reload();
  await until(async () => (await guest.locator(".connection-status").innerText()).includes("P2P 直连"), "guest refreshed");
  assert.deepEqual(await guest.evaluate(() => window.testState.round.yourDice), secondDice);
  console.log("PASS host and guest refresh preserve the same private hand");

  // A channel may remain 'open' while packets disappear. Relay retries must
  // return their own response through the relay, without applying the move twice.
  const restoredState = await guest.evaluate(() => window.testState);
  if (restoredState.round.turnId === guestSession.playerId) {
    await guest.waitForTimeout(200);
    await guest.locator('[data-action="bid"]').click();
    await until(() => guest.evaluate(() => window.testState.round.bids.length === 1), "guest opens before loss test");
  }
  await host.waitForTimeout(200);
  await host.locator('[data-action="bid"]').click();
  await until(() => guest.evaluate(id => window.testState.round.turnId === id && window.testState.round.bids.length > 0, guestSession.playerId), "host bids before loss test");
  await host.evaluate(() => { window.dropPeerOutput = true; });
  await guest.waitForTimeout(200);
  await guest.locator('[data-action="challenge"]').click();
  await until(async () => !(await guest.locator("body").innerText()).includes("正在发送") &&
    await guest.evaluate(() => window.testState.phase === "finished"), "lost RTC response recovered through relay");
  assert.ok(await guest.evaluate(() => window.testWire.some(m => m.type === "peer-relay" && m.payload?.type === "action")));
  await host.evaluate(() => { window.dropPeerOutput = false; });
  await host.waitForTimeout(200);
  await host.locator('[data-action="start"]').click();
  await until(() => guest.evaluate(() => window.testState.round.number === 3), "new round after recovered action");
  console.log("PASS lost data-channel responses recover via relay without duplicate actions");

  // Closing RTC forces the next action through the authenticated relay.
  await guest.evaluate(() => { for (const pc of window.testPeers) pc.close(); window.RTCPeerConnection = undefined; });
  await until(async () => (await guest.locator(".connection-status").innerText()).includes("服务器转发"), "RTC fallback label");
  await host.locator('button[data-action="leave-prompt"]').click();
  await host.locator('[data-action="leave"]').click();
  await until(async () => (await guest.locator(".connection-status").innerText()).includes("房主主持"), "host migration");
  assert.match(await guest.locator("body").innerText(), /本局结束|本局结果/);
  console.log("PASS RTC failure falls back and departing host transfers ownership");

  const relaySession = await post("/api/rooms", { name: "转发房主", gameId: "defuse", network: "p2p" });
  const relayHost = await pageFor(relaySession, true);
  const relayGuestSession = await post(`/api/rooms/${relaySession.code}/join`, { name: "转发朋友" });
  const relayGuest = await pageFor(relayGuestSession, true);
  await until(async () => (await relayGuest.locator(".connection-status").innerText()).includes("服务器转发"), "RTC unavailable relay ready");
  await relayHost.locator('[data-action="start"]').click();
  await until(async () => (await relayGuest.locator(".party-game").count()) > 0 ||
    (await relayGuest.locator("body").innerText()).includes("剩余 180 秒") ||
    (await relayGuest.locator("[data-game-deadline]").count()) > 0, "relay cooperative game started");
  assert.ok(await relayGuest.locator("[data-game-deadline]").count());
  const beforeRelay = await relayHost.evaluate(() => window.testWire.filter(m => m.type === "peer-checkpoint").at(-1).snapshot.revision);
  await relayGuest.locator("[data-game-action]").first().click();
  await until(() => relayGuest.evaluate(() => window.testWire.some(m => m.type === "peer-relay" && m.payload?.type === "action")), "guest action uses fallback");
  await until(() => relayHost.evaluate(revision =>
    window.testWire.filter(m => m.type === "peer-checkpoint").at(-1).snapshot.revision > revision, beforeRelay), "host processes relayed action");
  console.log("PASS unsupported WebRTC still starts a multiplayer game over relay");
  assert.deepEqual(errors, []);
} finally {
  // Clear only these test rooms through the public protocol.
  for (const { session } of clients) {
    try {
      const ws = new WebSocket(base.replace(/^http/, "ws") + `/api/rooms/${session.code}/socket?token=${session.token}`);
      await new Promise(resolve => {
        const timeout = setTimeout(() => { ws.close(); resolve(); }, 2000);
        ws.onopen = () => { ws.send(JSON.stringify({ type: "leave" })); };
        ws.onclose = ws.onerror = () => { clearTimeout(timeout); resolve(); };
      });
    } catch {}
  }
  await browser.close();
}
