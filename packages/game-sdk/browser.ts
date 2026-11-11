export interface GameSdk {
  ready(): Promise<unknown>;
  getContext(): Promise<unknown>;
  loadProgress(): Promise<unknown>;
  saveProgress(data: unknown, expectedRevision: number): Promise<unknown>;
  reportRoundEnd(result: unknown): Promise<unknown>;
  onLifecycle(callback: (event: string) => void): void;
}

/** Parent origin must be supplied by the platform template, not inferred from arbitrary messages. */
export function createGameSdk(parentOrigin: string): Promise<GameSdk> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", initialize);
      reject(new Error("平台连接超时"));
    }, 15000);
    function initialize(event: MessageEvent) {
      if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.type !== "gamehub:init" ||
          event.data?.protocolVersion !== 1 || typeof event.data.nonce !== "string" || event.ports.length !== 1) return;
      clearTimeout(timer);
      window.removeEventListener("message", initialize);
      const port = event.ports[0], nonce = event.data.nonce;
      const pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      let lifecycle = (_event: string) => {};
      port.onmessage = response => {
        if (response.data?.type === "lifecycle" && typeof response.data.event === "string") {
          lifecycle(response.data.event);
          return;
        }
        if (response.data?.nonce !== nonce || response.data?.type !== "result") return;
        const item = pending.get(response.data.id);
        if (!item) return;
        pending.delete(response.data.id); clearTimeout(item.timer);
        if (response.data.error) item.reject(new Error(String(response.data.error)));
        else item.resolve(response.data.result);
      };
      port.start();
      const request = (type: string, payload: Record<string, unknown> = {}) => new Promise((res, rej) => {
        if (pending.size >= 20) return rej(new Error("请求过于频繁"));
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => { pending.delete(id); rej(new Error("平台请求超时")); }, 10000);
        pending.set(id, { resolve: res, reject: rej, timer: timeout });
        port.postMessage({ protocolVersion: 1, nonce, id, type, ...payload });
      });
      window.addEventListener("pagehide", () => {
        port.close();
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("页面已关闭")); }
        pending.clear();
      }, { once: true });
      resolve({
        ready: () => request("ready"), getContext: () => request("getContext"),
        loadProgress: () => request("loadProgress"),
        saveProgress: (data, expectedRevision) => request("saveProgress", { data, expectedRevision }),
        reportRoundEnd: result => request("reportRoundEnd", { result }),
        onLifecycle: callback => { lifecycle = callback; },
      });
    }
    window.addEventListener("message", initialize);
  });
}
