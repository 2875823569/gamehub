import { HostGame, type HostSnapshot } from "../../../packages/host-game";
import { MAX_PEER_MESSAGE, type PeerPayload, type PeerRoster, type PeerServerMessage, type Signal } from "../../../packages/peer-protocol";
import type { ClientAction, ServerMessage } from "../../../packages/protocol";

interface Link {
  pc: RTCPeerConnection; dc?: RTCDataChannel; connectionId: string; negotiation: string;
  candidates: RTCIceCandidateInit[]; localCandidates: RTCIceCandidateInit[]; announced: boolean;
  created: number; lastSeen: number; rtt?: number;
}

/** One host per room, ordered reliable channels, authenticated signaling and relay. */
export class PeerTransport {
  private roster?: PeerRoster;
  private engine?: HostGame;
  private links = new Map<string, Link>();
  private pending = new Map<string, { action: ClientAction; sentAt: number }>();
  private lastRevision = -1;
  private lastSync = 0;
  private savedRevision = -1;
  private latestSnapshot?: HostSnapshot;
  private signalQueue = Promise.resolve();
  private closed = false;
  private status = "";
  private interval = setInterval(() => this.tick(), 500);

  constructor(
    private ws: WebSocket,
    private receive: (message: ServerMessage) => void,
    private connection: (ready: boolean, label: string) => void
  ) {}
  close() {
    this.closed = true;
    clearInterval(this.interval);
    for (const id of this.links.keys()) this.drop(id);
    this.pending.clear();
  }
  private get isHost() { return this.roster?.you === this.roster?.hostId; }
  private wire(message: unknown) {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
  handle(message: PeerServerMessage) {
    if (this.closed) return;
    if (message.type === "peer-roster") {
      const previous = this.roster;
      if (previous && message.roster.revision < previous.revision) return;
      this.roster = message.roster;
      if (!previous || previous.epoch !== this.roster.epoch) {
        for (const id of this.links.keys()) this.drop(id);
        this.engine = undefined;
        this.lastRevision = -1;
        this.savedRevision = -1;
        this.pending.clear();
      }
      if (previous?.players.find(p => p.id === this.roster!.hostId)?.connectionId !==
          this.roster.players.find(p => p.id === this.roster!.hostId)?.connectionId) this.lastRevision = -1;
      for (const [id, link] of this.links) {
        const p = this.roster.players.find(p => p.id === id);
        if (!p?.connected || p.connectionId !== link.connectionId) this.drop(id);
      }
      if (this.isHost) {
        if (!this.engine) {
          let snapshot = message.snapshot;
          try {
            const local = JSON.parse(sessionStorage.getItem(this.cacheKey()) ?? "null") as HostSnapshot | null;
            if (local?.version === 1 && (!snapshot || local.revision > snapshot.revision)) snapshot = local;
          } catch { /* Server checkpoint still supports recovery. */ }
          this.engine = new HostGame(this.roster, snapshot);
        } else this.engine.reconcile(this.roster);
        this.publish();
        for (const p of this.roster.players) if (p.id !== this.roster.you && p.connected && !this.links.has(p.id)) void this.offer(p.id);
      } else {
        this.engine = undefined;
        this.transmit(this.roster.hostId, { type: "sync" }, true);
      }
      this.updateStatus();
    } else if (message.type === "peer-signal") {
      this.signalQueue = this.signalQueue.then(() => this.signal(message)).catch(() => {
        this.drop(message.from);
        this.updateStatus();
      });
    } else if (message.type === "peer-relay") {
      if (message.epoch === this.roster?.epoch) this.payload(message.from, message.payload);
    } else if (message.type === "peer-saved") this.savedRevision = Math.max(this.savedRevision, message.revision);
    else this.receive(message);
  }
  send(action: ClientAction) {
    if (!this.roster || this.closed) return;
    if (action.type === "leave") { this.wire(action); return; }
    if (this.isHost) this.action(this.roster.you, action);
    else {
      if (action.requestId) this.pending.set(action.requestId, { action, sentAt: Date.now() });
      this.transmit(this.roster.hostId, { type: "action", action });
    }
  }
  private cacheKey() { return `playroom.host.${this.roster!.code}.${this.roster!.you}.${this.roster!.epoch}`; }
  private publish() {
    if (!this.engine || !this.roster) return;
    this.latestSnapshot = this.engine.snapshot();
    try { sessionStorage.setItem(this.cacheKey(), JSON.stringify(this.latestSnapshot)); } catch { /* Server backup remains available. */ }
    this.wire({ type: "peer-checkpoint", epoch: this.roster.epoch, snapshot: this.latestSnapshot });
    for (const p of this.roster.players) {
      if (p.connected) this.deliver(p.id, { type: "state", state: this.engine.view(p.id) });
    }
  }
  private deliver(id: string, message: ServerMessage, relay = false) {
    if (id === this.roster?.you) this.receive(message);
    else this.transmit(id, { type: "message", message }, relay);
  }
  private action(id: string, action: ClientAction, relay = false) {
    if (!this.engine) return;
    const before = this.engine.snapshot().revision;
    const reply = this.engine.act(id, action);
    if (this.engine.snapshot().revision !== before) this.publish();
    if (relay || this.engine.snapshot().revision === before)
      this.deliver(id, { type: "state", state: this.engine.view(id) }, relay);
    this.deliver(id, reply, relay);
  }
  private payload(from: string, payload: PeerPayload, direct = false) {
    if (!this.roster || !payload || !this.roster.players.some(p => p.id === from && p.connected)) return;
    if (!this.isHost && from !== this.roster.hostId) return;
    const link = this.links.get(from);
    if (direct && link) link.lastSeen = Date.now();
    if (payload.type === "ping") { this.transmit(from, { type: "pong", at: payload.at }, !direct); return; }
    if (payload.type === "pong") {
      if (direct && link) link.rtt = Math.max(0, Date.now() - payload.at);
      return;
    }
    if (this.isHost) {
      if (payload.type === "action" && payload.action && JSON.stringify(payload.action).length <= 1024) this.action(from, payload.action, !direct);
      if (payload.type === "sync" && this.engine) this.deliver(from, { type: "state", state: this.engine.view(from) }, !direct);
    } else if (payload.type === "message") {
      const message = payload.message;
      if (!message) return;
      if (message.type === "state") {
        if (message.state.you !== this.roster.you || message.state.hostId !== this.roster.hostId ||
            message.state.code !== this.roster.code || message.state.revision <= this.lastRevision) return;
        this.lastRevision = message.state.revision;
      }
      if ((message.type === "ack" || message.type === "error") && message.requestId) this.pending.delete(message.requestId);
      this.receive(message);
      this.updateStatus();
    }
  }
  private direct(id: string) {
    const link = this.links.get(id);
    return link?.dc?.readyState === "open" && Date.now() - link.lastSeen < 8000 &&
      link.pc.connectionState !== "disconnected" && link.pc.connectionState !== "failed" ? link : undefined;
  }
  private transmit(to: string, payload: PeerPayload, relay = false) {
    const link = this.direct(to);
    if (!relay && link?.dc && link.dc.bufferedAmount < 64 * 1024) {
      try { link.dc.send(JSON.stringify({ epoch: this.roster!.epoch, payload })); return; }
      catch { this.drop(to); }
    }
    this.wire({ type: "peer-relay", to, epoch: this.roster!.epoch, payload });
  }
  private createLink(id: string, negotiation: string): Link | undefined {
    const member = this.roster?.players.find(p => p.id === id && p.connected);
    if (!member?.connectionId || typeof RTCPeerConnection === "undefined") return;
    this.drop(id);
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }
    ] });
    const link: Link = { pc, connectionId: member.connectionId, negotiation, candidates: [],
      localCandidates: [], announced: false, created: Date.now(), lastSeen: Date.now() };
    this.links.set(id, link);
    pc.onicecandidate = event => {
      if (!event.candidate || this.links.get(id) !== link) return;
      const candidate = event.candidate.toJSON();
      if (link.announced) this.sendSignal(id, link, { candidate });
      else link.localCandidates.push(candidate);
    };
    pc.ondatachannel = event => this.channel(id, link, event.channel);
    pc.onconnectionstatechange = () => {
      if (this.links.get(id) !== link) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.drop(id);
      this.updateStatus();
    };
    return link;
  }
  private channel(id: string, link: Link, dc: RTCDataChannel) {
    if (link.dc && link.dc !== dc) { dc.close(); return; }
    link.dc = dc;
    dc.onopen = () => {
      if (this.closed || this.links.get(id) !== link) return;
      link.lastSeen = Date.now();
      if (this.engine) this.deliver(id, { type: "state", state: this.engine.view(id) });
      else this.transmit(id, { type: "sync" });
      this.updateStatus();
    };
    dc.onmessage = event => {
      if (this.links.get(id) !== link || typeof event.data !== "string" ||
          event.data.length > (this.isHost ? 4096 : MAX_PEER_MESSAGE)) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.epoch === this.roster?.epoch) this.payload(id, frame.payload, true);
      } catch { /* Invalid peer frames do not tear down the room. */ }
    };
    dc.onclose = () => { if (this.links.get(id) === link) { this.drop(id); this.updateStatus(); } };
    dc.onerror = () => { if (this.links.get(id) === link) { this.drop(id); this.updateStatus(); } };
  }
  private sendSignal(id: string, link: Link, signal: Signal) {
    if (this.closed || this.links.get(id) !== link) return;
    this.wire({ type: "peer-signal", to: id, connectionId: link.connectionId, epoch: this.roster!.epoch, negotiation: link.negotiation, signal });
  }
  private announce(id: string, link: Link) {
    const d = link.pc.localDescription!;
    this.sendSignal(id, link, { description: { type: d.type as "offer" | "answer", sdp: d.sdp } });
    link.announced = true;
    for (const candidate of link.localCandidates.splice(0)) this.sendSignal(id, link, { candidate });
  }
  private async offer(id: string) {
    try {
      const link = this.createLink(id, [...crypto.getRandomValues(new Uint32Array(4))].join("-"));
      if (!link) return;
      this.channel(id, link, link.pc.createDataChannel("playroom", { ordered: true }));
      await link.pc.setLocalDescription(await link.pc.createOffer());
      this.announce(id, link);
    } catch { this.drop(id); }
  }
  private async signal(message: Extract<PeerServerMessage, { type: "peer-signal" }>) {
    if (this.closed || !this.roster || message.epoch !== this.roster.epoch) return;
    const member = this.roster.players.find(p => p.id === message.from && p.connected);
    if (!member || member.connectionId !== message.connectionId || (!this.isHost && message.from !== this.roster.hostId)) return;
    let link = this.links.get(message.from);
    if ("description" in message.signal) {
      const d = message.signal.description;
      if (d.type === "offer") {
        if (this.isHost) return;
        link = this.createLink(message.from, message.negotiation);
      } else if (!this.isHost || !link || link.negotiation !== message.negotiation) return;
      if (!link) return;
      await link.pc.setRemoteDescription(d);
      for (const candidate of link.candidates.splice(0)) await link.pc.addIceCandidate(candidate);
      if (d.type === "offer") {
        await link.pc.setLocalDescription(await link.pc.createAnswer());
        this.announce(message.from, link);
      }
    } else if (link?.negotiation === message.negotiation) {
      if (link.pc.remoteDescription) await link.pc.addIceCandidate(message.signal.candidate);
      else link.candidates.push(message.signal.candidate);
    }
  }
  private drop(id: string) {
    const link = this.links.get(id);
    this.links.delete(id);
    if (link) { link.dc?.close(); link.pc.close(); }
  }
  private tick() {
    if (!this.roster || this.closed) return;
    if (this.engine?.tick()) this.publish();
    const now = Date.now();
    for (const request of this.pending.values()) {
      if (now - request.sentAt > 1500) {
        this.transmit(this.roster.hostId, { type: "action", action: request.action }, true);
        request.sentAt = now;
      }
    }
    if (now - this.lastSync >= 3000) {
      this.lastSync = now;
      for (const [id, link] of this.links) {
        if (link.dc?.readyState === "open") this.transmit(id, { type: "ping", at: now });
        if (now - link.created > 15_000 && !this.direct(id)) this.drop(id);
      }
      if (this.isHost) {
        if (this.latestSnapshot && this.savedRevision < this.latestSnapshot.revision)
          this.wire({ type: "peer-checkpoint", epoch: this.roster.epoch, snapshot: this.latestSnapshot });
        for (const p of this.roster.players) if (p.id !== this.roster.you && p.connected && !this.links.has(p.id)) void this.offer(p.id);
      } else this.transmit(this.roster.hostId, { type: "sync" });
    }
    this.updateStatus();
  }
  private updateStatus() {
    if (!this.roster || this.closed) return;
    const ready = this.isHost ? !!this.engine : this.lastRevision >= 0 && !!this.roster.players.find(p => p.id === this.roster!.hostId)?.connected;
    const peers = this.roster.players.filter(p => p.id !== this.roster!.you && p.connected);
    const direct = peers.filter(p => this.direct(p.id)).length;
    const link = this.direct(this.roster.hostId);
    const label = this.isHost
      ? `房主主持 · ${direct} 人直连 · ${peers.length - direct} 人转发`
      : !ready ? "等待房主恢复连接…" : link ? `P2P 直连${link.rtt === undefined ? "" : ` · ${link.rtt} ms`}` : "服务器转发 · 正在尝试直连";
    const key = `${ready}:${label}`;
    if (key !== this.status) { this.status = key; this.connection(ready, label); }
  }
}
