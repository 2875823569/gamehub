export interface GameBridge {
  close(): void;
  lifecycle(type: string): void;
}
export interface GameBridgeOptions {
  context: Record<string, unknown>;
  loadProgress(): Promise<{ data: unknown; revision: number }>;
  saveProgress(data: unknown, expectedRevision: number): Promise<unknown>;
  onReady(): void;
  onError(message: string): void;
}

/** The parent owns identity and credentials; the sandbox only receives this finite capability port. */
export function connectGameFrame(frame: HTMLIFrameElement, options: GameBridgeOptions): GameBridge {
  let port: MessagePort | undefined;
  let closed = false;
  let ready = false;
  let initialized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bucket = Date.now(), count = 0;
  const start = () => {
    if (closed || !frame.contentWindow) return;
    if (initialized) {
      closed = true;
      port?.close();
      if (timer) clearTimeout(timer);
      options.onError("游戏页面发生导航，请重新打开游戏");
      frame.src = "about:blank";
      return;
    }
    initialized = true;
    port?.close();
    if (timer) clearTimeout(timer);
    const channel = new MessageChannel();
    port = channel.port1;
    const activePort = port;
    const nonce = crypto.randomUUID();
    ready = false;
    timer = setTimeout(() => { if (!ready) options.onError("游戏未能在规定时间内准备完成"); }, 15000);
    port.onmessage = async event => {
      if (closed || activePort !== port) return;
      const message = event.data;
      if (!message || typeof message !== "object" || message.nonce !== nonce || message.protocolVersion !== 1 ||
          typeof message.id !== "string" || message.id.length > 80 || typeof message.type !== "string") return;
      let serialized: string;
      try { serialized = JSON.stringify(message); } catch { return; }
      if (new TextEncoder().encode(serialized).length > 110 * 1024) return;
      if (Date.now() - bucket > 1000) { bucket = Date.now(); count = 0; }
      if (++count > 20) return;
      const send = (result: unknown, error?: string) => {
        if (!closed && port === activePort) activePort.postMessage({
          protocolVersion: 1, nonce, id: message.id, type: "result", result, ...(error ? { error } : {}),
        });
      };
      try {
        switch (message.type) {
          case "ready":
            ready = true;
            if (timer) clearTimeout(timer);
            options.onReady();
            send({ ready: true });
            break;
          case "getContext": send(options.context); break;
          case "loadProgress": send(await options.loadProgress()); break;
          case "saveProgress":
            if (!Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0) throw new Error("存档版本无效");
            send(await options.saveProgress(message.data, message.expectedRevision));
            break;
          case "reportRoundEnd": send({ received: true }); break;
          default: send(null, "平台未授权此操作");
        }
      } catch { send(null, "操作失败，请检查权限、存档版本或网络后重试"); }
    };
    port.start();
    // Opaque-origin iframe requires '*'. This message contains no account or resource credentials.
    frame.contentWindow.postMessage({ type: "gamehub:init", protocolVersion: 1, nonce }, "*", [channel.port2]);
  };
  frame.addEventListener("load", start);
  return {
    lifecycle(type) { if (!closed) port?.postMessage({ type: "lifecycle", event: type, protocolVersion: 1 }); },
    close() {
      closed = true;
      port?.close();
      if (timer) clearTimeout(timer);
      frame.removeEventListener("load", start);
      frame.src = "about:blank";
    },
  };
}
