import { api, session, PlatformError, type JsonRow } from "./platform-client";
import type { RoomView, ClientAction } from "../../../packages/protocol";
import { FACE_ORDER, minimumBid, validBid, type BidMode } from "../../../packages/games/liars-dice/rules";
import { games as officialGames } from "./platform/catalog";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
export async function openOfficialRoom(container: HTMLElement, roomId: string, invitation: string | undefined, message: (value: string) => void) {
  sessionStorage.setItem("gamehub-feedback-context", JSON.stringify({ roomId }));
  let active = true, pending = false, poll: ReturnType<typeof setInterval> | undefined;
  let socket: WebSocket | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
  let current: { roomId: string; sequence: number; view: RoomView } | undefined;
  const storageKey = `gamehub-room-invite:${roomId}`;
  if (invitation) {
    await api(`/rooms/${roomId}/join`, "POST", { inviteToken: invitation }, "access");
    sessionStorage.setItem(storageKey, invitation);
    history.replaceState(null, "", `#/room/${roomId}`);
  }
  const nickname = session.guest?.nickname ?? session.user?.nickname ?? "玩家";
  const refresh = async () => {
    if (!active || pending) return;
    try {
      const next = await api<{ roomId: string; sequence: number; view: RoomView }>(`/rooms/${roomId}/state`);
      if (!active) return;
      const changed = !current || JSON.stringify(current.view) !== JSON.stringify(next.view);
      current = next;
      if (changed) draw();
    } catch (error) {
      if (!active) return;
      if (error instanceof PlatformError && ["GAME_UNAVAILABLE", "TEST_ACCESS_REQUIRED", "PERMISSION_DENIED", "NOT_FOUND"].includes(error.code)) {
        active = false; if (poll) clearInterval(poll);
        container.innerHTML = `<section class="panel"><h2>房间当前不可用</h2><p>${escape(error.message)}</p><a href="#/games">返回大厅</a></section>`;
      } else message(error instanceof Error ? error.message : "连接暂时不可用");
    }
  };
  const send = async (action: ClientAction) => {
    if (pending || !current) return;
    pending = true;
    try {
      const response = await api(`/rooms/${roomId}/actions`, "POST", {
        actionId: crypto.randomUUID(), expectedSequence: current.sequence, action,
      }, "access");
      if (response.result?.type === "error") message(response.result.message ?? "当前操作未生效");
    } catch (error) { message(error instanceof Error ? error.message : "操作失败"); }
    finally { pending = false; await refresh(); }
  };
  function draw() {
    const state = current!.view;
    const display = state.party?.display;
    const previousInput = container.querySelector<HTMLInputElement>("[name=gameValue]");
    const inputValue = previousInput?.value;
    const hadFocus = previousInput === document.activeElement;
    container.innerHTML = `<div class="hero"><div><div class="eyebrow">PLAYROOM / OFFICIAL</div><h1>${escape(officialGames.find(game => game.id === state.gameId)?.title ?? display?.title ?? "官方游戏房间")}</h1>
      <p class="muted">${escape(nickname)} · ${state.phase === "lobby" ? "等待开始" : state.phase === "playing" ? "对局进行中" : "本局结束"}</p></div>
      <div class="actions"><button id="room-invite">邀请朋友</button><button id="room-leave">离开房间</button></div></div>
      <div class="two-col"><aside class="panel"><h2>房间成员 ${state.players.length}/${state.maxPlayers}</h2>${state.players.map(player =>
        `<div class="row"><div>${escape(player.name)} ${player.id === state.you ? "· 你" : ""}<small>${player.id === state.hostId ? "房主 · " : ""}${player.connected ? "已连接" : "重连中"}</small></div></div>`).join("")}
        ${state.you === state.hostId && state.phase !== "playing" ? `<button class="primary" id="room-start" ${state.players.length < state.minPlayers ? "disabled" : ""}>${state.phase === "finished" ? "再来一局" : "开始游戏"}</button>` : ""}
      </aside><section class="panel" id="room-board">${state.phase === "lobby" ? `<h2>一起等朋友到齐</h2><p class="muted">每个人先进入测试空间，再使用房间邀请加入。服务器保存权威状态，房主不持有其他人的私密答案。</p>` : ""}</section></div>`;
    container.querySelector("#room-invite")!.addEventListener("click", () => {
      const token = sessionStorage.getItem(storageKey);
      if (!token) { message("本页面没有可分享的邀请凭据，请向房主索取"); return; }
      const url = `${location.origin}${location.pathname}#/room/${roomId}?invite=${encodeURIComponent(token)}`;
      void navigator.clipboard.writeText(url).then(() => message("房间邀请已复制；对方仍需先进入测试空间")).catch(() => prompt("复制房间邀请", url));
    });
    container.querySelector("#room-leave")!.addEventListener("click", () => {
      void api(`/rooms/${roomId}/leave`, "POST", {}, "access").then(() => { active = false; location.hash = "#/games"; }).catch(error => message(error.message));
    });
    container.querySelector("#room-start")?.addEventListener("click", () => void send({ type: "start" }));
    const board = container.querySelector<HTMLElement>("#room-board")!;
    if (display) {
      board.innerHTML = `<span class="badge">${escape(display.progress ?? "")}</span><p>${escape(display.prompt)}</p><p class="muted">${escape(display.subtitle ?? "")}</p>
        ${display.deadline ? `<p data-clock="${display.deadline}" role="timer"></p>` : ""}
        ${display.cards?.map(card => `<span class="badge">${escape(card)}</span>`).join("") ?? ""}
        ${display.notice ? `<div class="notice">${escape(display.notice)}</div>` : ""}
        ${display.rows?.map(row => `<div class="row"><span>${escape(row.label)}</span><strong>${escape(row.value)}</strong></div>`).join("") ?? ""}
        ${display.result ? `<h2>${escape(display.result)}</h2>` : ""}
        <div class="actions" id="room-choices"></div>
        ${display.input ? `<form id="room-input">${`<label>${escape(display.input.label)}<input name="gameValue" type="${display.input.type}" ${display.input.min !== undefined ? `min="${display.input.min}"` : ""} ${display.input.max !== undefined ? `max="${display.input.max}"` : ""} maxlength="${display.input.maxLength ?? 80}" required></label>`}<button class="primary">提交</button></form>` : ""}
        ${display.history?.length ? `<details><summary>本局记录</summary>${display.history.map(line => `<p>${escape(line)}</p>`).join("")}</details>` : ""}`;
      if (state.phase === "playing" && state.party?.playerIds.includes(state.you)) {
        for (const choice of display.choices ?? []) {
          const button = document.createElement("button"); button.textContent = choice.label; button.disabled = !!choice.disabled;
          button.onclick = () => void send({ type: "game", action: { type: choice.id, ...(choice.value !== undefined ? { value: choice.value } : {}) } });
          board.querySelector("#room-choices")!.append(button);
        }
        const form = board.querySelector<HTMLFormElement>("#room-input");
        if (form && display.input) {
          const input = form.querySelector<HTMLInputElement>("input")!;
          if (inputValue !== undefined && hadFocus) { input.value = inputValue; input.focus(); }
          form.onsubmit = event => {
            event.preventDefault();
            void send({ type: "game", action: { type: display.input!.id, value: display.input!.type === "number" ? Number(input.value) : input.value } });
          };
        }
      }
    } else if (state.round) {
      const round = state.round;
      const latest = round.bids.at(-1);
      const name = (id: string) => round.names[id] ?? state.players.find(player => player.id === id)?.name ?? "玩家";
      const playing = state.phase === "playing" && round.playerIds.includes(state.you);
      board.innerHTML = `<h2>吹牛骰子</h2><p>你的骰子：${round.yourDice.map(value => `⚄${value}`).join("　") || "观战中"}</p>
        <p>${latest ? `${escape(name(latest.playerId))} 叫了 ${latest.count} 个 ${latest.face}${latest.mode ? `（${escape(latest.mode)}）` : ""}` : "等待首位玩家叫点"}</p>
        <div id="dice-actions" class="actions"></div>
        ${round.outcome ? `<h3>本局结果：${escape(name(round.outcome.loserId))} 输了</h3><p>${escape(round.outcome.reason)}</p>` : ""}
        ${round.revealedDice ? Object.entries(round.revealedDice).map(([id, dice]) => `<p>${escape(name(id))}：${dice.join(" · ")}</p>`).join("") : ""}
        <details><summary>叫点记录</summary>${round.bids.map(bid => `<p>${escape(name(bid.playerId))}：${bid.count} 个 ${bid.face}</p>`).join("")}</details>`;
      const actions = board.querySelector("#dice-actions")!;
      const add = (label: string, action: ClientAction) => {
        const button = document.createElement("button"); button.textContent = label; button.onclick = () => void send(action); actions.append(button);
      };
      if (playing && round.pendingSlash?.bidderId === state.you) {
        add("接受劈", { type: "respond-slash", counter: false }); add("反劈", { type: "respond-slash", counter: true });
      } else if (playing && !round.pendingSlash) {
        if (round.turnId === state.you) {
          const form = document.createElement("form"); form.className = "stack";
          form.innerHTML = `<label>点数<select name="face">${FACE_ORDER.map(face => `<option value="${face}">${face}</option>`).join("")}</select></label>
            <label>数量<input name="count" type="number" min="1" max="${state.players.length * 7}" value="${minimumBid(FACE_ORDER[0], latest, round.playerIds.length, "normal")}" required></label>
            <label>叫法<select name="mode"><option value="normal">普通 / 飞</option><option value="zhai">斋</option></select></label><button class="primary">叫点</button>`;
          form.onsubmit = event => {
            event.preventDefault(); const values = new FormData(form);
            const selection = { playerId: state.you, face: Number(values.get("face")), count: Number(values.get("count")), mode: String(values.get("mode")) as BidMode };
            if (!validBid(selection.count, selection.face, latest, round.playerIds.length, selection.mode)) { message("当前叫点不符合规则，请增加数量或点数"); return; }
            void send({ type: "bid", count: selection.count, face: selection.face, mode: selection.mode });
          };
          actions.append(form);
          if (latest) add("开骰", { type: "challenge" });
        }
        if (latest && latest.playerId !== state.you) add("劈", { type: "slash" });
      }
    }
  }
  await refresh();
  async function connect() {
    if (!active) return;
    try {
      const grant = await api(`/rooms/${roomId}/connection-tickets`, "POST", {}, "access");
      if (!active) return;
      const url = new URL(grant.path, location.origin); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onopen = () => socket?.send(JSON.stringify({ type: "authenticate", ticket: grant.ticket }));
      socket.onmessage = event => {
        if (!active) return;
        const packet = JSON.parse(event.data);
        if (packet.type === "state") { current = packet.data; draw(); }
        else if (packet.type === "error") { message(packet.message); }
      };
      socket.onclose = () => { if (active) reconnect = setTimeout(() => void connect(), 3000); };
    } catch { if (active) reconnect = setTimeout(() => void connect(), 5000); }
  }
  void connect();
  poll = setInterval(() => { if (socket?.readyState !== WebSocket.OPEN) void refresh(); }, 5000);
  const clock = setInterval(() => {
    container.querySelectorAll<HTMLElement>("[data-clock]").forEach(el => {
      el.textContent = `剩余 ${Math.max(0, Math.ceil((Number(el.dataset.clock) - Date.now()) / 1000))} 秒`;
    });
  }, 250);
  return () => { active = false; if (poll) clearInterval(poll); if (reconnect) clearTimeout(reconnect); socket?.close(); clearInterval(clock); };
}
