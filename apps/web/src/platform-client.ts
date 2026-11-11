export type JsonRow = Record<string, any>;
export class PlatformError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) { super(message); }
}
export const session = {
  accessCsrf: "", userCsrf: "", adminCsrf: "", supportCsrf:"",
  user: null as JsonRow | null, admin: null as JsonRow | null, guest: null as JsonRow | null,support:null as JsonRow|null,
};
export async function api<T = JsonRow>(
  path: string, method = "GET", body?: unknown,
  identity: "access" | "user" | "admin" | "support" = "user", idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    headers["X-CSRF-Token"] = session[`${identity}Csrf`];
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  }
  const response = await fetch(`/api/v1${path}`, {
    method, credentials: "same-origin", headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new PlatformError(payload.error?.code ?? "UNKNOWN", payload.error?.message ?? "请求失败", payload.requestId);
  return payload.data as T;
}
export const list = (value: unknown): JsonRow[] => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const row = value as JsonRow;
    return row.items ?? row.games ?? row.versions ?? row.tasks ?? [];
  }
  return [];
};
export async function restoreSession() {
  const access = await api("/test-access/sessions/current");
  session.accessCsrf = access.csrfToken;
  const [user, admin, guest,support] = await Promise.all([
    api("/auth/sessions/current").catch(() => null),
    api("/admin/auth/sessions/current").catch(() => null),
    api("/guest-sessions/current").catch(() => null),
    api("/support/sessions/current").catch(()=>null),
  ]);
  session.user = user?.user ?? null; session.userCsrf = user?.csrfToken ?? "";
  session.admin = admin?.user ?? null; session.adminCsrf = admin?.csrfToken ?? "";
  session.guest = guest;
  session.support=support?.user??null;session.supportCsrf=support?.csrfToken??"";
}
export function clearSession() {
  session.accessCsrf = ""; session.userCsrf = ""; session.adminCsrf = "";
  session.user = null; session.admin = null; session.guest = null;
  session.support=null;session.supportCsrf="";
}
