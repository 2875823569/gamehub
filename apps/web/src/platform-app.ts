import "./platform-app.css";
import { api, list, session, restoreSession, clearSession, PlatformError, type JsonRow } from "./platform-client";
import { connectGameFrame, type GameBridge } from "../../../packages/game-sdk/host";
import { openOfficialRoom } from "./platform-room";
import { renderCreatorTools } from "./platform-creator-tools";
import { renderAdminTools } from "./platform-admin-tools";
import { renderAccountTools } from "./platform-account-tools";
import { bindPromptDraft } from "./platform-draft";
import { renderProfileTools, renderAuthorPage } from "./platform-profile-tools";
import { avatarEmoji } from "../../../packages/contracts/profile";

const root = document.querySelector<HTMLDivElement>("#platform")!;
let renderVersion = 0;
let bridge: GameBridge | undefined;
let playTimer: ReturnType<typeof setInterval> | undefined;
let closeRoom: (() => void) | undefined;
let closeDraft: (() => void) | undefined;
const html = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const date = (value: unknown) => value ? new Date(String(value)).toLocaleString("zh-CN") : "";
const toast = (message: string) => {
  const el = document.querySelector<HTMLElement>("#platform-toast")!;
  el.textContent = message; el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 4500);
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请稍后重试";
function button(label: string, action: () => Promise<unknown>, className = "") {
  const el = document.createElement("button"); el.textContent = label; el.className = className;
  el.onclick = async () => {
    el.disabled = true;
    try { await action(); } catch (error) { toast(errorMessage(error)); } finally { el.disabled = false; }
  };
  return el;
}
function bindForm(id: string, action: (values: FormData) => Promise<unknown>) {
  const form = document.getElementById(id) as HTMLFormElement;
  form.onsubmit = async event => {
    event.preventDefault();
    const values = new FormData(form), controls = form.querySelector("fieldset")!;
    const error = form.querySelector<HTMLElement>(".error");
    if (error) error.textContent = "";
    controls.disabled = true;
    try { await action(values); }
    catch (failure) { if (error) error.textContent = errorMessage(failure); else toast(errorMessage(failure)); }
    finally { controls.disabled = false; }
  };
}
function form(id: string, fields: string, submit: string) {
  return `<form id="${id}"><fieldset>${fields}<p class="error" role="alert"></p><button class="primary">${submit}</button></fieldset></form>`;
}
const field = (name: string, label: string, type = "text", value = "") =>
  `<label>${label}<input name="${name}" type="${type}" value="${html(value)}" required autocomplete="${type === "tel" ? "tel" : "off"}"></label>`;
