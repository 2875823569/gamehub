import "./style.css";
import { games } from "./platform/catalog";
import { arrow, brand, dice, escapeHtml as esc, rules } from "./ui";
import { roomView } from "./games/liars-dice/view";
import type { ClientAction, RoomView, ServerMessage, Session } from "../../../packages/protocol";
import { validBid } from "../../../packages/games/liars-dice/rules";

const app = document.querySelector<HTMLDivElement>("#app")!;
const modal = document.querySelector<HTMLDialogElement>("#modal")!;
const toast = document.querySelector<HTMLDivElement>("#toast")!;
let session: Session | undefined;
let state: RoomView | undefined;
let socket: WebSocket | undefined;
let connection = "连接中…";
let connected = false;
let stopped = false;
let pending = false;
let pendingTimer: ReturnType<typeof setTimeout>;
let reconnectTimer: ReturnType<typeof setTimeout>;
let heartbeat: ReturnType<typeof setInterval>;
let pongTimer: ReturnType<typeof setTimeout>;
let toastTimer: ReturnType<typeof setTimeout>;
let retry = 0;
let peek = false;
let count = 1;
let face = 2;
let bidKey = "";
let formBusy = false;

const storage = {
  get(key: string, persistent = false) { try { return (persistent ? localStorage : sessionStorage).getItem(key); } catch { return null; } },
  set(key: string, value: string, persistent = false) { try { (persistent ? localStorage : sessionStorage).setItem(key, value); } catch { /* Session still works until reload. */ } },
  remove(key: string) { try { sessionStorage.removeItem(key); } catch { /* Ignore unavailable storage. */ } }
};

function lobby() {
  const game = games[0];
  return `<header class="site-header">${brand}<nav><a class="nav-active" href="#games">游戏大厅</a><button class="text-button" data-action="rules">怎么玩</button></nav><button class="button small secondary" data-action="join">加入房间 ${arrow}</button></header>
    <main class="home-page">
      <section class="hero">
        <div class="hero-copy"><div class="hero-kicker"><span class="pulse-dot"></span>把朋友叫上，把快乐打开</div><h1>今晚，<br>一起玩点<span class="accent-word">什么。</span></h1><p>不必下载，不必注册。<br>一个房间，一群朋友，就差你了。</p><div class="hero-actions"><button class="button primary" data-action="create">开一桌吹牛骰子 ${arrow}</button><button class="button ghost" data-action="join">我有房间码 <span>→</span></button></div><div class="hero-note"><span class="tiny-avatars"><i>你</i><i>我</i><i>他</i></span><span>隔着屏幕，也能坐在同一桌。</span></div></div>
        <div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><span class="art-spark spark-one">✦</span><span class="art-spark spark-two">✳</span><div class="art-die mint">${dice(5)}</div><div class="art-die cream">${dice(3)}</div><div class="art-die coral">${dice(1)}</div><div class="art-sticker sticker-one">你确定？<span>👀</span></div><div class="art-sticker sticker-two">不信，开！ ↗</div><div class="art-caption">LESS SCROLLING. MORE PLAYING.</div></div>
      </section>
      <section class="games-section" id="games"><div class="section-heading"><div><span class="eyebrow">PICK YOUR NEXT ROUND</span><h2>快乐，从这一局开始<span class="accent-dot">.</span></h2></div><span class="game-count">01 款游戏 · 持续上新</span></div>
        <div class="game-grid"><article class="featured-game"><div class="card-art"><span class="available-badge"><i></i>现在就能玩</span><div class="card-dice">${dice(2)}${dice(5)}${dice(3)}</div><div class="card-art-word">BLUFF<br><span>& ROLL.</span></div><span class="card-art-caption">你的演技，值几个点？</span></div><div class="card-content"><div class="card-title"><h3>${game.title}</h3><span>${game.category}</span></div><p>${game.subtitle}</p><div class="game-meta"><span>♧ ${game.players}</span><span>◷ ${game.duration}</span><span>朋友聚会</span></div><div class="card-actions"><button class="button primary" data-action="create">创建房间 ${arrow}</button><button class="text-button" data-action="rules">先看规则 →</button></div></div></article>
        <article class="coming-soon"><div class="coming-symbol" aria-hidden="true">＋</div><span class="eyebrow">THE NEXT GOOD TIME</span><h3>下一种快乐，<br>正在路上。</h3><p>这里会装下更多适合<br>和朋友一起玩的小游戏。</p><span class="soon-label">敬请期待</span><div class="coming-line"></div></article></div>
      </section>
      <section class="steps-strip"><div><span>01</span><p><b>开一个房间</b>选好游戏，取个昵称</p></div><i>→</i><div><span>02</span><p><b>叫上你的朋友</b>分享链接，或输入房间码</p></div><i>→</i><div><span>03</span><p><b>把今晚交给快乐</b>人齐开局，输了再来</p></div></section>
    </main><footer class="site-footer"><span>玩伴 PLAYROOM</span><p>认真玩，轻松赢。和朋友，再来一局。</p><span>MADE FOR GOOD TIMES ↗</span></footer>`;
}

