import { api, list, PlatformError, type JsonRow } from "./platform-client";

const labels: Record<string, string> = {
  new: "新反馈", accepted: "已受理", in_progress: "处理中", awaiting_retest: "等待用户复测",
  closed: "已关闭", declined: "不予受理", open: "待处理", repairing: "免费修复中",
  repaired: "已修复", refunded: "已退点", rejected: "已拒绝", requested: "待审批",
  processing: "处理中", succeeded: "已完成", failed: "失败", blocking: "阻塞",
  severe: "严重", normal: "一般", suggestion: "建议",
};
const text = (value: unknown) => String(value ?? "");
const state = (value: unknown) => labels[text(value)] ?? text(value);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, content = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = content; node.className = className; return node;
}
function errorText(error: unknown) {
  if (error instanceof PlatformError) {
    return `${error.message}${error.requestId ? `（请求编号：${error.requestId}）` : ""}`;
  }
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}
function field(form: HTMLElement, name: string, label: string, options?: {
  choices?: [string, string][]; optional?: boolean; max?: number; min?: number; value?: string; type?: string;
}) {
  const wrap = el("label", label);
  const input = options?.choices ? el("select") : el(options?.type === "textarea" ? "textarea" : "input");
  input.name = name; input.required = !options?.optional;
  input.setAttribute("aria-label", label);
  if (input instanceof HTMLSelectElement) {
    for (const [value, title] of options!.choices!) {
      const option = el("option", title); option.value = value; input.append(option);
    }
  } else {
    input.maxLength = options?.max ?? 1000; input.minLength = options?.min ?? 1;
    if (input instanceof HTMLInputElement) input.type = options?.type ?? "text";
  }
  if (options?.value) input.value = options.value;
  wrap.append(input); form.append(wrap); return input;
}
function actionForm(parent: HTMLElement, submit: string, build: (fields: HTMLFieldSetElement) => void,
  save: (values: FormData) => Promise<string>, reload?: () => Promise<void>) {
  const form = el("form"), fields = el("fieldset"), status = el("p", "", "error");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  build(fields); const button = el("button", submit); button.type = "submit";
  fields.append(status, button); form.append(fields); parent.append(form);
  form.onsubmit = async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = new FormData(form); fields.disabled = true; status.textContent = "";
    try {
      const result = await save(values); status.className = "notice"; status.textContent = result;
      if (reload) await reload();
    } catch (error) { status.className = "error"; status.textContent = errorText(error); }
    finally { fields.disabled = false; }
  };
  return form;
}
const value = (data: FormData, name: string) => text(data.get(name)).trim();
function details(parent: HTMLElement, heading: string, rows: [string, unknown][]) {
  const box = el("article", "", "card"); box.append(el("h3", heading));
  for (const [name, entry] of rows) box.append(el("p", `${name}：${text(entry)}`));
  parent.append(box); return box;
}
function section(parent: HTMLElement, title: string, description: string) {
  const box = el("section", "", "panel"); box.append(el("h2", title), el("p", description, "muted"));
  parent.append(box); return box;
}
async function queue(parent: HTMLElement, path: string, render: (node: HTMLElement, row: JsonRow, refresh: () => Promise<void>) => void) {
  const button = el("button", "刷新列表"), status = el("p"), content = el("div", "", "rows");
  button.type = "button"; status.setAttribute("role", "status"); parent.append(button, status, content);
  const refresh = async () => {
    button.disabled = true; status.textContent = "正在加载…";
    try {
      const rows = list(await api(path, "GET", undefined, "admin")); content.replaceChildren();
      status.textContent = rows.length ? `显示最近 ${rows.length} 条记录` : "暂无记录";
      for (const row of rows) render(content, row, refresh);
    } catch (error) { status.textContent = errorText(error); }
    finally { button.disabled = false; }
  };
  button.onclick = () => { void refresh(); };
  await refresh();
}