const area = (name: string, label: string, value = "") => `<label>${label}<textarea name="${name}" required>${html(value)}</textarea></label>`;
async function waitForArtifact(jobId: string) {
  for (let i = 0; i < 30; i++) {
    const result = await api(`/creator/artifact-jobs/${jobId}`);
    if (result.status === "succeeded") return result;
    if (["failed", "expired"].includes(result.status)) throw new Error(result.failureReason ?? "文件任务失败或已过期");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("检查仍在排队，可稍后重试查询；刷新不会丢失已上传的文件。");
}
function rowsMarkup(rows: JsonRow[], render: (row: JsonRow) => string, empty: string) {
  return rows.length ? `<div class="rows">${rows.map(render).join("")}</div>` : `<div class="empty">${empty}</div>`;
}
function heading(title: string, description: string) {
  return `<div class="hero"><div><div class="eyebrow">PLAYROOM / INTERNAL</div><h1>${title}</h1><p class="muted">${description}</p></div><span class="badge">受邀内测 · 测试点数</span></div>`;
}
function shell() {
  const current = location.hash.split("/")[1] || "games";
  root.innerHTML = `<header class="top"><a class="brand" href="#/games">玩伴<small>PLAYROOM</small></a><nav class="nav" aria-label="主导航">
    ${[["games", "游戏大厅"], ["creator", "创作中心"], ["wallet", "测试点数"], ["feedback", "问题反馈"], ["account", "我的账号"], ["admin", "管理后台"]]
      .map(([key, label]) => `<a href="#/${key}" class="${current === key ? "active" : ""}">${label}</a>`).join("")}
    </nav><span class="small muted">${session.user ? avatarEmoji(session.user.avatarKey) : ""} ${html(session.user?.nickname ?? session.guest?.nickname ?? "测试访客")}</span></header>
    <main class="shell" id="content"><div class="loading">正在加载…</div></main>`;
}
function needAccount() {
  if (session.user) return false;
  document.getElementById("content")!.innerHTML = heading("登录后继续", "创作、评论和测试点数需要独立的站内账号。") + `<section class="panel" id="login-slot"></section>`;
  loginForm(document.getElementById("login-slot")!, "login");
  return true;
}
function loginForm(container: HTMLElement, purpose: "login" | "admin") {
  container.innerHTML = `<h2>${purpose === "admin" ? "后台独立登录" : "手机号登录"}</h2>
    <p class="muted">当前使用受邀号码测试通道，请向测试组织者获取本次验证码。</p>
    ${form("sms-form", field("phone", "手机号", "tel"), "获取验证码")}
    <div id="code-slot"></div>`;
  bindForm("sms-form", async values => {
    const challenge = await api("/auth/sms-challenges", "POST", { phone: String(values.get("phone")), purpose }, "access");
    const slot = document.getElementById("code-slot")!;
    slot.innerHTML = `<div class="notice">验证码已生成，本次验证编号：<span class="code">${html(challenge.challengeId ?? challenge.id)}</span></div>` +
      form("login-form", field("code", "六位验证码") + `<label class="check"><input name="terms" type="checkbox" required>我同意内测协议，仅使用测试点数，非真实付费权益。</label>`, "验证并登录");
    bindForm("login-form", async codeValues => {
      const data = await api("/auth/sessions", "POST", {
        challengeId: challenge.challengeId ?? challenge.id, code: String(codeValues.get("code")),
        acceptTerms: codeValues.get("terms") === "on", termsVersion: "internal-v1",
      }, "access");
      if (data.kind === "admin") { session.admin = data.user; session.adminCsrf = data.csrfToken; }
      else { session.user = data.user; session.userCsrf = data.csrfToken; }
      toast("登录成功"); await render();
    });
  });
}
async function showGate() {
  clearSession();
  root.innerHTML = `<main class="gate"><div class="eyebrow">PLAYROOM / INVITATION</div><h1>一起玩，也一起创造。</h1>
    <p>这是玩伴的受邀内测空间。输入测试邀请进入；游玩无需注册账号。</p><section class="panel">
    ${form("invite-form", area("invitation", "测试邀请"), "进入内测")}</section>
    <p class="footer">测试邀请用于进入平台，房间邀请用于加入一局游戏，两者不能互相替代。</p></main>`;
  bindForm("invite-form", async values => {
    const access = await api("/test-access/exchanges", "POST", { invitation: String(values.get("invitation")).trim() }, "access");
    session.accessCsrf = access.csrfToken;
    await restoreSession(); await render();
  });
}
async function gamesPage() {
  const data = await api("/games");
  let games = list(data), cursor = data.nextCursor as string | null, operation = 0;
  document.getElementById("content")!.innerHTML = heading("发现下一场快乐", "官方玩法与创作者作品，在这里相遇。") +
    `<div class="toolbar"><input id="game-search" aria-label="搜索游戏" placeholder="搜索游戏名称"><select id="game-category" aria-label="游戏分类"><option value="">全部分类</option><option>行酒令</option><option>其他</option></select><span class="muted" id="game-count"></span></div><div class="grid" id="game-grid"></div><div class="actions" id="catalog-more"></div>`;
  const search = document.getElementById("game-search") as HTMLInputElement;
  const category = document.getElementById("game-category") as HTMLSelectElement;
  const grid = document.getElementById("game-grid")!, count = document.getElementById("game-count")!;
  const more = button("加载更多", async () => load(false));
  document.getElementById("catalog-more")!.append(more);
  const draw = () => {
    grid.innerHTML = games.map(game => `<article class="card">
      <div><span class="badge">${game.official_key || game.officialKey ? "官方" : "创作者作品"}</span><span class="badge">${html(game.category)}</span><span class="badge">${game.manifest?.mode === "single" ? "单人" : "多人"}</span></div>
      <h2>${html(game.title)}</h2><p>${html(game.description ?? game.subtitle ?? "打开详情，了解玩法与支持设备。")}</p>
      <div class="actions"><a href="#/game/${html(game.id)}">查看详情 →</a></div></article>`).join("") || `<p class="empty">没有符合条件的游戏</p>`;
    count.textContent = `已加载 ${games.length} 款游戏`; more.hidden = !cursor;
  };
  async function load(reset: boolean) {
    const active = ++operation;
    const query = new URLSearchParams({ q: search.value.trim(), limit: "20" });
    if (category.value) query.set("category", category.value);
    if (!reset && cursor) query.set("cursor", cursor);
    count.textContent = "正在查找…";
    try {
      const next = await api(`/games?${query}`);
      if (active !== operation) return;
      games = reset ? list(next) : [...games, ...list(next)]; cursor = next.nextCursor; draw();
    } catch (error) { if (active === operation) count.textContent = errorMessage(error); }
  }
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => { if (searchTimer) clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (grid.isConnected) void load(true); }, 300); });
  category.addEventListener("change", () => void load(true)); draw();
}
async function gamePage(id: string) {
  const game = await api(`/games/${id}`);
  document.getElementById("content")!.innerHTML = heading(html(game.title), html(game.description ?? "")) +
    `<section class="panel"><h2>玩法说明</h2><p>${html(game.instructions ?? game.manifest?.instructions ?? "请在游戏中查看操作说明。")}</p>${game.owner_id ? `<p><a href="#/author/${html(game.owner_id)}">查看作者与更多作品</a></p>` : ""}<div class="actions" id="play-actions"></div></section>
    <section class="panel"><h2>玩家交流</h2><div id="social-actions" class="actions"></div><div id="comments"></div></section>`;
  const actions = document.getElementById("play-actions")!;
  actions.append(button("开始游戏", async () => {
    if (!session.guest) {
      const nickname = session.user?.nickname ?? await nicknameDialog();
      if (!nickname) return;
      session.guest = await api("/guest-sessions", "POST", { nickname }, "access");
    }
    if (game.official_key || game.officialKey || game.source === "official") {
      const room = await api("/rooms", "POST", { gameId: id }, "access");
      sessionStorage.setItem(`gamehub-room-invite:${room.roomId}`, room.inviteToken);
      location.hash = `#/room/${room.roomId}`; return;
    }
    const play = await api(`/games/${id}/play-sessions`, "POST", {}, session.user ? "user" : "access");
    await showPlay(play);
  }, "primary"));
  if (session.user) {
    document.getElementById("social-actions")!.append(
      button("点赞", async () => { await api(`/games/${id}/like`, "PUT"); toast("已点赞"); }),
      button("收藏", async () => { await api(`/games/${id}/favorite`, "PUT"); toast("已收藏"); }),
      button("取消点赞", async () => { await api(`/games/${id}/like`, "DELETE"); toast("已取消点赞"); }),
      button("取消收藏", async () => { await api(`/games/${id}/favorite`, "DELETE"); toast("已取消收藏"); }),
      button("举报作品", async () => {
        const reason = prompt("请说明举报原因"); if (!reason) return;
        const report = await api("/reports", "POST", { objectType: "game", objectId: id, reason });
        toast(`举报已受理：${report.id}`);
      }),
    );
  }
  try {
    const comments = list(await api(`/games/${id}/comments`));
    document.getElementById("comments")!.innerHTML = rowsMarkup(comments, row =>
      `<div class="row"><div><strong>${html(row.nickname ?? "玩家")}${row.parent_id ? " · 回复" : ""}</strong><p>${row.status === "deleted" ? "评论已删除" : html(row.content)}</p><small>${date(row.created_at)}</small><div class="actions" data-comment="${html(row.id)}"></div></div></div>`, "暂无评论") +
      (session.user ? form("comment-form", area("content", "分享你的体验"), "发表评论") : `<p class="muted">登录后可评论、点赞和收藏。</p>`);
    if (session.user) bindForm("comment-form", async values => {
      await api(`/games/${id}/comments`, "POST", { content: String(values.get("content")) }); await render();
    });
    if (session.user) for (const comment of comments) {
      const slot = document.querySelector(`[data-comment="${comment.id}"]`)!;
      if (!comment.parent_id) slot.append(button("回复", async () => {
        const content = prompt("回复这条评论"); if (!content) return;
        await api(`/comments/${comment.id}/replies`, "POST", { content }); await render();
      }));
      if (comment.user_id === session.user.id && comment.status !== "deleted") slot.append(button("删除本人评论", async () => {
        await api(`/comments/${comment.id}`, "DELETE"); await render();
      }));
      if (comment.status === "visible") slot.append(button("举报评论", async () => {
        const reason = prompt("请说明举报原因"); if (!reason) return;
        const report = await api("/reports", "POST", { objectType: "comment", objectId: comment.id, reason });
        toast(`举报已受理：${report.id}`);
      }));
    }
  } catch (error) { document.getElementById("comments")!.textContent = errorMessage(error); }
}
function nicknameDialog(): Promise<string | null> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `<h2>怎么称呼你？</h2>${form("nickname-form", field("nickname", "游客昵称"), "确定")}`;
    document.body.append(dialog);
    dialog.addEventListener("cancel", () => { dialog.remove(); resolve(null); });
    bindForm("nickname-form", async values => { dialog.close(); dialog.remove(); resolve(String(values.get("nickname"))); });
    dialog.showModal();
  });
}
async function showPlay(play: JsonRow) {
  bridge?.close(); if (playTimer) clearInterval(playTimer);
  const sessionId = play.sessionId ?? play.id;
  sessionStorage.setItem("gamehub-feedback-context", JSON.stringify({ playSessionId: sessionId }));
  const settings = await api("/platform/config");
  const origin = String(settings.gameOrigin);
  if (!origin) throw new Error("游戏资源站点尚未配置，请联系测试管理员");
  const resourceUrl = `${origin}/play/${encodeURIComponent(sessionId)}/${encodeURIComponent(play.resourceToken)}/${play.entry}`;
  document.getElementById("content")!.innerHTML = heading("正在游玩", "你的账号信息不会交给游戏。") +
    `<p id="play-status" role="status">正在加载游戏…</p><iframe class="frame" id="game-frame" title="游戏画面" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    <div class="actions" id="game-exit"></div>`;
  const frame = document.getElementById("game-frame") as HTMLIFrameElement;
  const localKey = `gamehub-save:${play.gameId}:${play.manifest?.saveSchemaVersion ?? 1}`;
  bridge = connectGameFrame(frame, {
    context: { gameId: play.gameId, versionId: play.versionId, nickname: session.user?.nickname ?? session.guest?.nickname },
    loadProgress: async () => {
      if (session.user) {
        const saved = await api(`/play-sessions/${sessionId}/save`);
        if (saved.otherSchemaVersions?.length) toast("旧结构存档已保留，当前版本从新进度开始");
        return saved as { data: unknown; revision: number };
      }
      return JSON.parse(localStorage.getItem(localKey) ?? '{"data":null,"revision":0}');
    },
    saveProgress: async (data, expectedRevision) => {
      if (session.user) return api(`/play-sessions/${sessionId}/save`, "PUT", { data, expectedRevision });
      const prior = JSON.parse(localStorage.getItem(localKey) ?? '{"revision":0}');
      if (prior.revision !== expectedRevision) throw new Error("存档冲突");
      const next = { data, revision: expectedRevision + 1 };
      if (new TextEncoder().encode(JSON.stringify(next)).length > 100 * 1024) throw new Error("存档超限");
      localStorage.setItem(localKey, JSON.stringify(next)); return next;
    },
    onReady: () => { const el = document.getElementById("play-status"); if (el) el.textContent = "游戏已就绪"; },
    onError: message => { const el = document.getElementById("play-status"); if (el) el.textContent = message; },
  });
  frame.src = resourceUrl;
  document.getElementById("game-exit")!.append(button("退出游戏", async () => { bridge?.close(); bridge = undefined; await render(); }));
  if (session.user && localStorage.getItem(localKey)) {
    document.getElementById("game-exit")!.append(button("导入本机游客存档", async () => {
      if (!confirm("将此设备的游客进度导入账号？如果云端已有进度，本次导入会被拒绝。")) return;
      const local = JSON.parse(localStorage.getItem(localKey)!);
      const remote = await api(`/play-sessions/${sessionId}/save`);
      await api(`/play-sessions/${sessionId}/save-imports`, "POST", { data: local.data, expectedRevision: remote.revision, confirmed: true });
      toast("游客进度已导入，请重新进入游戏读取");
    }));
  }
  if (play.manifest?.permissions?.includes("save")) document.getElementById("game-exit")!.append(button("重置当前进度", async () => {
    if (!confirm("确认清空当前游戏、当前存档结构的进度？其他结构的旧存档仍会保留。")) return;
    if (session.user) {
      const remote = await api(`/play-sessions/${sessionId}/save`);
      await api(`/play-sessions/${sessionId}/save`, "DELETE", { expectedRevision: remote.revision, confirmed: true });
    } else {
      const prior = JSON.parse(localStorage.getItem(localKey) ?? '{"revision":0}');
      localStorage.setItem(localKey, JSON.stringify({ data: null, revision: prior.revision + 1 }));
    }
    bridge?.close(); bridge = undefined; await render(); toast("进度已重置");
  }));
  // Revalidate even when the child no longer requests assets. Never trust a child-reported permission.
  playTimer = setInterval(() => {
    void api(`/play-sessions/${sessionId}`, "GET").catch(() => {
      bridge?.lifecycle("revoked"); bridge?.close(); bridge = undefined;
      if (playTimer) clearInterval(playTimer);
      const status = document.getElementById("play-status"); if (status) status.textContent = "运行授权已失效，请返回大厅重新选择游戏。";
    });
  }, 3000);
}
async function creatorPage() {
  if (needAccount()) return;
  const games = list(await api("/creator/games"));
  document.getElementById("content")!.innerHTML = heading("把想法变成游戏", "上传网页作品，或通过模拟创作流程验证版本、审核与发布。") +
    `<div class="two-col"><section class="panel"><h2>新建作品</h2>${form("create-game", field("title", "游戏名称") + area("description", "游戏简介"), "创建草稿")}</section>
    <section class="panel"><h2>创作流程</h2><p>创建作品 → 上传或生成 → 预览 → 送审 → 发布</p><p class="muted">AI 当前为明确标记的模拟提供方。真实模型与不可信服务端代码执行尚未开放。</p></section></div>
    <div class="grid">${games.map(game => `<article class="card"><h2>${html(game.title)}</h2><p>${html(game.status ?? "草稿")}</p><a href="#/project/${game.id}">打开工作台 →</a></article>`).join("")}</div>`;
  bindForm("create-game", async values => {
    const result = await api("/creator/games", "POST", { title: String(values.get("title")), description: String(values.get("description")) }, "user", crypto.randomUUID());
    location.hash = `#/project/${result.game?.id ?? result.id}`;
  });
}
async function projectPage(id: string) {
  if (needAccount()) return;
  const games = list(await api("/creator/games"));
  const game = games.find(item => item.id === id) ?? { id, title: "作品工作台" };
  const versions = list(await api(`/creator/games/${id}/versions`));
  const projectId = game.projectId ?? game.project_id;
  const workspace = projectId ? await api(`/creator/projects/${projectId}/workspace`) : null;
  const canModify = !!versions.find(version => version.id === workspace?.baseVersionId)?.manifest?.editable;
  document.getElementById("content")!.innerHTML = heading(html(game.title), "每次修改保留独立版本；审核与发布不会覆盖历史。") +
    `<div class="two-col"><section class="panel"><h2>上传网页游戏</h2><p class="muted">ZIP 需包含 game.json 和 dist/。当前只支持受限静态包，不执行构建脚本。</p>
    ${form("upload-form", `<label>ZIP 游戏包<input name="file" type="file" accept=".zip" required></label>`, "上传并检查")}</section>
    <section class="panel"><h2>模拟 AI 创作</h2>${form("quote-form", `<label>创作方式<select name="mode"><option value="create">生成新的候选版本</option><option value="modify" ${canModify ? "" : "disabled"}>修改已选择的可编辑基线</option></select></label>${canModify ? "" : '<p class="muted">选择包含受支持源码的版本作为工作基线后，才可使用修改流程。</p>'}` + area("prompt", "描述本轮希望生成或修改的内容"), "获取测试报价")}<div id="quote-result"></div></section></div>
    <section class="panel"><h2>版本记录</h2><div id="version-list"></div></section><section class="panel"><h2>创作任务</h2><div id="task-list"></div></section><div id="creator-tools"></div>`;
  const versionList = document.getElementById("version-list")!;
  if (!versions.length) versionList.innerHTML = `<p class="empty">还没有版本，先上传一个静态包或完成模拟创作。</p>`;
  for (const version of versions) {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `<div><strong>版本 ${html(version.number ?? version.version_number)}</strong><small>${html(version.review_status ?? version.reviewStatus)} · ${html(version.check_status ?? version.checkStatus)}</small></div>`;
    const actions = document.createElement("div"); actions.className = "actions";
    actions.append(
      button("预览", async () => showPlay(await api(`/creator/versions/${version.id}/preview-sessions`, "POST", {}))),
      button("送审", async () => { await api(`/creator/versions/${version.id}/submissions`, "POST", { publishOnApproval: true }, "user", crypto.randomUUID()); toast("已提交审核"); await render(); }),
      button("导出", async () => {
        const job = await api(`/creator/versions/${version.id}/exports`, "POST", {}, "user", crypto.randomUUID());
        await waitForArtifact(job.id ?? job.jobId);
        const grant = await api(`/creator/artifact-jobs/${job.id ?? job.jobId}/download-grants`, "POST", {});
        const response = await fetch(grant.downloadUrl, { credentials: "same-origin", headers: { "X-Download-Token": grant.token } });
        if (!response.ok) throw new Error("下载授权已失效，请重新导出");
        const url = URL.createObjectURL(await response.blob()), anchor = document.createElement("a");
        anchor.href = url; anchor.download = `game-${version.id}.zip`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
    row.append(actions); versionList.append(row);
  }
  bindForm("upload-form", async values => {
    const file = values.get("file") as File;
    if (!file || file.size > 100 * 1024 * 1024) throw new Error("请选择不超过 100 MiB 的 ZIP");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    const upload = await api("/creator/uploads", "POST", { purpose: "game-package", size: file.size, sha256 });
    const target = upload.uploadUrl ?? `/api/v1/creator/uploads/${upload.id}/content`;
    const result = await fetch(target, { method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": session.userCsrf }, body: bytes });
    if (!result.ok) throw new Error((await result.json()).error?.message ?? "文件上传失败");
    const scan = await api(`/creator/uploads/${upload.id}/complete`, "POST", {});
    toast("文件已上传，正在检查…");
    await waitForArtifact(scan.jobId ?? scan.id);
    await api(`/creator/games/${id}/versions`, "POST", { uploadId: upload.id }, "user", crypto.randomUUID());
    toast("上传检查完成，已创建版本"); await render();
  });
  const promptDraft = projectId && workspace ? bindPromptDraft(document.getElementById("quote-form") as HTMLFormElement, id, projectId, workspace) : undefined;
  closeDraft = () => promptDraft?.close();
  bindForm("quote-form", async values => {
    await promptDraft?.flush();
    const projectId = game.projectId ?? game.project_id;
    const workspace = projectId ? await api(`/creator/projects/${projectId}/workspace`) : null;
    const quote = await api("/ai/quotes", "POST", {
      gameId: id, workspaceRevision: workspace?.workspaceRevision ?? game.workspace_revision ?? 0,
      prompt: String(values.get("prompt")), mode: String(values.get("mode")),
    }, "user", crypto.randomUUID());
    const slot = document.getElementById("quote-result")!;
    slot.innerHTML = `<div class="notice">本轮固定消耗 ${html(quote.points ?? quote.price ?? quote.costPoints)} 测试点数。当前提供方为模拟模式，不代表真实 AI 质量。</div>`;
    slot.append(button("确认报价并开始", async () => {
      await api("/ai/tasks", "POST", { quoteId: quote.id ?? quote.quoteId }, "user", crypto.randomUUID());
      toast("任务已排队"); await render();
    }, "primary"));
  });
  try {
    const tasks = list(await api("/ai/tasks"));
    document.getElementById("task-list")!.innerHTML = rowsMarkup(tasks, task =>
      `<div class="row"><div><strong>${html(task.state ?? task.status)}</strong><small>${html(task.id)}</small></div><div class="actions" data-task="${html(task.id)}"></div></div>`, "暂无创作任务");
    for (const task of tasks) {
      const slot = document.querySelector(`[data-task="${task.id}"]`)!;
      if (task.status === "queued") slot.append(button("取消任务", async () => { await api(`/ai/tasks/${task.id}/cancel`, "POST"); await render(); }));
      if (task.status === "succeeded") slot.append(button("质量反馈", async () => {
        const description = prompt("请详细描述产物与本轮需求不符的地方（至少10字）"); if (!description) return;
        const result = await api(`/ai/tasks/${task.id}/quality-cases`, "POST", { description }); toast(`质量问题已受理：${result.id}`);
      }));
    }
    document.getElementById("task-list")!.append(button("刷新任务与版本", render));
  } catch (error) { document.getElementById("task-list")!.textContent = errorMessage(error); }
  await renderCreatorTools(document.getElementById("creator-tools")!, game, render);
}
async function walletPage() {
  if (needAccount()) return;
  const [wallet, ledger, products] = await Promise.all([api("/wallet"), api("/wallet/transactions"), api("/billing/products")]);
  document.getElementById("content")!.innerHTML = heading("测试点数", "这里的余额与订单用于验证流程，不产生真实收款或付费权益。") +
    `<div class="two-col"><section class="panel"><p class="muted">可用测试点数</p><p class="balance">${html(wallet.available ?? wallet.availablePoints ?? 0)}</p>
    <p>冻结：${html(wallet.frozen ?? wallet.frozenPoints ?? 0)}</p></section><section class="panel"><h2>测试商品</h2><div id="products"></div></section></div>
    <section class="panel"><h2>流水记录</h2>${rowsMarkup(list(ledger), row => `<div class="row"><div><strong>${html(row.kind ?? row.type ?? row.action)}</strong><small>${date(row.created_at)}</small></div><span>${html(row.amount ?? row.points)}</span></div>`, "暂无流水")}</section><section class="panel"><h2>我的测试订单</h2><div id="my-orders"></div></section>`;
  for (const product of list(products)) {
    document.getElementById("products")!.append(button(`${product.title ?? product.id} · 创建测试订单`, async () => {
      const order = await api("/billing/orders", "POST", { productId: product.id, ruleVersion: product.ruleVersion ?? "mock-v1", channel: "mock" }, "user", crypto.randomUUID());
      toast(`测试订单已创建：${order.id}，由测试管理员确认，不进行真实支付。`);
    }));
  }
  const orders = list(await api("/billing/orders"));
  const slot = document.getElementById("my-orders")!;
  if (!orders.length) slot.textContent = "暂无测试订单";
  for (const order of orders) {
    const row = document.createElement("div"); row.className = "row";
    row.innerHTML = `<div>${html(order.id)}<small>${html(order.state ?? order.status)}</small></div>`;
    if (order.status === "paid" || order.state === "paid") row.append(button("申请测试退款", async () => {
      const reason = prompt("请填写退款原因；当前仅支持未使用测试点数的整单退款"); if (!reason) return;
      await api(`/billing/orders/${order.id}/refund-requests`, "POST", { reason }, "user", crypto.randomUUID()); toast("退款申请已提交");
    }));
    slot.append(row);
  }
}
async function feedbackPage() {
  const feedback = list(await api("/test-feedback").catch(() => []));
  const context = JSON.parse(sessionStorage.getItem("gamehub-feedback-context") ?? "{}");
  document.getElementById("content")!.innerHTML = heading("一起把体验做好", "描述你遇到的问题；反馈仅对有权限的处理人员可见。") +
    `<div class="two-col"><section class="panel"><h2>提交问题</h2>${form("feedback-form",
      area("expected", "期望表现") + area("actual", "实际现象") +
      `<label>附件（可选，最多3份PNG、JPEG或文本，每份5 MiB）<input name="attachments" type="file" multiple accept="image/png,image/jpeg,text/plain"></label>
      ${Object.keys(context).length ? '<label class="check"><input name="context" type="checkbox">关联最近游玩的固定版本或房间</label>' : ""}
      <label class="check"><input name="diagnostics" type="checkbox">附带平台版本及桌面/手机类型，不含凭据和玩家数据</label>`, "提交反馈")}</section>
    <section class="panel"><h2>我的反馈</h2>${rowsMarkup(feedback, row => `<div class="row"><div><strong>${html(row.actual)}</strong><small>${html(row.state ?? row.status)} · ${html(row.id)}</small><p>${html(row.resolution ?? "")}</p><div class="actions" data-feedback="${html(row.id)}"></div></div></div>`, "暂无反馈")}</section></div>`;
  bindForm("feedback-form", async values => {
    const files = values.getAll("attachments").filter((file): file is File => file instanceof File && file.size > 0);
    if (files.length > 3) throw new Error("每次最多附带3个文件");
    const attachmentIds: string[] = [];
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "text/plain"].includes(file.type)) throw new Error("附件类型或大小不符合要求");
      const bytes = await file.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const upload = await api("/test-feedback/uploads", "POST", { mime: file.type, size: file.size, sha256 }, "access");
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("读取附件失败")); reader.readAsDataURL(file);
      });
      const scan = await api(`/test-feedback/uploads/${upload.id}/complete`, "POST", { base64 }, "access");
      if (scan.status !== "passed") throw new Error("附件内容检查未通过");
      attachmentIds.push(upload.id);
    }
    const result = await api("/test-feedback", "POST", {
      expected: String(values.get("expected")), actual: String(values.get("actual")),
      attachmentIds, ...(values.get("context") === "on" ? context : {}),
      ...(values.get("diagnostics") === "on" ? { diagnostics: { platformVersion: "internal-0.2", clientKind: innerWidth < 600 ? "mobile" : "desktop" } } : {}),
    }, "access", crypto.randomUUID());
    toast(`反馈已提交：${result.id}`); await render();
  });
  for (const item of feedback) {
    const slot = document.querySelector(`[data-feedback="${item.id}"]`)!;
    slot.append(button("查看详情", async () => {
      const detail = await api(`/test-feedback/${item.id}`);
      const dialog = document.createElement("dialog");
      dialog.innerHTML = `<h2>反馈详情</h2><p>期望：${html(detail.expected)}</p><p>实际：${html(detail.actual)}</p><p>状态：${html(detail.state)}</p><p>处理说明：${html(detail.resolution)}</p><p>修复版本：${html(detail.fix_version_id ?? "尚未关联")}</p>
        ${(detail.attachments ?? []).map((attachment: JsonRow) => `<p><a href="/api/v1/test-feedback/uploads/${html(attachment.id)}/content" download>下载附件（${html(attachment.mime)}）</a></p>`).join("")}`;
      dialog.append(button("关闭", async () => { dialog.close(); dialog.remove(); }));
      dialog.addEventListener("cancel", () => dialog.remove()); document.body.append(dialog); dialog.showModal();
    }));
    if (item.state === "awaiting_retest") for (const [label, resolved] of [["已修复", true], ["仍有问题", false]] as const) {
      slot.append(button(label, async () => {
        const details = prompt("请填写本次复测的实际情况"); if (!details) return;
        await api(`/test-feedback/${item.id}/retests`, "POST", { resolved, details }, "access"); await render();
      }));
    }
  }
}
async function accountPage() {
  document.getElementById("content")!.innerHTML = heading("我的账号", "账号、游客和测试访问分别管理。") + `<div id="account-body"></div>`;
  const body = document.getElementById("account-body")!;
  if (!session.user) loginForm(body, "login");
  else {
    const devices = list(await api("/me/sessions"));
    body.innerHTML = `<div class="two-col"><div><div id="profile-slot"></div><div id="logout-slot" class="actions"></div></div>
      <section class="panel"><h2>登录设备</h2><div id="device-list"></div></section></div><section class="panel"><h2>我的收藏</h2><div id="favorites"></div></section><section class="panel"><h2>站内消息</h2><div id="notifications"></div></section><section class="panel"><h2>账号支持</h2><div id="account-support" class="actions"></div></section>`;
    await renderProfileTools(document.getElementById("profile-slot")!, render);
    document.getElementById("logout-slot")!.append(button("退出账号", async () => {
      await api("/auth/sessions/current", "DELETE"); session.user = null; session.userCsrf = ""; await render();
    }));
    for (const device of devices) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<div>${html(device.kind)} ${device.current ? "· 当前" : ""}<small>${date(device.created_at)}</small></div>`;
      row.append(button("撤销", async () => { await api(`/me/sessions/${device.id}`, "DELETE"); await restoreSession(); await render(); }));
      document.getElementById("device-list")!.append(row);
    }
    const [favorites, notifications] = await Promise.all([api("/me/favorites"), api("/notifications")]);
    document.getElementById("favorites")!.innerHTML = rowsMarkup(list(favorites), row =>
      `<div class="row"><a href="#/game/${html(row.id)}">${html(row.title)}</a></div>`, "暂无收藏");
    const messages = document.getElementById("notifications")!;
    if (!list(notifications).length) messages.textContent = "暂无站内消息";
    for (const item of list(notifications)) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<div><strong>${html(item.event_type)}</strong><p>${html(item.payload?.reason ?? item.payload?.message ?? "你的作品或任务状态已更新")}</p><small>${date(item.created_at)}</small></div>`;
      if (!item.read_at) row.append(button("标记已读", async () => { await api(`/notifications/${item.id}`, "PATCH", { read: true }); await render(); }));
      messages.append(row);
    }
    document.getElementById("account-support")!.append(
      button("提交账号申诉", async () => {
        const reason = prompt("请说明需要复核的问题"); if (!reason) return;
        const result = await api("/appeals", "POST", { objectType: "account", objectId: session.user!.id, reason }); toast(`已提交申诉：${result.id}`);
      }),
      button("申请注销", async () => {
        const reason = prompt("注销需要核对未结任务、账目及作品；此操作仅提交申请。请填写原因"); if (!reason) return;
        const result = await api("/me/closure-requests", "POST", { reason }); toast(result.message);
      }),
    );
  }
  const accountTools = document.createElement("div"); body.append(accountTools);
  await renderAccountTools(accountTools, render);
  body.append(button("退出测试空间", async () => { await api("/test-access/sessions/current", "DELETE", undefined, "access"); clearSession(); await render(); }, "danger"));
}
async function adminPage() {
  document.getElementById("content")!.innerHTML = heading("内测管理", "后台使用独立登录与授权；每项变更保留审计。") + `<div id="admin-body"></div>`;
  const body = document.getElementById("admin-body")!;
  if (!session.admin) { loginForm(body, "admin"); return; }
  body.innerHTML = `<div class="two-col"><section class="panel"><h2>发放测试邀请</h2>${form("grant-form", field("maxUses", "兑换次数", "number", "1") + field("ttlSeconds", "有效秒数", "number", "3600"), "创建邀请")}<div id="grant-result" class="code"></div></section>
    <section class="panel"><h2>发放测试点数</h2>${form("points-form", field("userId", "用户 ID") + field("amount", "点数", "number", "100") + field("reason", "原因"), "确认发放测试点数")}</section></div>
    <section class="panel"><h2>待审核版本</h2><div id="reviews"></div></section>
    <section class="panel"><h2>测试订单</h2><div id="orders"></div></section><div id="admin-tools"></div><div id="admin-logout"></div>`;
  bindForm("grant-form", async values => {
    const grant = await api("/admin/test-access-grants", "POST", { maxUses: Number(values.get("maxUses")), ttlSeconds: Number(values.get("ttlSeconds")) }, "admin");
    document.getElementById("grant-result")!.textContent = `请私下交给测试者（只显示一次）：${grant.invitation}`;
  });
  bindForm("points-form", async values => {
    await api("/admin/point-grants", "POST", { userId: String(values.get("userId")), points: Number(values.get("amount")), reason: String(values.get("reason")) }, "admin", crypto.randomUUID());
    toast("测试点数已发放");
  });
  try {
    const reviews = list(await api("/admin/reviews", "GET", undefined, "admin")).filter(review => ["pending", "reviewing"].includes(review.status));
    for (const review of reviews) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<div><strong>${html(review.title ?? review.id)}</strong><small>${html(review.version_id ?? review.versionId)}</small></div>`;
      const actions = document.createElement("div"); actions.className = "actions";
      actions.append(button("领取", async () => { await api(`/admin/reviews/${review.id}/claim`, "POST", {}, "admin"); toast("已领取"); }));
      actions.append(button("隔离预览", async () => showPlay(await api(`/admin/reviews/${review.id}/preview-sessions`, "POST", {}, "admin"))));
      actions.append(button("批准", async () => {
        if (!confirm("确认已完成隔离预览和内容检查，并批准这个固定版本？")) return;
        await api(`/admin/reviews/${review.id}/decision`, "POST", { decision: "approved", reason: "内测审核通过", previewConfirmed: true }, "admin", crypto.randomUUID()); await render();
      }));
      actions.append(button("驳回", async () => {
        const reason = prompt("请输入可操作的驳回原因"); if (!reason) return;
        await api(`/admin/reviews/${review.id}/decision`, "POST", { decision: "rejected", reason, previewConfirmed: false }, "admin", crypto.randomUUID()); await render();
      }));
      row.append(actions); document.getElementById("reviews")!.append(row);
    }
    if (!reviews.length) document.getElementById("reviews")!.innerHTML = `<p class="empty">没有待审核版本</p>`;
  } catch (error) { document.getElementById("reviews")!.textContent = errorMessage(error); }
  try {
    const orders = list(await api("/admin/billing/orders", "GET", undefined, "admin"));
    for (const order of orders) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<div><strong>${html(order.id)}</strong><small>${html(order.state ?? order.status)} · 测试订单</small></div>`;
      row.append(button("模拟支付成功", async () => {
        await api(`/admin/billing/orders/${order.id}/mock-confirm`, "POST", { eventKey: crypto.randomUUID() }, "admin", crypto.randomUUID()); await render();
      }));
      document.getElementById("orders")!.append(row);
    }
    if (!orders.length) document.getElementById("orders")!.innerHTML = `<p class="empty">暂无测试订单</p>`;
  } catch (error) { document.getElementById("orders")!.textContent = errorMessage(error); }
  document.getElementById("admin-logout")!.append(button("退出后台", async () => {
    await api("/admin/auth/sessions/current", "DELETE", undefined, "admin"); session.admin = null; session.adminCsrf = ""; await render();
  }));
  await renderAdminTools(document.getElementById("admin-tools")!);
}
async function renderPage(version: number) {
  closeDraft?.(); closeDraft = undefined;
  closeRoom?.(); closeRoom = undefined;
  bridge?.close(); bridge = undefined; if (playTimer) clearInterval(playTimer);
  if (!session.accessCsrf) return showGate();
  shell();
  const pageContainer = document.getElementById("content")!;
  pageContainer.inert = true;
  const [, page = "games", rawId = ""] = location.hash.split("/");
  const [id, query] = rawId.split("?");
  try {
    if (page === "games") await gamesPage();
    else if (page === "game") await gamePage(id);
    else if (page === "creator") await creatorPage();
    else if (page === "project") await projectPage(id);
    else if (page === "wallet") await walletPage();
    else if (page === "feedback") await feedbackPage();
    else if (page === "account") await accountPage();
    else if (page === "author") await renderAuthorPage(document.getElementById("content")!, id);
    else if (page === "admin") await adminPage();
    else if (page === "room") {
      if (!session.guest) {
        const nickname = session.user?.nickname ?? await nicknameDialog();
        if (!nickname) { location.hash = "#/games"; return; }
        session.guest = await api("/guest-sessions", "POST", { nickname }, "access");
      }
      const cleanup = await openOfficialRoom(document.getElementById("content")!, id, new URLSearchParams(query).get("invite") ?? undefined, toast);
      if (version === renderVersion) closeRoom = cleanup; else cleanup();
    }
    else location.hash = "#/games";
  } catch (error) {
    if (version !== renderVersion) return;
    if (error instanceof PlatformError && error.code === "TEST_ACCESS_REQUIRED") return showGate();
    const content = document.getElementById("content");
    if (content) {
      content.innerHTML = `<section class="panel"><h2>暂时无法加载</h2><p class="error">${html(errorMessage(error))}</p><div id="retry"></div></section>`;
      document.getElementById("retry")!.append(button("重试", render));
    }
  } finally { pageContainer.inert = false; }
}
let rendering: Promise<void> = Promise.resolve();
function render(): Promise<void> {
  const version = ++renderVersion;
  rendering = rendering.catch(() => {}).then(async () => {
    if (version === renderVersion) await renderPage(version);
  });
  return rendering;
}
window.addEventListener("hashchange", () => void render());
void restoreSession().then(render).catch(showGate);