function render() {
  app.innerHTML = state ? roomView(state, { connected, connectionLabel: connection, pending, count, face, peek }) : session
    ? `<header class="site-header">${brand}</header><main class="connecting-page"><div class="spinner"></div><h1>正在入座…</h1><p>${esc(connection)}</p><button class="button secondary" data-action="rejoin">连接不成功？重新加入</button></main>`
    : lobby();
  updateCountdowns();
}

function notify(message: string) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4200);
}

function openModal(content: string) {
  modal.innerHTML = `<button class="modal-close" data-action="close-modal" aria-label="关闭">×</button>${content}`;
  if (!modal.open) modal.showModal();
  setTimeout(() => modal.querySelector<HTMLInputElement>("input")?.focus(), 50);
}

function roomForm(mode: "create" | "join", code = "") {
  formBusy = false;
  const nickname = storage.get("playroom.nickname", true) ?? "";
  openModal(`<span class="eyebrow">${mode === "create" ? "HOST A GOOD TIME" : "TAKE YOUR SEAT"}</span>
    <h2>${mode === "create" ? "这桌，你来组。" : "朋友在等你。"}</h2><p class="modal-description">${mode === "create" ? "创建一个吹牛骰子房间，叫上朋友就能开玩。" : "输入昵称和房间码，一起加入这场好戏。"}</p>
    <form id="room-form" data-mode="${mode}"><label for="nickname">怎么称呼你</label><input id="nickname" name="nickname" autocomplete="nickname" maxlength="12" placeholder="取个朋友认得出的昵称" value="${esc(nickname)}" required>
    ${mode === "join" ? `<label for="room-code">6 位房间码</label><input id="room-code" name="roomCode" class="code-input" autocomplete="off" autocapitalize="characters" maxlength="6" minlength="6" placeholder="例如 ABC234" value="${esc(code)}" required>` : ""}
    <p class="form-error" role="alert"></p><button class="button primary full" type="submit">${mode === "create" ? "创建房间" : "进入房间"} ${arrow}</button></form><p class="micro centered">免注册 · 2～6 人 · 一个输家，一局结束</p>`);
}

function resetConnection() {
  stopped = true;
  clearTimeout(reconnectTimer);
  clearTimeout(pendingTimer);
  clearInterval(heartbeat);
  clearTimeout(pongTimer);
  const old = socket;
  socket = undefined;
  if (old) { old.onclose = null; old.onmessage = null; old.close(); }
  connected = false;
  pending = false;
}

function leaveLocal() {
  resetConnection();
  session = undefined;
  state = undefined;
  storage.remove("playroom.session");
  history.replaceState(null, "", "/");
  document.title = "玩伴 PLAYROOM · 和朋友，再来一局";
  render();
}