/** Each panel handles its own permission error so restricted admin roles can use their allowed tools. */
export async function renderAdminTools(container: HTMLElement): Promise<void> {
  container.replaceChildren();
  const feedback = section(container, "测试反馈处理", "关联修复版本后进入复测，测试者可确认解决或重新打开。");
  const quality = section(container, "生成质量工单", "当前仅模拟静态模板。免费修复最多两轮；退点保留原批次来源。");
  const refunds = section(container, "模拟退款审批", "只处理测试订单，不涉及真钱。当前仅支持点数完全未使用的订单全额退回。");
  const moderation = section(container, "内容举报与申诉", "处理结果会通知提交者；如需限制作品或账号，请使用下面的限制工具。");
  const restrictions = section(container, "账号与作品限制", "请核对对象编号及处理原因。解除作品限制后不会自动重新发布。");
  const reconciliation = section(container, "点数对账", "核对账户汇总、原始批次和流水。差异只展示，不自动修改资金记录。");

  actionForm(restrictions, "设置账号限制", form => {
    field(form, "userId", "账号编号");
    field(form, "capability", "限制能力", { choices: [["create", "创建"], ["submit", "提交发布"], ["comment", "评论"], ["billing", "测试点数购买"], ["all", "全部能力"]] });
    field(form, "expiresAt", "结束时间（可选，不填则长期）", { optional: true, type: "datetime-local" });
    field(form, "reason", "处理原因", { type: "textarea" });
  }, async data => {
    const date = value(data, "expiresAt");
    const result = await api(`/admin/users/${encodeURIComponent(value(data, "userId"))}/restrictions`, "POST", {
      capability: value(data, "capability"), reason: value(data, "reason"), ...(date ? { expiresAt: new Date(date).toISOString() } : {}),
    }, "admin");
    return `已设置限制；解除时使用此限制编号：${result.id}`;
  });
  actionForm(restrictions, "解除账号限制", form => {
    field(form, "restrictionId", "限制记录编号"); field(form, "reason", "解除原因", { type: "textarea" });
  }, async data => {
    await api(`/admin/restrictions/${encodeURIComponent(value(data, "restrictionId"))}`, "DELETE", { reason: value(data, "reason") }, "admin");
    return "账号限制已解除。";
  });
  actionForm(restrictions, "更新作品限制", form => {
    field(form, "gameId", "作品编号"); field(form, "restricted", "操作", { choices: [["true", "限制作品"], ["false", "解除限制"]] });
    field(form, "reason", "处理原因", { type: "textarea" });
  }, async data => {
    await api(`/admin/games/${encodeURIComponent(value(data, "gameId"))}/restrictions`, "POST",
      { restricted: value(data, "restricted") === "true", reason: value(data, "reason") }, "admin");
    return "作品限制已更新；重新公开需要作者再次发布。";
  });
  const reconcileResult = el("div");
  actionForm(reconciliation, "执行对账", () => {}, async () => {
    const result = await api("/admin/reconciliation", "GET", undefined, "admin"); reconcileResult.replaceChildren();
    for (const difference of result.differences ?? []) {
      details(reconcileResult, `账号 ${text(difference.user_id)}`, Object.entries(difference).filter(([key]) => key !== "user_id"));
    }
    return result.consistent ? "对账通过：账户、批次与流水一致。" : `发现 ${result.differences?.length ?? 0} 项差异，请人工核查。`;
  }); reconciliation.append(reconcileResult);

  await Promise.all([
    queue(feedback, "/admin/test-feedback", (node, row, refresh) => {
      const box = details(node, `反馈 ${row.id}`, [["状态", state(row.state)], ["严重程度", state(row.severity)], ["期望表现", row.expected],
        ["实际表现", row.actual], ["作品编号", row.game_id], ["发生版本", row.version_id], ["修复版本", row.fix_version_id]]);
      const attachments = el("div"), loadAttachments = el("button", "查看反馈附件");
      loadAttachments.type = "button"; box.append(loadAttachments, attachments);
      loadAttachments.onclick = async () => {
        loadAttachments.disabled = true;
        try {
          const detail = await api(`/admin/test-feedback/${row.id}`, "GET", undefined, "admin");
          attachments.replaceChildren();
          if (!detail.attachments?.length) attachments.textContent = "此反馈没有附件";
          for (const file of detail.attachments ?? []) {
            const link = el("a", `下载附件（${file.mime}，${file.size}字节）`);
            link.href = `/api/v1/admin/test-feedback/uploads/${encodeURIComponent(file.id)}/content`; link.download = "attachment";
            attachments.append(link, document.createElement("br"));
          }
        } catch (error) { attachments.textContent = errorText(error); }
        finally { loadAttachments.disabled = false; }
      };
      actionForm(box, "保存反馈处理", form => {
        field(form, "state", "处理状态", { choices: ["accepted", "in_progress", "awaiting_retest", "closed", "declined"].map(key => [key, state(key)]), value: row.state === "new" ? "accepted" : row.state });
        field(form, "severity", "严重程度", { choices: ["blocking", "severe", "normal", "suggestion"].map(key => [key, state(key)]), value: row.severity || "normal" });
        field(form, "fixVersionId", "修复版本编号（游戏反馈复测必填）", { optional: true, value: row.fix_version_id });
        field(form, "reason", "处理说明", { type: "textarea", max: 2000 });
      }, async data => {
        const fixVersionId = value(data, "fixVersionId");
        await api(`/admin/test-feedback/${row.id}`, "PATCH", { state: value(data, "state"), severity: value(data, "severity"),
          reason: value(data, "reason"), ...(fixVersionId ? { fixVersionId } : {}) }, "admin");
        return "反馈处理已保存。";
      }, refresh);
    }),
    queue(quality, "/admin/quality-cases", (node, row, refresh) => {
      const box = details(node, `工单 ${row.id}`, [["状态", state(row.status)], ["任务编号", row.task_id], ["问题描述", row.description],
        ["已安排免费修复次数", row.repair_count], ["处理说明", row.resolution]]);
      if (!["open", "repaired"].includes(row.status)) return;
      actionForm(box, "提交质量工单处理", form => {
        const choices: [string, string][] = [["refund", "退还原消费点数"], ["reject", "拒绝并说明原因"]];
        if (row.repair_count < 2) choices.unshift(["repair", "安排免费修复"]);
        field(form, "decision", "处理结果", { choices });
        field(form, "reason", "处理原因", { type: "textarea", min: 3 });
      }, async data => {
        await api(`/admin/quality-cases/${row.id}/resolve`, "POST", { decision: value(data, "decision"), reason: value(data, "reason") }, "admin");
        return "质量工单处理已提交。";
      }, refresh);
    }),
    queue(refunds, "/admin/refunds", (node, row, refresh) => {
      const box = details(node, `退款 ${row.id}`, [["订单编号", row.order_id], ["状态", state(row.status)], ["用户说明", row.reason], ["处理说明", row.resolution]]);
      if (row.status !== "requested") return;
      actionForm(box, "提交模拟退款审批", form => {
        field(form, "approve", "审批结果", { choices: [["false", "拒绝申请"], ["true", "同意全额模拟退款"]] });
        field(form, "reason", "审批原因", { type: "textarea", min: 3 });
      }, async data => {
        await api(`/admin/refunds/${row.id}/resolve`, "POST", { approve: value(data, "approve") === "true", reason: value(data, "reason") }, "admin");
        return "模拟退款审批已完成。";
      }, refresh);
    }),
    ...(["reports", "appeals"] as const).map(kind => {
      const group = el("div"); group.append(el("h3", kind === "reports" ? "举报" : "申诉")); moderation.append(group);
      return queue(group, `/admin/${kind}`, (node, row, refresh) => {
        const box = details(node, `记录 ${row.id}`, [["状态", state(row.state)], ["对象类型", row.object_type], ["对象编号", row.object_id], ["说明", row.reason], ["处理结果", row.resolution]]);
        actionForm(box, "保存处理结果", form => {
          field(form, "state", "处理结果", { choices: [["accepted", "已受理"], ["resolved", "已解决"], ["dismissed", "不予支持"]] });
          field(form, "reason", "处理说明", { type: "textarea" });
        }, async data => {
          await api(`/admin/${kind}/${row.id}`, "PATCH", { state: value(data, "state"), reason: value(data, "reason") }, "admin");
          return "处理结果已保存。";
        }, refresh);
      });
    }),
  ]);
}
