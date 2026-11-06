import type { RoomView } from "../../../../../packages/protocol";
import { validBid } from "../../../../../packages/games/liars-dice/rules";
import { avatar, brand, dice, escapeHtml as esc } from "../../ui";

export interface Controls {
  connected: boolean;
  connectionLabel: string;
  pending: boolean;
  count: number;
  face: number;
  peek: boolean;
}

export function roomView(state: RoomView, controls: Controls): string {
  const { round } = state;
  const me = state.players.find(p => p.id === state.you);
  const isHost = state.hostId === state.you;
  const myTurn = state.phase === "playing" && round?.turnId === state.you;
  const inRound = round?.playerIds.includes(state.you);
  const latest = round?.bids.at(-1);
  const disabled = !controls.connected || controls.pending;
  const name = (id: string) => esc(round?.names[id] ?? state.players.find(p => p.id === id)?.name ?? "玩家");
  const allConnected = state.players.every(p => p.connected);
  const canStart = state.players.length >= 2 && allConnected && !disabled;
  const startButton = isHost
    ? `<button class="button primary full" data-action="start" ${canStart ? "" : "disabled"}>${state.phase === "finished" ? "再来一局" : "开始游戏"} <span>→</span></button><p class="micro centered">${state.players.length < 2 ? "至少需要 2 人，邀请一位朋友就能开局" : !allConnected ? "等待所有玩家连接后即可开局" : `${state.players.length} 位玩家已到齐，由你决定何时开始`}</p>`
    : `<div class="waiting-banner">等待房主${state.phase === "finished" ? "发起下一局" : "开始游戏"}<span class="loading-dots">···</span></div>`;

  const seats = state.players.map((p, i) => {
    const playing = state.phase === "playing" && round?.playerIds.includes(p.id);
    const active = playing && round?.turnId === p.id;
    const waiting = state.phase === "playing" && !playing;
    return `<div class="player-seat ${active ? "active" : ""} ${!p.connected ? "offline" : ""}">
      <div class="avatar-wrap">${avatar(p.name, i)}<span class="online-dot ${p.connected ? "on" : ""}"></span></div>
      <div class="player-info"><b>${esc(p.name)}${p.id === state.you ? '<span class="you-tag">你</span>' : ""}</b>
      <span>${!p.connected ? `<span data-deadline="${p.disconnectAt}">等待重连</span>` : active ? "正在叫点…" : waiting ? "等待下一局" : state.phase === "lobby" ? "准备就绪" : "已入座"}</span></div>
      ${p.id === state.hostId ? '<span class="host-tag">房主</span>' : ""}
      ${playing ? '<div class="mini-dice" aria-label="5 颗隐藏骰子">•••••</div>' : ""}
    </div>`;
  }).join("");

  let center = "";
  if (state.phase === "lobby") {
    center = `<div class="lobby-table"><div class="table-art">${dice(3, "table-die first")}${dice(5, "table-die second")}</div>
      <span class="eyebrow">GOOD TIMES START HERE</span><h2>朋友到齐，就开局。</h2><p>你的骰子只有你知道。<br>至于其他人说的，信不信由你。</p>
      <button class="button secondary" data-action="invite">复制邀请链接 <span>↗</span></button>
      <div class="table-chips"><span>2–6 人</span><span>每人 5 颗</span><span>1 点万能</span></div></div>`;
  } else if (state.phase === "finished" && round?.outcome) {
    const outcome = round.outcome;
    const lose = outcome.loserId === state.you;
    const face = outcome.bid?.face;
    center = `<div class="result">
      <span class="eyebrow">ROUND ${String(round.number).padStart(2, "0")} · 揭晓时刻</span>
      <div class="result-symbol">${lose ? "哎呀！" : "开！"}</div>
      <h2>${name(outcome.loserId)} <span class="muted-word">这局输了</span></h2>
      <p class="result-explain">${outcome.reason === "disconnect" ? "离线超过 60 秒，判定弃权。本局结束。" : outcome.reason === "leave" ? "主动离开正在进行的对局，判定弃权。" :
        `${name(outcome.challengerId!)} 开了 ${name(outcome.bid!.playerId)} 的「${outcome.bid!.count} 个 ${face}」<br>实际有 <strong>${outcome.actualCount} 个 ${face}</strong>（包含万能 1 点），${outcome.actualCount! >= outcome.bid!.count ? "叫点成立，开骰者输。" : "叫点不成立，叫点者输。"}`}</p>
      <div class="reveal-list">${round.playerIds.map((id, i) => `<div class="reveal-row ${id === outcome.loserId ? "loser" : ""}">
        <div class="reveal-name">${avatar(round.names[id], i)}<b>${name(id)}</b>${id === outcome.loserId ? '<span class="loser-tag">本局输家</span>' : ""}</div>
        <div class="reveal-dice">${(round.revealedDice?.[id] ?? []).map(v => dice(v, face && (v === face || v === 1) ? "matched" : "")).join("")}</div>
      </div>`).join("")}</div><p class="micro">一局结束，下一局又是新的运气。</p></div>`;
  } else if (round) {
    center = `<div class="live-table">
      <div class="turn-indicator ${myTurn ? "your-turn" : ""}"><span class="pulse-dot"></span>${myTurn ? "轮到你了，大胆一点" : `轮到 ${name(round.turnId)} 叫点`}</div>
      <div class="bid-display">${latest ? `<span class="eyebrow">${name(latest.playerId)} 说，全场至少有</span><div class="big-bid"><strong>${latest.count}</strong><span>个</span>${dice(latest.face)}</div><p>包含万能 <b>1</b> 点 · 你信吗？</p>` : `<div class="opening-mark">?</div><h2>谁先开口，谁先出招。</h2><p>${myTurn ? "从你开始，猜一猜全场的骰子。" : `等 ${name(round.turnId)} 叫出第一个点数。`}</p>`}</div>
      <div class="private-hand"><div class="hand-label"><b>${inRound ? "我的骰子" : "正在旁观"}</b><span>${inRound ? "仅自己可见" : "下一局自动入座"}</span></div>
      ${inRound ? `<button class="hand-toggle ${controls.peek ? "visible" : ""}" data-action="peek" aria-label="${controls.peek ? "隐藏我的骰子" : "查看我的骰子"}">
        <span class="hand-dice">${controls.peek ? round.yourDice.map(v => dice(v)).join("") : Array.from({ length: 5 }, () => '<span class="die hidden-die">?</span>').join("")}</span>
        <span class="hand-hint">${controls.peek ? "点击收起，别让朋友偷看" : "点击查看 · 藏好你的底牌"}</span></button>` : '<p class="spectator-note">这一局已经开始，先看看朋友们的演技。</p>'}</div></div>`;
  }

  const actionPanel = state.phase === "playing" && round ? `<div class="panel action-panel">
    <div class="section-label"><span>你的回合</span><span class="small-pill">${myTurn ? "请出招" : inRound ? "等待中" : "旁观中"}</span></div>
    <h3>${myTurn ? "加码，还是开？" : "先看看局势。"}</h3>
    <label class="field-label" for="bid-count">全场至少有</label>
    <div class="count-stepper"><button data-action="count-down" aria-label="减少数量" ${!myTurn || disabled ? "disabled" : ""}>−</button><input id="bid-count" aria-label="叫点数量" type="number" min="1" max="${round.playerIds.length * 5}" value="${controls.count}" ${!myTurn || disabled ? "disabled" : ""}><button data-action="count-up" aria-label="增加数量" ${!myTurn || disabled ? "disabled" : ""}>+</button><span>个</span></div>
    <div class="face-picker" role="group" aria-label="选择骰子点数">${[2, 3, 4, 5, 6].map(face => `<button data-action="face" data-face="${face}" class="${controls.face === face ? "selected" : ""}" aria-label="${face} 点" aria-pressed="${controls.face === face}" ${!myTurn || disabled ? "disabled" : ""}>${dice(face)}</button>`).join("")}</div>
    <button class="button primary full" data-action="bid" ${!myTurn || disabled || !validBid(controls.count, controls.face, latest, round.playerIds.length * 5) ? "disabled" : ""}>叫 ${controls.count} 个 ${controls.face} <span>↑</span></button>
    <button class="button challenge full" data-action="challenge" ${!myTurn || disabled || !latest ? "disabled" : ""}>不信，开！</button>
    <p class="micro centered">${latest ? `上一手：${latest.count} 个 ${latest.face} · 只能往上叫` : "第一手可以从 1 个 2 开始"}</p>
  </div>` : `<div class="panel action-panel"><span class="eyebrow">${state.phase === "finished" ? "ONE MORE ROUND?" : "READY WHEN YOU ARE"}</span><h3>${state.phase === "finished" ? "不服？再来一局。" : "人齐了，就出发。"}</h3>${startButton}</div>`;

  return `<header class="site-header">${brand.replace('class="brand"', 'class="brand" data-action="leave-prompt"')}<div class="header-right"><button class="text-button" data-action="rules">玩法说明</button><button class="text-button subdued" data-action="leave-prompt">离开房间 ↗</button></div></header>
  <main class="room-page phase-${state.phase}">
    <div class="room-heading"><div><a class="breadcrumb" href="#" data-action="leave-prompt">游戏大厅 /</a><h1>吹牛骰子 <span>${state.phase === "lobby" ? "等待开局" : state.phase === "playing" ? `第 ${round?.number} 局` : "本局结束"}</span></h1></div>
    <div class="room-code-block"><span>房间码</span><button data-action="copy-code" aria-label="复制房间码">${state.code} <span>⧉</span></button></div></div>
    ${!controls.connected ? `<div class="connection-banner" role="alert">${esc(controls.connectionLabel)} <button class="text-button" data-action="rejoin">重新加入</button></div>` : ""}
    <div class="game-layout"><aside class="panel players-panel"><div class="section-label"><span>这桌的朋友</span><b>${state.players.length}<span class="muted"> / 6</span></b></div><div class="seats">${seats}${Array.from({ length: Math.max(0, 6 - state.players.length) }, (_, i) => `<button class="empty-seat" data-action="invite"><span class="empty-avatar">＋</span><span>${i === 0 ? "给朋友留个位置" : "虚位以待"}</span></button>`).join("")}</div><button class="button secondary full" data-action="invite">邀请朋友 <span>↗</span></button></aside>
    <section class="game-table" aria-label="游戏桌">${center}</section>
    <aside class="right-column">${actionPanel}<div class="panel history-panel"><div class="section-label"><span>本局动态</span><span>↙</span></div><div class="history">${round?.bids.length ? [...round.bids].reverse().map((bid, i) => `<div class="history-item"><span class="history-index">${String(round.bids.length - i).padStart(2, "0")}</span><div><b>${name(bid.playerId)}</b><span>叫了 ${bid.count} 个 ${bid.face}</span></div>${i === 0 ? '<span class="latest-label">最新</span>' : ""}</div>`).join("") : '<div class="history-empty">好戏还没开始。<br>每一次叫点都会记录在这里。</div>'}</div></div></aside></div>
    <footer class="room-footer"><span class="connection-status"><i class="${controls.connected ? "on" : ""}"></i>${esc(controls.connectionLabel)}</span><span>1 点万能 · 开骰即结算 · 和朋友尽兴玩</span><span>${esc(me?.name ?? "")}</span></footer>
  </main>`;
}
