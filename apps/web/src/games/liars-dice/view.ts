import type { RoomView } from "../../../../../packages/protocol";
import { bidLabel, effectiveMode, FACE_ORDER, handCount, handLabel, isStraight, isZhai, minimumBid, nextStarter, validBid, type BidMode } from "../../../../../packages/games/liars-dice/rules";
import { avatar, brand, dice, escapeHtml as esc } from "../../ui";

export interface Controls {
  connected: boolean;
  connectionLabel: string;
  pending: boolean;
  count: number;
  face: number;
  mode: BidMode;
  peek: boolean;
}

export function roomView(state: RoomView, controls: Controls): string {
  const { round } = state;
  const me = state.players.find(p => p.id === state.you);
  const isHost = state.hostId === state.you;
  const myTurn = state.phase === "playing" && round?.turnId === state.you && !round.pendingSlash;
  const inRound = round?.playerIds.includes(state.you);
  const latest = round?.bids.at(-1);
  const disabled = !controls.connected || controls.pending;
  const name = (id: string) => esc(round?.names[id] ?? state.players.find(p => p.id === id)?.name ?? "玩家");
  const selection = { playerId: state.you, count: controls.count, face: controls.face, mode: effectiveMode(controls.face, latest, controls.mode) };
  const minimum = minimumBid(controls.face, latest, round?.playerIds.length ?? 2, controls.mode);
  const starter = round?.outcome ? nextStarter(state.players, { ...round, dice: {}, turnIndex: 0 }) : undefined;
  const allConnected = state.players.every(p => p.connected);
  const canStart = state.players.length >= 2 && allConnected && !disabled;
  const startButton = isHost
    ? `<button class="button primary full" data-action="start" ${canStart ? "" : "disabled"}>${state.phase === "finished" ? "再来一局" : "开始游戏"} <span>→</span></button><p class="micro centered">${state.players.length < 2 ? "至少需要 2 人，邀请一位朋友就能开局" : !allConnected ? "等待所有玩家连接后即可开局" : `${state.players.length} 位玩家已到齐，由你决定何时开始`}</p>`
    : `<div class="waiting-banner">等待房主${state.phase === "finished" ? "发起下一局" : "开始游戏"}<span class="loading-dots">···</span></div>`;

  const seats = state.players.map((p, i) => {
    const playing = state.phase === "playing" && round?.playerIds.includes(p.id);
    const active = playing && !round?.pendingSlash && round?.turnId === p.id;
    const waiting = state.phase === "playing" && !playing;
    return `<div class="player-seat ${active ? "active" : ""} ${!p.connected ? "offline" : ""}">
      <div class="avatar-wrap">${avatar(p.name, i)}<span class="online-dot ${p.connected ? "on" : ""}"></span></div>
      <div class="player-info"><b>${esc(p.name)}${p.id === state.you ? '<span class="you-tag">你</span>' : ""}</b>
      <span>${!p.connected ? `<span data-deadline="${p.disconnectAt}">等待重连</span>` : round?.pendingSlash?.bidderId === p.id ? "等待回应劈…" : active ? "正在叫点…" : waiting ? "等待下一局" : state.phase === "lobby" ? "准备就绪" : "已入座"}</span></div>
      ${p.id === state.hostId ? '<span class="host-tag">房主</span>' : ""}
      ${playing ? '<div class="mini-dice" aria-label="5 颗隐藏骰子">•••••</div>' : ""}
    </div>`;
  }).join("");

  let center = "";
  if (state.phase === "lobby") {
    center = `<div class="lobby-table"><div class="table-art">${dice(3, "table-die first")}${dice(5, "table-die second")}</div>
      <span class="eyebrow">GOOD TIMES START HERE</span><h2>朋友到齐，就开局。</h2><p>你的骰子只有你知道。<br>至于其他人说的，信不信由你。</p>
      <button class="button secondary" data-action="invite">复制邀请链接 <span>↗</span></button>
      <div class="table-chips"><span>2–6 人</span><span>顺子计零</span><span>斋 / 飞 / 劈</span></div></div>`;
  } else if (state.phase === "finished" && round?.outcome) {
    const outcome = round.outcome;
    const lose = outcome.loserId === state.you;
    const face = outcome.bid?.face;
    center = `<div class="result">
      <span class="eyebrow">ROUND ${String(round.number).padStart(2, "0")} · 揭晓时刻</span>
      <div class="result-symbol">${lose ? "哎呀！" : "开！"}</div>
      <h2>${name(outcome.loserId)} <span class="muted-word">这局输了</span></h2>
      <p class="result-explain">${outcome.reason === "disconnect" ? "离线超过 60 秒，判定弃权。本局结束。" : outcome.reason === "leave" ? "主动离开正在进行的对局，判定弃权。" :
        `${name(outcome.challengerId!)} ${outcome.multiplier === 4 ? "劈后被反劈" : outcome.multiplier === 2 ? "劈了" : "开了"} ${name(outcome.bid!.playerId)} 的「${bidLabel(outcome.bid!)}」<br>有效计数 <strong>${outcome.actualCount} 个 ${face}</strong>（${isZhai(outcome.bid!) ? "斋：1 不百搭" : "1 点万能"}，顺子计零、围骰加成），${outcome.actualCount! >= outcome.bid!.count ? "叫点成立，开骰者输。" : "叫点不成立，叫点者输。"}`}</p>
      <p class="result-multiplier">本局结算 ×${outcome.multiplier ?? 1}${outcome.multiplier === 4 ? " · 反劈" : outcome.multiplier === 2 ? " · 劈" : ""}</p>
      <div class="reveal-list">${round.playerIds.map((id, i) => {
        const hand = round.revealedDice?.[id] ?? [];
        const contribution = outcome.bid ? handCount(hand, outcome.bid) : undefined;
        return `<div class="reveal-row ${id === outcome.loserId ? "loser" : ""}">
        <div class="reveal-name">${avatar(round.names[id], i)}<b>${name(id)}</b>${id === outcome.loserId ? '<span class="loser-tag">本局输家</span>' : ""}</div>
        <div class="reveal-dice ${isStraight(hand) ? "straight-hand" : ""}">${hand.map(v => dice(v, outcome.bid && !isStraight(hand) && (v === face || (!isZhai(outcome.bid) && v === 1)) ? "matched" : "")).join("")}</div>
        <p class="hand-summary">${handLabel(hand, outcome.bid)}${contribution !== undefined ? ` · 本手贡献 ${contribution} 个 ${face}` : ""}</p>
      </div>`; }).join("")}</div><p class="micro">${starter ? `下一局由 ${name(starter)} 先喊。` : "一局结束，下一局又是新的运气。"}</p></div>`;
  } else if (round) {
    center = `<div class="live-table">
      <div class="turn-indicator ${myTurn ? "your-turn" : ""}"><span class="pulse-dot"></span>${round.pendingSlash ? `等待 ${name(round.pendingSlash.bidderId)} 接受或反劈` : myTurn ? "轮到你了，大胆一点" : `轮到 ${name(round.turnId)} 叫点`}</div>
      <div class="bid-display">${latest ? `<span class="eyebrow">${name(latest.playerId)} 说，全场至少有</span><div class="big-bid"><strong>${latest.count}</strong><span>个</span>${dice(latest.face)}</div><p>${isZhai(latest) ? "斋 · 只算实际点数，1 不百搭" : latest.mode === "fly" ? "飞 · 恢复万能 1 点" : "包含万能 1 点"} · 顺子整手计零</p>` : `<div class="opening-mark">?</div><h2>谁先开口，谁先出招。</h2><p>${myTurn ? "从你开始，猜一猜全场的骰子。" : `等 ${name(round.turnId)} 叫出第一个点数。`}</p>`}</div>
      <div class="private-hand"><div class="hand-label"><b>${inRound ? "我的骰子" : "正在旁观"}</b><span>${inRound ? "仅自己可见" : "下一局自动入座"}</span></div>
      ${inRound ? `<button class="hand-toggle ${controls.peek ? "visible" : ""}" data-action="peek" aria-label="${controls.peek ? "隐藏我的骰子" : "查看我的骰子"}">
        <span class="hand-dice">${controls.peek ? round.yourDice.map(v => dice(v)).join("") : Array.from({ length: 5 }, () => '<span class="die hidden-die">?</span>').join("")}</span>
        <span class="hand-hint">${controls.peek ? `${handLabel(round.yourDice, latest)} · 点击收起` : "点击查看 · 藏好你的底牌"}</span></button>` : '<p class="spectator-note">这一局已经开始，先看看朋友们的演技。</p>'}</div></div>`;
  }

  const actionPanel = state.phase === "playing" && round?.pendingSlash ? `<div class="panel action-panel">
    <span class="eyebrow">劈 · 等待回应</span><h3>${name(round.pendingSlash.challengerId)} 要开这手！</h3>
    <p class="micro">骰子尚未揭晓，其他操作暂时暂停。${name(round.pendingSlash.bidderId)} 选择后立即结算。</p>
    ${round.pendingSlash.bidderId === state.you ? `<button class="button primary full" data-action="accept-slash" ${disabled ? "disabled" : ""}>接受劈 · 开骰 ×2</button><button class="button challenge full" data-action="counter-slash" ${disabled ? "disabled" : ""}>反劈 · 开骰 ×4</button>` : '<p class="waiting-banner">等待叫点者回应…</p>'}
  </div>` : state.phase === "playing" && round ? `<div class="panel action-panel">
    <div class="section-label"><span>你的回合</span><span class="small-pill">${myTurn ? "请出招" : inRound ? "等待中" : "旁观中"}</span></div>
    <h3>${myTurn ? "加码，还是开？" : "先看看局势。"}</h3>
    <label class="field-label" for="bid-count">全场至少有</label>
    <div class="count-stepper"><button data-action="count-down" aria-label="减少数量" ${!myTurn || disabled ? "disabled" : ""}>−</button><input id="bid-count" aria-label="叫点数量" type="number" min="1" max="${round.playerIds.length * 7}" value="${controls.count}" ${!myTurn || disabled ? "disabled" : ""}><button data-action="count-up" aria-label="增加数量" ${!myTurn || disabled ? "disabled" : ""}>+</button><span>个</span></div>
    <div class="face-picker" role="group" aria-label="选择骰子点数">${FACE_ORDER.map(face => `<button data-action="face" data-face="${face}" class="${controls.face === face ? "selected" : ""}" aria-label="${face} 点" aria-pressed="${controls.face === face}" ${!myTurn || disabled ? "disabled" : ""}>${dice(face)}</button>`).join("")}</div>
    <div class="mode-picker" role="group" aria-label="叫点模式">${(["normal", "zhai", "fly"] as BidMode[]).map(mode => `<button class="button secondary ${selection.mode === mode ? "selected" : ""}" data-action="mode" data-mode="${mode}" aria-pressed="${selection.mode === mode}" ${!myTurn || disabled || (mode === "normal" && latest && isZhai(latest)) || (mode === "fly" && (!latest || !isZhai(latest))) ? "disabled" : ""}>${mode === "normal" ? "普通" : mode === "zhai" ? "斋" : "飞"}</button>`).join("")}</div>
    <p class="micro centered mode-help">${controls.mode === "fly" ? "飞：至少翻倍，恢复万能 1；不能叫 1。" : selection.mode === "zhai" ? latest && !isZhai(latest) ? "斋：数量至少减半向上取整，1 不再百搭。" : "斋：只算实际点数，1 不再百搭。" : "普通：1 点万能。"}${minimum === undefined ? "当前点数已无合法叫数，可以开骰。" : ` 当前点数最低叫 ${minimum} 个。`}</p>
    <button class="button primary full" data-action="bid" ${!myTurn || disabled || !validBid(controls.count, controls.face, latest, round.playerIds.length, controls.mode) ? "disabled" : ""}>叫 ${bidLabel(selection)} <span>↑</span></button>
    <button class="button challenge full" data-action="challenge" ${!myTurn || disabled || !latest ? "disabled" : ""}>不信，开！</button>
    <button class="button secondary full slash-button" data-action="slash" ${disabled || !inRound || !latest || latest.playerId === state.you ? "disabled" : ""}>劈 · 跨回合开骰 ×2</button>
    <p class="micro centered">${latest ? `上一手：${bidLabel(latest)} · 点数 2＜3＜4＜5＜6＜1` : `第一手至少叫 ${round.playerIds.length} 个 · 1 最大`}</p>
  </div>` : `<div class="panel action-panel"><span class="eyebrow">${state.phase === "finished" ? "ONE MORE ROUND?" : "READY WHEN YOU ARE"}</span><h3>${state.phase === "finished" ? "不服？再来一局。" : "人齐了，就出发。"}</h3>${startButton}</div>`;

  return `<header class="site-header">${brand.replace('class="brand"', 'class="brand" data-action="leave-prompt"')}<div class="header-right"><button class="text-button" data-action="rules">玩法说明</button><button class="text-button subdued" data-action="leave-prompt">离开房间 ↗</button></div></header>
  <main class="room-page phase-${state.phase}">
    <div class="room-heading"><div><a class="breadcrumb" href="#" data-action="leave-prompt">游戏大厅 /</a><h1>吹牛骰子 <span>${state.phase === "lobby" ? "等待开局" : state.phase === "playing" ? `第 ${round?.number} 局` : "本局结束"}</span></h1></div>
    <div class="room-code-block"><span>房间码</span><button data-action="copy-code" aria-label="复制房间码">${state.code} <span>⧉</span></button></div></div>
    ${!controls.connected ? `<div class="connection-banner" role="alert">${esc(controls.connectionLabel)} <button class="text-button" data-action="rejoin">重新加入</button></div>` : ""}
    <div class="game-layout"><aside class="panel players-panel"><div class="section-label"><span>这桌的朋友</span><b>${state.players.length}<span class="muted"> / 6</span></b></div><div class="seats">${seats}${Array.from({ length: Math.max(0, 6 - state.players.length) }, (_, i) => `<button class="empty-seat" data-action="invite"><span class="empty-avatar">＋</span><span>${i === 0 ? "给朋友留个位置" : "虚位以待"}</span></button>`).join("")}</div><button class="button secondary full" data-action="invite">邀请朋友 <span>↗</span></button></aside>
    <section class="game-table" aria-label="游戏桌">${center}</section>
    <aside class="right-column">${actionPanel}<div class="panel history-panel"><div class="section-label"><span>本局动态</span><span>↙</span></div><div class="history">${round?.bids.length ? [...round.bids].reverse().map((bid, i) => `<div class="history-item"><span class="history-index">${String(round.bids.length - i).padStart(2, "0")}</span><div><b>${name(bid.playerId)}</b><span>叫了 ${bidLabel(bid)}</span></div>${i === 0 ? '<span class="latest-label">最新</span>' : ""}</div>`).join("") : '<div class="history-empty">好戏还没开始。<br>每一次叫点都会记录在这里。</div>'}</div></div></aside></div>
    <footer class="room-footer"><span class="connection-status"><i class="${controls.connected ? "on" : ""}"></i>${esc(controls.connectionLabel)}</span><span>顺子计零 · 输家先喊 · 一人输即结束</span><span>${esc(me?.name ?? "")}</span></footer>
  </main>`;
}
