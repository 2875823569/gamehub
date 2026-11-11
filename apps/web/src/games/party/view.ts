import type { RoomView } from "../../../../../packages/protocol";
import { brand, escapeHtml as esc } from "../../ui";
import { findGame } from "../../platform/catalog";

interface Controls { connected: boolean; connectionLabel: string; pending: boolean }

export function partyRules(id: string): string {
  const game = findGame(id);
  return `<span class="eyebrow">一起玩 · ${esc(game.category)}</span><h2>${esc(game.title)}</h2>
    <p class="modal-description">${esc(game.players)} · ${esc(game.duration)}</p>
    <ol class="party-rules">${game.rules.map(rule => `<li>${esc(rule)}</li>`).join("")}</ol>
    <p class="micro">${game.minPlayers === 1 ? "一个人即可开始，也可以邀请朋友使用各自设备加入。" : "每人使用自己的设备加入同一房间。"}后来加入者等待下一局；断线保留60秒，回合计时继续。</p>`;
}

export function partyRoomView(state: RoomView, controls: Controls): string {
  const game = findGame(state.gameId);
  const display = state.party?.display;
  const active = state.phase === "playing";
  const spectator = active && !state.party?.playerIds.includes(state.you);
  const disabled = !controls.connected || controls.pending || !active || !!spectator;
  const startDisabled = !controls.connected || controls.pending || state.players.length < state.minPlayers || state.players.some(p => !p.connected);
  return `<header class="site-header">${brand}<div class="header-right"><button class="text-button" data-action="rules">游戏规则</button><button class="text-button" data-action="leave-prompt">离开房间 ↗</button></div></header>
    <main class="room-page party-room phase-${state.phase}">
      <div class="room-heading"><div><span class="breadcrumb">游戏大厅 / ${esc(game.category)}</span><h1>${esc(game.icon)} ${esc(game.title)} <span>${state.phase === "lobby" ? game.minPlayers === 1 ? "准备挑战" : "等待朋友" : active ? "正在游戏" : "本局结束"}</span></h1></div>
      <div class="room-code-block"><span>房间码 · 点击复制</span><button data-action="copy-code">${esc(state.code)} <span>⧉</span></button></div></div>
      ${!controls.connected ? `<div class="connection-banner" role="status">${esc(controls.connectionLabel)}<button class="text-button" data-action="rejoin">重新加入</button></div>` : ""}
      <div class="party-layout"><aside class="panel party-players"><div class="section-label">这一桌的朋友 <span>${state.players.length}/${state.maxPlayers}</span></div>
        <div class="party-roster">${state.players.map((player, i) => `<div class="party-player ${player.id === display?.turnId && active ? "current" : ""} ${!player.connected ? "offline" : ""}">
          <span class="avatar color-${i % 6}">${esc([...player.name][0])}</span><div><b>${esc(player.name)}${player.id === state.you ? " · 你" : ""}</b>
          <small>${player.id === state.hostId ? "房主 · " : ""}${player.connected ? active && !state.party?.playerIds.includes(player.id) ? "观战中" : player.id === display?.turnId ? "当前回合" : "已入座" : `<span data-deadline="${player.disconnectAt}">重连中</span>`}</small></div></div>`).join("")}</div>
        <button class="button secondary full" data-action="invite">邀请朋友 ↗</button>
        <button class="button ghost full" data-action="rules">查看玩法</button>
      </aside>
      <section class="party-table" aria-live="polite">
        ${display && state.phase !== "lobby" ? `
          <div class="party-stage"><span class="eyebrow">${esc(display.progress ?? `第 ${state.party!.number} 局`)}</span>${active && display.deadline ? `<span class="party-timer" data-game-deadline="${display.deadline}"></span>` : ""}</div>
          <h2>${esc(display.title)}</h2>${display.subtitle ? `<p class="party-subtitle">${esc(display.subtitle)}</p>` : ""}
          ${spectator ? `<p class="party-notice">你正在观战，下一局就能加入。</p>` : ""}
          ${state.party?.interrupted ? `<div class="party-result">${esc(state.party.interrupted)}</div>` : ""}
          <div class="party-prompt">${esc(display.prompt)}</div>
          ${display.cards?.length ? `<div class="party-cards">${display.cards.map(card => `<div class="playing-card">${esc(card)}</div>`).join("")}</div>` : ""}
          ${display.notice ? `<p class="party-notice">${esc(display.notice)}</p>` : ""}
          ${display.result && !state.party?.interrupted ? `<div class="party-result">${esc(display.result)}</div>` : ""}
          ${display.rows?.length ? `<div class="party-results">${display.rows.map(row => `<div class="party-result-row ${row.highlight ? "highlight" : ""}"><span>${esc(row.label)}</span><strong>${esc(row.value)}</strong></div>`).join("")}</div>` : ""}
          ${active && !spectator ? `<div class="party-choices">${(display.choices ?? []).map(choice => `<button class="button ${choice.id === "skip" ? "secondary" : "primary"}" data-action="game-choice" data-game-action="${esc(choice.id)}" ${choice.value === undefined ? "" : `data-value="${esc(JSON.stringify(choice.value))}"`} ${disabled || choice.disabled ? "disabled" : ""}>${esc(choice.label)}</button>`).join("")}</div>
          ${display.input ? `<form id="game-form" class="party-input" data-game-action="${esc(display.input.id)}" data-context="${esc(JSON.stringify([state.party?.number, display.progress, display.prompt, display.turnId, display.input.id]))}"><label for="game-value">${esc(display.input.label)}</label><div><input id="game-value" name="value" type="${display.input.type}" ${display.input.type === "number" ? 'inputmode="numeric" step="1"' : ""} ${display.input.min !== undefined ? `min="${display.input.min}"` : ""} ${display.input.max !== undefined ? `max="${display.input.max}"` : ""} maxlength="${display.input.maxLength ?? 80}" placeholder="${esc(display.input.placeholder ?? "")}" required ${disabled ? "disabled" : ""}><button class="button primary" type="submit" ${disabled ? "disabled" : ""}>提交 →</button></div></form>` : ""}` : ""}
          ${!active ? `<div class="party-rematch">${state.you === state.hostId ? `<button class="button primary" data-action="start" ${startDisabled ? "disabled" : ""}>再来一局 ↗</button>` : '<p class="party-notice">等待房主开启下一局</p>'}</div>` : ""}
          ${display.history?.length ? `<details class="party-history"><summary>本局记录 · ${display.history.length}</summary><ol>${display.history.map(line => `<li>${esc(line)}</li>`).join("")}</ol></details>` : ""}
        ` : `<div class="party-waiting"><div class="party-symbol">${esc(game.icon)}</div><span class="eyebrow">${game.minPlayers === 1 ? "独自解谜，或一起通关" : "朋友到齐，快乐开场"}</span><h2>这局，玩${esc(game.title)}。</h2><p>${esc(game.subtitle)}</p><div class="party-chips"><span>${esc(game.players)}</span><span>${esc(game.duration)}</span><span>${game.minPlayers === 1 ? "单人 / 多人合作" : "实时联机"}</span></div>
          ${state.you === state.hostId ? `<button class="button primary" data-action="start" ${startDisabled ? "disabled" : ""}>${state.players.length < state.minPlayers ? `还差 ${state.minPlayers - state.players.length} 位朋友` : game.minPlayers === 1 ? state.players.length === 1 ? "单人开始挑战 ↗" : "全员准备，合作拆弹 ↗" : "人齐了，开始游戏 ↗"}</button>` : '<p class="party-notice">等房主开始，准备好你的下一步。</p>'}
          <button class="button secondary" data-action="invite">分享房间链接</button></div>
          <div class="party-quick-rules"><h3>一分钟上手</h3><ol>${game.rules.slice(0, 4).map(rule => `<li>${esc(rule)}</li>`).join("")}</ol></div>`}
      </section></div>
      <footer class="room-footer"><span class="connection-status"><i class="${controls.connected ? "on" : ""}"></i>${esc(controls.connectionLabel)}</span><span>每个人一块屏幕，同一桌快乐。</span></footer>
    </main>`;
}