function connect() {
  if (!session || stopped) return;
  connection = retry ? "连接中断，正在重连；60 秒内回来可继续本局。" : "正在连接房间…";
  render();
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${session.code}/socket?token=${encodeURIComponent(session.token)}`);
  socket = ws;
  const connectionTimeout = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 12_000);
  ws.onopen = () => {
    if (socket !== ws) return;
    clearTimeout(connectionTimeout);
    connected = true;
    connection = "实时连接已建立";
    retry = 0;
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("ping");
        clearTimeout(pongTimer);
        pongTimer = setTimeout(() => ws.close(), 10_000);
      }
    }, 20_000);
    render();
  };
  ws.onmessage = event => {
    if (socket !== ws) return;
    if (event.data === "pong") { clearTimeout(pongTimer); return; }
    const message = JSON.parse(event.data) as ServerMessage;
    pending = false;
    clearTimeout(pendingTimer);
    if (message.type === "state") {
      const prior = state;
      state = message.state;
      if (state.round?.number !== prior?.round?.number) peek = false;
      const nextKey = `${state.round?.number}:${state.round?.bids.length}`;
      if (bidKey !== nextKey) {
        const previous = state.round?.bids.at(-1);
        count = previous ? previous.count + (previous.face === 6 ? 1 : 0) : 1;
        face = previous ? (previous.face === 6 ? 2 : previous.face + 1) : 2;
        bidKey = nextKey;
      }
      if (state.phase === "finished" && prior?.phase === "playing") notify("开骰了！本局结果已揭晓。");
      else if (state.phase === "playing" && state.round?.turnId === state.you && prior?.round?.turnId !== state.you) notify("轮到你了：叫点，或者开上一家。");
      document.title = `${state.code} · 吹牛骰子 · 玩伴`;
      render();
    } else if (message.type === "error") {
      notify(message.message);
      render();
    } else if (message.type === "left") {
      leaveLocal();
      notify("已离开房间。下次再一起玩！");
    }
  };
  ws.onclose = event => {
    clearTimeout(connectionTimeout);
    if (socket !== ws || stopped) return;
    connected = false;
    pending = false;
    clearInterval(heartbeat);
    clearTimeout(pongTimer);
    if (event.code === 4001) {
      stopped = true;
      connection = "你已在另一个页面连接，这个页面已暂停。";
      render();
      return;
    }
    connection = "连接中断，正在重连；60 秒内回来可继续本局。";
    render();
    reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 5000));
  };
  ws.onerror = () => { /* onclose handles retries; credentials never enter error messages. */ };
}

function send(action: ClientAction) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) { notify("正在恢复连接，请稍等。"); return; }
  if (pending) return;
  pending = true;
  socket.send(JSON.stringify(action));
  pendingTimer = setTimeout(() => { pending = false; notify("还没有收到确认，正在重新连接。"); socket?.close(); }, 8000);
  render();
}

async function copy(text: string, success: string) {
  try { await navigator.clipboard.writeText(text); notify(success); }
  catch {
    openModal(`<h2>复制给朋友</h2><p>长按或选中下方内容复制。</p><input class="copy-fallback" aria-label="邀请内容" readonly value="${esc(text)}">`);
    modal.querySelector<HTMLInputElement>("input")?.select();
  }
}

document.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!button || (button instanceof HTMLButtonElement && button.disabled)) return;
  event.preventDefault();
  switch (button.dataset.action) {
    case "create": roomForm("create"); break;
    case "join": roomForm("join"); break;
    case "rules": openModal(rules()); break;
    case "close-modal": modal.close(); break;
    case "invite": if (session) void copy(`${location.origin}/?room=${session.code}`, "邀请链接已复制，发给朋友就能加入。"); break;
    case "copy-code": if (session) void copy(session.code, "房间码已复制。"); break;
    case "peek": peek = !peek; render(); break;
    case "count-down": count = Math.max(1, count - 1); render(); break;
    case "count-up": count = Math.min((state?.round?.playerIds.length ?? 6) * 5, count + 1); render(); break;
    case "face": face = Number(button.dataset.face); render(); break;
    case "start": send({ type: "start" }); break;
    case "bid": send({ type: "bid", count, face }); break;
    case "challenge": send({ type: "challenge" }); break;
    case "leave-prompt": openModal(`<span class="eyebrow">SEE YOU NEXT ROUND</span><h2>要先离开这桌吗？</h2><p class="modal-description">${state?.phase === "playing" && state.round?.playerIds.includes(state.you) ? "本局正在进行，主动离开会判定你为输家，并立即结束本局。" : "离开后，可以用房间码重新加入。"}</p><button class="button challenge full" data-action="leave">确认离开</button><button class="button secondary full modal-secondary" data-action="close-modal">再坐一会儿</button>`); break;
    case "leave": modal.close(); if (connected) send({ type: "leave" }); else { leaveLocal(); notify("已退出页面；对局中的离线身份会在 60 秒后判负。"); } break;
    case "rejoin": {
      const code = session?.code ?? "";
      leaveLocal();
      roomForm("join", code);
      break;
    }
  }
});

function refreshBidButton() {
  const button = document.querySelector<HTMLButtonElement>('[data-action="bid"]');
  if (!button || !state?.round) return;
  button.innerHTML = `叫 ${count} 个 ${face} <span>↑</span>`;
  button.disabled = !connected || pending || state.phase !== "playing" || state.round.turnId !== state.you ||
    !validBid(count, face, state.round.bids.at(-1), state.round.playerIds.length * 5);
}

document.addEventListener("input", event => {
  const input = event.target as HTMLInputElement;
  if (input.id === "bid-count") {
    count = Number(input.value);
    refreshBidButton();
  }
});

document.addEventListener("change", event => {
  const input = event.target as HTMLInputElement;
  if (input.id === "bid-count") {
    count = Math.max(1, Math.min((state?.round?.playerIds.length ?? 6) * 5, Math.trunc(Number(input.value) || 1)));
    input.value = String(count);
    refreshBidButton();
  }
});

document.addEventListener("submit", async event => {
  const form = event.target as HTMLFormElement;
  if (form.id !== "room-form") return;
  event.preventDefault();
  if (formBusy) return;
  const name = (form.elements.namedItem("nickname") as HTMLInputElement).value.trim();
  const mode = form.dataset.mode;
  const code = mode === "join" ? (form.elements.namedItem("roomCode") as HTMLInputElement).value.trim().toUpperCase() : "";
  const error = form.querySelector<HTMLElement>(".form-error")!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  if (!name || [...name].length > 12) { error.textContent = "请输入 1～12 个字的昵称。"; return; }
  if (mode === "join" && !/^[A-HJ-NP-Z2-9]{6}$/.test(code)) { error.textContent = "请输入正确的 6 位房间码，不包含 I、O、0、1。"; return; }
  formBusy = true;
  submit.disabled = true;
  submit.textContent = "正在入座…";
  error.textContent = "";
  try {
    const response = await fetch(mode === "create" ? "/api/rooms" : `/api/rooms/${code}/join`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15_000)
    });
    const data = await response.json() as Session & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "房间连接失败。");
    resetConnection();
    session = { code: data.code, playerId: data.playerId, token: data.token };
    state = undefined;
    retry = 0;
    stopped = false;
    storage.set("playroom.session", JSON.stringify(session));
    storage.set("playroom.nickname", name, true);
    history.replaceState(null, "", `/?room=${session.code}`);
    modal.close();
    connect();
  } catch (e) {
    error.textContent = e instanceof Error && e.name !== "TimeoutError" ? e.message : "连接超时，请检查网络后重试。";
    submit.disabled = false;
    submit.innerHTML = `${mode === "create" ? "创建房间" : "进入房间"} ${arrow}`;
  } finally { formBusy = false; }
});

modal.addEventListener("click", event => { if (event.target === modal) { const r = modal.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) modal.close(); } });

function updateCountdowns() {
  document.querySelectorAll<HTMLElement>("[data-deadline]").forEach(el => {
    const seconds = Math.max(0, Math.ceil((Number(el.dataset.deadline) - Date.now()) / 1000));
    el.textContent = seconds ? `重连中 · ${seconds}s` : "正在处理离线";
  });
}
setInterval(updateCountdowns, 1000);

const requestedCode = new URLSearchParams(location.search).get("room")?.toUpperCase();
try {
  const saved = JSON.parse(storage.get("playroom.session") ?? "null") as Session | null;
  if (saved?.code && saved.token && saved.playerId && (!requestedCode || requestedCode === saved.code)) session = saved;
} catch { storage.remove("playroom.session"); }
render();
if (session) { history.replaceState(null, "", `/?room=${session.code}`); connect(); }
else if (requestedCode) roomForm("join", requestedCode);
