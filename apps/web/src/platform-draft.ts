import { api, session, type JsonRow } from "./platform-client";

/** Server revision prevents stale tabs from overwriting drafts; local edits survive offline reloads. */
export function bindPromptDraft(form: HTMLFormElement, gameId: string, projectId: string, workspace: JsonRow) {
  const prompt = form.elements.namedItem("prompt") as HTMLTextAreaElement;
  const mode = form.elements.namedItem("mode") as HTMLSelectElement;
  const status = document.createElement("p"); status.className = "muted"; status.setAttribute("role", "status");
  form.after(status);
  const key = `gamehub-draft:${session.user!.id}:${gameId}`;
  let revision = Number(workspace.workspaceRevision), baseDraft = workspace.draft ?? {};
  let edit = 0, savedEdit = 0, stopped = false;
  let pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  prompt.value = typeof baseDraft.prompt === "string" ? baseDraft.prompt : "";
  if (baseDraft.mode === "modify" && !mode.querySelector<HTMLOptionElement>('[value=modify]')?.disabled) mode.value = "modify";
  status.textContent = `草稿已同步 · 修订 ${revision}`;
  function remember() {
    localStorage.setItem(key, JSON.stringify({ draft: { ...baseDraft, prompt: prompt.value, mode: mode.value }, basedOnRevision: revision, savedAt: Date.now() }));
  }
  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    if (pending) { await pending; if (edit !== savedEdit) return flush(); return; }
    if (edit === savedEdit) return;
    const savingEdit = edit, draft = { ...baseDraft, prompt: prompt.value, mode: mode.value };
    status.textContent = "正在同步草稿…";
    pending = (async () => {
      try {
        const next = await api(`/creator/projects/${projectId}/workspace`, "PATCH", { expectedRevision: revision, draft });
        revision = next.workspaceRevision; baseDraft = draft; savedEdit = savingEdit;
        if (edit === savingEdit) { localStorage.removeItem(key); status.textContent = `草稿已同步 · 修订 ${revision}`; }
        else { remember(); status.textContent = "有新的修改尚未同步"; }
      } catch (error) {
        remember();
        status.textContent = `尚未同步，已保留本机副本：${error instanceof Error ? error.message : "网络不可用"}。刷新后可选择恢复。`;
        throw error;
      } finally { pending = undefined; }
    })();
    await pending;
  }
  function changed() {
    edit++; remember(); status.textContent = "尚未同步 · 本机副本已保存";
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { if (!stopped) void flush().catch(() => {}); }, 700);
  }
  prompt.addEventListener("input", changed); mode.addEventListener("change", changed);
  let local: JsonRow | null = null;
  try { local = JSON.parse(localStorage.getItem(key) ?? "null"); } catch { localStorage.removeItem(key); }
  if (local?.draft && typeof local.draft.prompt === "string") {
    const recovery = document.createElement("div"); recovery.className = "notice";
    const label = document.createElement("p");
    label.textContent = `发现本机尚未同步副本（基于修订 ${local.basedOnRevision}），当前服务器为修订 ${revision}。请选择是否恢复。`;
    const restore = document.createElement("button"); restore.type = "button"; restore.textContent = "恢复本机草稿";
    restore.onclick = () => {
      prompt.value = local!.draft.prompt;
      if (local!.draft.mode === "create" || (local!.draft.mode === "modify" && !mode.querySelector<HTMLOptionElement>('[value=modify]')?.disabled)) mode.value = local!.draft.mode;
      changed(); recovery.remove();
    };
    const discard = document.createElement("button"); discard.type = "button"; discard.textContent = "保留服务器草稿";
    discard.onclick = () => { localStorage.removeItem(key); recovery.remove(); };
    recovery.append(label, restore, discard); status.after(recovery);
  }
  return { flush, close() { stopped = true; if (timer) clearTimeout(timer); prompt.removeEventListener("input", changed); mode.removeEventListener("change", changed); } };
}
