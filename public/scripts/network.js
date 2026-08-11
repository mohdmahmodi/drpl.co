/**
 * drpl.co - network layer
 *
 * ServerConnection  resilient WebSocket to the signaling server
 * PeersManager      tracks peers, routes signals, reconciles on reconnect
 * RTCPeer           WebRTC data channel transport (primary)
 * WSPeer            server-relay transport (fallback when WebRTC is blocked)
 *
 * Transfer protocol (JSON control messages + binary chunks, in order):
 *   sender:   transfer-request > (wait for consent)
 *             transfer-start > [file-start > chunks... > file-end]* > transfer-end
 *   receiver: transfer-response > progress (throttled), file-received (per
 *             file), transfer-received
 *   either:   transfer-cancel
 *
 * Nothing is sent until the receiving device accepts. A transfer-start whose
 * id was never accepted is rejected, so consent cannot be skipped by a peer
 * that ignores the handshake.
 */

class Events {
  static fire(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }
  static on(type, cb) {
    return window.addEventListener(type, cb);
  }
  static off(type, cb) {
    return window.removeEventListener(type, cb);
  }
}

// Transfer tuning. 64 KiB chunks are the safe cross-browser data channel
// message size. Backpressure: pause when the send buffer passes HIGH_WATER,
// resume when the browser drains it below LOW_WATER (bufferedamountlow).
const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;
const WS_HIGH_WATER = 1 * 1024 * 1024;
const PROGRESS_INTERVAL = 100; // ms between progress events/messages

// How long the receiving device has to accept an incoming transfer. The
// sender waits a little longer so a decline that is already on the wire wins
// over the sender's own timeout.
const CONSENT_TIMEOUT = 60 * 1000;
const CONSENT_GRACE = 5 * 1000;

let messageCounter = 0;
const nextId = (prefix) =>
  `${prefix}${Date.now().toString(36)}-${(messageCounter++).toString(36)}`;

// ── ServerConnection ─────────────────────────────────────────────────────────

class ServerConnection {
  constructor() {
    this._socket = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._lastActivity = 0;
    this._probeTimer = null;

    this._connect();

    // A watchdog beats the classic zombie-socket problem: after a phone
    // sleeps, readyState can still say OPEN while the connection is long
    // dead. The server pings every 10s; silence past 65s means dead.
    this._watchdog = setInterval(() => this._checkHealth(), 10 * 1000);

    Events.on("beforeunload", () => this._disconnect());
    Events.on("pagehide", () => this._disconnect());
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) this._reconnectNow();
    });
    window.addEventListener("online", () => this._reconnectNow());
    window.addEventListener("focus", () => this._ensureAlive());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this._ensureAlive();
    });
  }

  _endpoint() {
    // window.DRPL_CONFIG.signalingServer lets a statically hosted copy of
    // /public point at a remote signaling server. Empty = same origin.
    const configured = window.DRPL_CONFIG && window.DRPL_CONFIG.signalingServer;
    const webrtc = window.RTCPeerConnection ? "/webrtc" : "/fallback";
    const query = `?pid=${encodeURIComponent(this._peerId())}`;
    if (configured) {
      return configured.replace(/\/$/, "") + "/server" + webrtc + query;
    }
    const protocol = location.protocol.startsWith("https") ? "wss" : "ws";
    return `${protocol}://${location.host}/server${webrtc}${query}`;
  }

  // Identity is per tab (sessionStorage), so several tabs in one browser
  // appear as separate devices instead of fighting over one cookie.
  _peerId() {
    try {
      let pid = sessionStorage.getItem("drpl-peer-id");
      if (!pid) {
        pid = crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        sessionStorage.setItem("drpl-peer-id", pid);
      }
      return pid;
    } catch (e) {
      return ""; // server falls back to its cookie/random id
    }
  }

  _connect() {
    clearTimeout(this._reconnectTimer);
    if (this._isConnected() || this._isConnecting()) return;
    const ws = new WebSocket(this._endpoint());
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this._reconnectAttempts = 0;
      this._lastActivity = Date.now();
      Events.fire("server-connected");
    };
    ws.onmessage = (e) => this._onMessage(e.data);
    ws.onclose = () => this._onDisconnect();
    ws.onerror = () => {}; // onclose follows and handles it
    this._socket = ws;
  }

  _onMessage(msg) {
    this._lastActivity = Date.now();
    try {
      msg = JSON.parse(msg);
    } catch (e) {
      return;
    }
    switch (msg.type) {
      case "peers":
        Events.fire("peers", msg.peers);
        break;
      case "peer-joined":
        Events.fire("peer-joined", msg.peer);
        break;
      case "peer-left":
        Events.fire("peer-left", msg.peerId);
        break;
      case "signal":
        Events.fire("signal", msg);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "pong":
        break; // reply to our liveness probe; activity already recorded
      case "display-name":
        Events.fire("display-name", msg.message);
        break;
      default:
        // Any other routed message is peer traffic relayed by the server
        // (WS fallback transport, reconnect requests, ...)
        if (msg.sender) Events.fire("server-relay", msg);
    }
  }

  send(message) {
    if (!this._isConnected()) return false;
    try {
      this._socket.send(JSON.stringify(message));
      return true;
    } catch (e) {
      return false;
    }
  }

  get bufferedAmount() {
    return this._socket ? this._socket.bufferedAmount : 0;
  }

  _checkHealth() {
    if (!this._isConnected()) return;
    const silence = Date.now() - this._lastActivity;
    if (silence > 65 * 1000) {
      this._reforge();
    } else if (silence > 35 * 1000) {
      this.send({ type: "ping" });
    }
  }

  // Called when the tab wakes up: verify the socket actually works instead
  // of trusting readyState.
  _ensureAlive() {
    if (!this._isConnected()) {
      this._reconnectNow();
      return;
    }
    if (Date.now() - this._lastActivity < 35 * 1000) return;
    const before = this._lastActivity;
    this.send({ type: "ping" });
    clearTimeout(this._probeTimer);
    this._probeTimer = setTimeout(() => {
      if (this._lastActivity === before) this._reforge();
    }, 3000);
  }

  _reforge() {
    if (this._socket) {
      this._socket.onclose = null;
      try {
        this._socket.close();
      } catch (e) {}
      this._socket = null;
    }
    Events.fire("server-disconnected");
    this._reconnectNow();
  }

  _reconnectNow() {
    clearTimeout(this._reconnectTimer);
    this._reconnectAttempts = 0;
    if (this._socket && this._isConnecting()) return;
    if (this._isConnected()) return;
    this._socket = null;
    this._connect();
  }

  _disconnect() {
    if (!this._socket) return;
    this.send({ type: "disconnect" });
    this._socket.onclose = null;
    try {
      this._socket.close();
    } catch (e) {}
    this._socket = null;
  }

  _onDisconnect() {
    this._socket = null;
    Events.fire("server-disconnected");
    clearTimeout(this._reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** this._reconnectAttempts) +
      Math.floor(Math.random() * 500);
    this._reconnectAttempts = Math.min(this._reconnectAttempts + 1, 6);
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _isConnected() {
    return this._socket && this._socket.readyState === WebSocket.OPEN;
  }
  _isConnecting() {
    return this._socket && this._socket.readyState === WebSocket.CONNECTING;
  }
}

// ── Base Peer (transfer protocol, transport-agnostic) ────────────────────────

let transferCounter = 0;

class Peer {
  constructor(serverConnection, peerId) {
    this._server = serverConnection;
    this._peerId = peerId;
    this._queue = [];
    this._outgoing = null;
    this._incoming = null;
    this._lastProgressSent = 0;
    this._lastProgressFired = 0;
  }

  // ---- sending ----

  sendFiles(files) {
    this._queue.push(Array.from(files));
    if (!this._outgoing) this._dequeue();
  }

  async _dequeue() {
    const files = this._queue.shift();
    if (!files || !files.length) return;

    const transfer = {
      id: `t${Date.now()}-${transferCounter++}`,
      files,
      meta: files.map((f) => ({
        name: f.name,
        mime: f.type || "application/octet-stream",
        size: f.size,
      })),
      totalSize: files.reduce((s, f) => s + f.size, 0),
      sentBytes: 0,
      ackedBytes: 0,
      index: -1,
      cancelled: false,
      startedAt: Date.now(),
    };
    this._outgoing = transfer;

    // Ask first. No file data is read or sent until the other device says yes.
    Events.fire("transfer-pending", {
      peerId: this._peerId,
      direction: "send",
      transferId: transfer.id,
      files: transfer.meta,
      totalSize: transfer.totalSize,
      expiresAt: Date.now() + CONSENT_TIMEOUT,
    });

    this._out({
      type: "transfer-request",
      id: transfer.id,
      files: transfer.meta,
      totalSize: transfer.totalSize,
    });

    const verdict = await this._awaitConsent(transfer);
    if (verdict !== "accepted") {
      if (transfer.cancelled) return; // already reported by cancelTransfer
      // Unless the other side is the one that said no, tell it to drop the
      // request. Without this, a device whose timer never ran (a frozen
      // phone, say) would still be showing a prompt for a transfer this side
      // has already given up on.
      if (verdict !== "declined") {
        this._out({ type: "transfer-cancel", id: transfer.id, reason: verdict });
      }
      this._outgoing = null;
      Events.fire("transfer-cancelled", {
        peerId: this._peerId,
        direction: "send",
        transferId: transfer.id,
        reason: verdict,
      });
      this._dequeue();
      return;
    }

    transfer.startedAt = Date.now();
    Events.fire("transfer-started", {
      peerId: this._peerId,
      direction: "send",
      transferId: transfer.id,
      files: transfer.meta,
      totalSize: transfer.totalSize,
    });

    this._out({
      type: "transfer-start",
      id: transfer.id,
      files: transfer.meta,
      totalSize: transfer.totalSize,
    });

    try {
      for (let i = 0; i < files.length; i++) {
        if (transfer.cancelled) return;
        transfer.index = i;
        Events.fire("file-active", {
          peerId: this._peerId,
          direction: "send",
          transferId: transfer.id,
          index: i,
        });
        this._out({ type: "file-start", id: transfer.id, index: i });
        await this._streamFile(transfer, files[i], i);
        if (transfer.cancelled) return;
        this._out({ type: "file-end", id: transfer.id, index: i });
      }
      this._out({ type: "transfer-end", id: transfer.id });
      this._fireSendProgress(transfer, true);
    } catch (err) {
      if (!transfer.cancelled) {
        this._cancelOutgoing("error");
      }
    }
  }

  // Resolves with "accepted", or with the reason the transfer will not happen.
  _awaitConsent(transfer) {
    return new Promise((resolve) => {
      transfer.resolveConsent = (verdict) => {
        clearTimeout(transfer.consentTimer);
        transfer.resolveConsent = null;
        resolve(verdict);
      };
      transfer.consentTimer = setTimeout(
        () => transfer.resolveConsent && transfer.resolveConsent("no-response"),
        CONSENT_TIMEOUT + CONSENT_GRACE,
      );
    });
  }

  _onTransferResponse(msg) {
    const t = this._outgoing;
    if (!t || t.id !== msg.id || !t.resolveConsent) return;
    t.resolveConsent(msg.accepted ? "accepted" : msg.reason || "declined");
  }

  // ---- consent (receiving side) ----

  _onTransferRequest(msg) {
    // A second request while one is still pending replaces it; the sender of
    // the older one times out on its own.
    this._pendingRequest = {
      id: msg.id,
      files: msg.files || [],
      totalSize: msg.totalSize || 0,
    };
    Events.fire("transfer-request", {
      peerId: this._peerId,
      transferId: msg.id,
      files: this._pendingRequest.files,
      totalSize: this._pendingRequest.totalSize,
      expiresAt: Date.now() + CONSENT_TIMEOUT,
    });
  }

  respondToRequest(transferId, accepted, reason) {
    if (!this._pendingRequest || this._pendingRequest.id !== transferId) return;
    this._pendingRequest = null;
    if (accepted) this._acceptedTransferId = transferId;
    this._out({
      type: "transfer-response",
      id: transferId,
      accepted: !!accepted,
      reason: accepted ? undefined : reason || "declined",
    });
  }

  async _streamFile(transfer, file, index) {
    let offset = 0;
    let fileBytes = 0;
    const chunkSize = this._chunkSize();
    while (offset < file.size) {
      if (transfer.cancelled) return;
      await this._drain();
      if (transfer.cancelled) return;
      const chunk = await file
        .slice(offset, offset + chunkSize)
        .arrayBuffer();
      this._outChunk(chunk);
      offset += chunk.byteLength;
      fileBytes += chunk.byteLength;
      transfer.sentBytes += chunk.byteLength;
      transfer.fileBytes = fileBytes;
      transfer.fileSize = file.size;
      this._fireSendProgress(transfer, false);
    }
  }

  _fireSendProgress(transfer, force) {
    const now = Date.now();
    if (!force && now - this._lastProgressFired < PROGRESS_INTERVAL) return;
    this._lastProgressFired = now;
    // Subtract what still sits in the local send buffer for honest numbers
    const inFlight = this._bufferedAmount();
    const delivered = Math.max(0, transfer.sentBytes - inFlight);
    Events.fire("transfer-progress", {
      peerId: this._peerId,
      direction: "send",
      transferId: transfer.id,
      bytes: delivered,
      totalSize: transfer.totalSize,
      index: transfer.index,
      fileBytes: transfer.fileBytes || 0,
      fileSize: transfer.fileSize || 0,
    });
  }

  cancelTransfer() {
    if (this._outgoing) this._cancelOutgoing("cancelled");
    if (this._incoming) this._cancelIncoming("cancelled");
  }

  _cancelOutgoing(reason) {
    const t = this._outgoing;
    if (!t) return;
    t.cancelled = true;
    // If it is still waiting on consent, release the waiter so _dequeue does
    // not resume a transfer that has already been reported as cancelled.
    if (t.resolveConsent) t.resolveConsent(reason);
    this._out({ type: "transfer-cancel", id: t.id, reason });
    this._outgoing = null;
    Events.fire("transfer-cancelled", {
      peerId: this._peerId,
      direction: "send",
      transferId: t.id,
      reason,
    });
    this._dequeue();
  }

  _cancelIncoming(reason) {
    const t = this._incoming;
    if (!t) return;
    this._out({ type: "transfer-cancel", id: t.id, reason });
    this._incoming = null;
    this._digester = null;
    Events.fire("transfer-cancelled", {
      peerId: this._peerId,
      direction: "receive",
      transferId: t.id,
      reason,
    });
  }

  // Returns the id the receiver will acknowledge, so the UI can show whether
  // a message actually landed rather than assuming it did.
  sendText(text, broadcast = false) {
    const id = nextId("m");
    const msg = { type: "text", id, text };
    if (broadcast) msg.broadcast = true;
    this._out(msg);
    return id;
  }

  // ---- receiving ----

  _onMessage(message) {
    if (typeof message !== "string") {
      this._onChunkReceived(message);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      return;
    }
    switch (msg.type) {
      case "transfer-request":
        this._onTransferRequest(msg);
        break;
      case "transfer-response":
        this._onTransferResponse(msg);
        break;
      case "transfer-start":
        this._onTransferStart(msg);
        break;
      case "file-start":
        this._onFileStart(msg);
        break;
      case "file-end":
        this._onFileEnd(msg);
        break;
      case "file-received":
        this._onFileAck(msg);
        break;
      case "transfer-end":
        this._onTransferEnd(msg);
        break;
      case "transfer-received":
        this._onTransferReceived(msg);
        break;
      case "transfer-cancel":
        this._onRemoteCancel(msg);
        break;
      case "progress":
        this._onRemoteProgress(msg);
        break;
      case "text":
        if (msg.id) this._out({ type: "text-ack", id: msg.id });
        Events.fire("text-received", {
          id: msg.id,
          text: msg.text,
          sender: this._peerId,
          broadcast: !!msg.broadcast,
        });
        break;
      case "text-ack":
        Events.fire("text-delivered", {
          peerId: this._peerId,
          id: msg.id,
        });
        break;
      case "chunk":
        this._onChunkReceived(base64ToBuffer(msg.data));
        break;
      case "hb":
        this._out({ type: "hb-ack" });
        break;
      case "hb-ack":
        this._onHeartbeatAck();
        break;
    }
  }

  _onTransferStart(msg) {
    // Consent is enforced here, not just in the UI: a peer that skips the
    // handshake and sends transfer-start directly gets nothing.
    if (this._acceptedTransferId !== msg.id) {
      this._out({ type: "transfer-cancel", id: msg.id, reason: "declined" });
      return;
    }
    this._acceptedTransferId = null;
    this._incoming = {
      id: msg.id,
      files: msg.files,
      totalSize: msg.totalSize,
      receivedBytes: 0,
      index: -1,
      startedAt: Date.now(),
      doneCount: 0,
    };
    Events.fire("transfer-started", {
      peerId: this._peerId,
      direction: "receive",
      transferId: msg.id,
      files: msg.files,
      totalSize: msg.totalSize,
    });
  }

  _onFileStart(msg) {
    const t = this._incoming;
    if (!t || t.id !== msg.id) return;
    t.index = msg.index;
    const meta = t.files[msg.index];
    this._digester = new FileDigester(meta);
    Events.fire("file-active", {
      peerId: this._peerId,
      direction: "receive",
      transferId: t.id,
      index: msg.index,
    });
  }

  _onChunkReceived(chunk) {
    const t = this._incoming;
    if (!t || !this._digester || !chunk.byteLength) return;
    this._digester.unchunk(chunk);
    t.receivedBytes += chunk.byteLength;
    this._notifyReceiveProgress(t, false);
  }

  _notifyReceiveProgress(t, force) {
    const now = Date.now();
    if (force || now - this._lastProgressFired >= PROGRESS_INTERVAL) {
      this._lastProgressFired = now;
      Events.fire("transfer-progress", {
        peerId: this._peerId,
        direction: "receive",
        transferId: t.id,
        bytes: t.receivedBytes,
        totalSize: t.totalSize,
        index: t.index,
        fileBytes: this._digester ? this._digester.bytesReceived : 0,
        fileSize: this._digester ? this._digester.size : 0,
      });
    }
    if (force || now - this._lastProgressSent >= PROGRESS_INTERVAL * 2.5) {
      this._lastProgressSent = now;
      this._out({ type: "progress", id: t.id, bytes: t.receivedBytes });
    }
  }

  _onFileEnd(msg) {
    const t = this._incoming;
    if (!t || t.id !== msg.id || !this._digester) return;
    const meta = t.files[msg.index];
    const file = this._digester.finalize();
    this._digester = null;

    if (file.size !== meta.size) {
      this._cancelIncoming("size-mismatch");
      return;
    }

    t.doneCount++;
    this._out({ type: "file-received", id: t.id, index: msg.index });
    Events.fire("file-received", {
      // Stable across panes so a message entry can point at the same file
      id: `${t.id}-${msg.index}`,
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      blob: file.blob,
      sender: this._peerId,
      transferId: t.id,
      index: msg.index,
    });
  }

  _onFileAck(msg) {
    const t = this._outgoing;
    if (!t || t.id !== msg.id) return;
    Events.fire("file-done", {
      peerId: this._peerId,
      direction: "send",
      transferId: t.id,
      index: msg.index,
    });
  }

  _onTransferEnd(msg) {
    const t = this._incoming;
    if (!t || t.id !== msg.id) return;
    this._notifyReceiveProgress(t, true);
    this._out({ type: "transfer-received", id: t.id });
    this._incoming = null;
    Events.fire("transfer-complete", {
      peerId: this._peerId,
      direction: "receive",
      transferId: t.id,
      totalSize: t.totalSize,
      duration: Date.now() - t.startedAt,
      fileCount: t.files.length,
    });
  }

  _onTransferReceived(msg) {
    const t = this._outgoing;
    if (!t || t.id !== msg.id) return;
    this._outgoing = null;
    Events.fire("transfer-complete", {
      peerId: this._peerId,
      direction: "send",
      transferId: t.id,
      totalSize: t.totalSize,
      duration: Date.now() - t.startedAt,
      fileCount: t.files.length,
    });
    Events.fire("file-sent");
    this._dequeue();
  }

  _onRemoteCancel(msg) {
    if (this._pendingRequest && this._pendingRequest.id === msg.id) {
      this._pendingRequest = null;
      Events.fire("transfer-request-withdrawn", {
        peerId: this._peerId,
        transferId: msg.id,
      });
    }
    if (this._acceptedTransferId === msg.id) this._acceptedTransferId = null;
    if (this._outgoing && this._outgoing.id === msg.id) {
      const t = this._outgoing;
      t.cancelled = true;
      if (t.resolveConsent) t.resolveConsent(msg.reason || "remote");
      this._outgoing = null;
      Events.fire("transfer-cancelled", {
        peerId: this._peerId,
        direction: "send",
        transferId: t.id,
        reason: msg.reason || "remote",
      });
      this._dequeue();
    }
    if (this._incoming && this._incoming.id === msg.id) {
      const t = this._incoming;
      this._incoming = null;
      this._digester = null;
      Events.fire("transfer-cancelled", {
        peerId: this._peerId,
        direction: "receive",
        transferId: t.id,
        reason: msg.reason || "remote",
      });
    }
  }

  _onRemoteProgress(msg) {
    const t = this._outgoing;
    if (!t || t.id !== msg.id) return;
    t.ackedBytes = msg.bytes;
    Events.fire("transfer-progress", {
      peerId: this._peerId,
      direction: "send",
      transferId: t.id,
      bytes: msg.bytes,
      totalSize: t.totalSize,
      index: t.index,
      fileBytes: t.fileBytes || 0,
      fileSize: t.fileSize || 0,
      confirmed: true,
    });
  }

  _onHeartbeatAck() {} // overridden by RTCPeer

  // ---- transport interface (overridden) ----

  _out(obj) {}
  _outChunk(buffer) {}
  _bufferedAmount() {
    return 0;
  }
  _chunkSize() {
    return CHUNK_SIZE;
  }
  async _drain() {}

  // If a transfer dies with the connection, surface it instead of spinning
  _failActiveTransfers() {
    if (this._pendingRequest) {
      const id = this._pendingRequest.id;
      this._pendingRequest = null;
      Events.fire("transfer-request-withdrawn", {
        peerId: this._peerId,
        transferId: id,
      });
    }
    this._acceptedTransferId = null;
    if (this._outgoing) {
      const t = this._outgoing;
      t.cancelled = true;
      if (t.resolveConsent) t.resolveConsent("connection-lost");
      this._outgoing = null;
      Events.fire("transfer-cancelled", {
        peerId: this._peerId,
        direction: "send",
        transferId: t.id,
        reason: "connection-lost",
      });
    }
    if (this._incoming) {
      const t = this._incoming;
      this._incoming = null;
      this._digester = null;
      Events.fire("transfer-cancelled", {
        peerId: this._peerId,
        direction: "receive",
        transferId: t.id,
        reason: "connection-lost",
      });
    }
  }
}

// ── RTCPeer ──────────────────────────────────────────────────────────────────

class RTCPeer extends Peer {
  static config = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ],
  };

  constructor(serverConnection, peerId, isCaller) {
    super(serverConnection, peerId);
    this._isCaller = !!isCaller;
    this._heartbeatTimer = null;
    this._missedBeats = 0;
    this._graceTimer = null;
    if (isCaller) this._start();
  }

  _start() {
    this._openConnection();
    this._openChannel();
  }

  _openConnection() {
    this._negotiationStartedAt = Date.now();
    this._conn = new RTCPeerConnection(RTCPeer.config);
    this._conn.onicecandidate = (e) => {
      if (e.candidate) this._sendSignal({ ice: e.candidate });
    };
    this._conn.onconnectionstatechange = () => this._onStateChange();
    this._conn.ondatachannel = (e) => this._onChannelOpened(e.channel);
  }

  _openChannel() {
    const ch = this._conn.createDataChannel("drpl", { ordered: true });
    ch.onopen = () => this._onChannelOpened(ch);
    this._conn
      .createOffer()
      .then((d) => this._onDescription(d))
      .catch((e) => this._onError(e));
  }

  _onDescription(description) {
    this._conn
      .setLocalDescription(description)
      .then(() => this._sendSignal({ sdp: description }))
      .catch((e) => this._onError(e));
  }

  onServerMessage(message) {
    if (!this._conn) this._openConnection();
    if (message.sdp) {
      this._conn
        .setRemoteDescription(message.sdp)
        .then(() => {
          if (message.sdp.type === "offer") {
            return this._conn
              .createAnswer()
              .then((d) => this._onDescription(d));
          }
        })
        .catch((e) => this._onError(e));
    } else if (message.ice) {
      this._conn.addIceCandidate(message.ice).catch(() => {});
    }
  }

  _onChannelOpened(channel) {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.onmessage = (e) => {
      this._missedBeats = 0;
      this._onMessage(e.data);
    };
    channel.onclose = () => this._onChannelClosed();
    channel.onerror = () => {};
    this._channel = channel;
    this._useRelay = false;
    this._missedBeats = 0;
    this._startHeartbeat();
    Events.fire("peer-connection-changed", {
      peerId: this._peerId,
      connected: true,
      transport: "rtc",
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this._isOpen()) return;
      // Skip while a transfer is running: flowing data is proof of life
      if (this._outgoing || this._incoming) return;
      this._missedBeats++;
      if (this._missedBeats > 3) {
        this._teardown();
        this.refresh();
        return;
      }
      this._out({ type: "hb" });
    }, 10 * 1000);
  }

  _onHeartbeatAck() {
    this._missedBeats = 0;
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _onChannelClosed() {
    const hadChannel = !!this._channel;
    this._teardown();
    if (hadChannel && this._isCaller) this.refresh();
  }

  _onStateChange() {
    if (!this._conn) return;
    const state = this._conn.connectionState;
    if (state === "failed") {
      this._teardown();
      this.refresh();
    } else if (state === "disconnected") {
      // Often self-heals (brief radio sleep); give it a grace period
      clearTimeout(this._graceTimer);
      this._graceTimer = setTimeout(() => {
        if (this._conn && this._conn.connectionState === "disconnected") {
          this._teardown();
          this.refresh();
        }
      }, 5000);
    } else if (state === "connected") {
      clearTimeout(this._graceTimer);
    }
  }

  _teardown() {
    this._stopHeartbeat();
    this._failActiveTransfers();
    if (this._channel) {
      this._channel.onclose = null;
      this._channel.onmessage = null;
      try {
        this._channel.close();
      } catch (e) {}
      this._channel = null;
    }
    if (this._conn) {
      this._conn.ondatachannel = null;
      this._conn.onconnectionstatechange = null;
      this._conn.onicecandidate = null;
      try {
        this._conn.close();
      } catch (e) {}
      this._conn = null;
    }
    Events.fire("peer-connection-changed", {
      peerId: this._peerId,
      connected: false,
      transport: "rtc",
    });
  }

  refresh() {
    if (this._isOpen()) return;
    if (this._isConnecting()) {
      // A negotiation whose signaling was lost (offer sent into a dead
      // socket) would stay "connecting" forever. Give it 6s, then restart.
      const age = Date.now() - (this._negotiationStartedAt || 0);
      if (age < 6000) return;
      this._teardown();
    }
    if (this._isCaller) {
      this._start();
    } else {
      // Only the caller can renegotiate under our convention; ask for it
      this._server.send({ type: "reconnect-request", to: this._peerId });
    }
  }

  // Wait (bounded) for the channel to come up before a send begins
  _readyForTransfer(timeoutMs = 8000) {
    if (this._isOpen()) return Promise.resolve(true);
    this.refresh();
    return new Promise((resolve) => {
      const started = Date.now();
      let lastNudge = Date.now();
      const poll = setInterval(() => {
        if (this._isOpen()) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          resolve(false);
        } else if (Date.now() - lastNudge > 2000) {
          // refresh() is guarded; this only re-sends lost reconnect
          // requests or restarts a stale negotiation
          lastNudge = Date.now();
          this.refresh();
        }
      }, 150);
    });
  }

  async sendFiles(files) {
    const ready = await this._readyForTransfer();
    if (!ready) {
      // WebRTC blocked (VPN, firewall, cross-client): fall back to relaying
      // through the server. Slower, but it works.
      this._useRelay = true;
      Events.fire("peer-connection-changed", {
        peerId: this._peerId,
        connected: true,
        transport: "ws",
      });
    }
    super.sendFiles(files);
  }

  _isOpen() {
    return !!this._channel && this._channel.readyState === "open";
  }
  _isConnecting() {
    return (
      (this._channel && this._channel.readyState === "connecting") ||
      (this._conn &&
        !this._channel &&
        ["new", "connecting"].includes(this._conn.connectionState))
    );
  }

  _sendSignal(signal) {
    signal.type = "signal";
    signal.to = this._peerId;
    this._server.send(signal);
  }

  // ---- transport implementation ----

  _out(obj) {
    if (this._isOpen() && !this._useRelay) {
      try {
        this._channel.send(JSON.stringify(obj));
        return;
      } catch (e) {}
    }
    obj.to = this._peerId;
    this._server.send(obj);
  }

  _outChunk(buffer) {
    if (this._isOpen() && !this._useRelay) {
      this._channel.send(buffer);
      return;
    }
    this._server.send({
      type: "chunk",
      to: this._peerId,
      data: bufferToBase64(buffer),
    });
  }

  _bufferedAmount() {
    if (this._isOpen() && !this._useRelay) return this._channel.bufferedAmount;
    return this._server.bufferedAmount;
  }

  // Chromium peers negotiate 256 KiB SCTP messages; use them when offered.
  // Falls back to the universally safe 64 KiB.
  _chunkSize() {
    if (this._isOpen() && !this._useRelay && this._conn && this._conn.sctp) {
      const max = this._conn.sctp.maxMessageSize;
      if (Number.isFinite(max) && max >= CHUNK_SIZE) {
        return Math.min(max, 256 * 1024);
      }
    }
    return CHUNK_SIZE;
  }

  _drain() {
    if (this._isOpen() && !this._useRelay) {
      const ch = this._channel;
      if (ch.bufferedAmount <= HIGH_WATER) return Promise.resolve();
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          ch.removeEventListener("bufferedamountlow", done);
          clearInterval(poll);
          resolve();
        };
        ch.addEventListener("bufferedamountlow", done);
        // Safety net: some engines are stingy with bufferedamountlow
        const poll = setInterval(() => {
          if (ch.bufferedAmount <= LOW_WATER || ch.readyState !== "open")
            done();
        }, 100);
      });
    }
    return drainWebSocket(this._server);
  }

  destroy() {
    clearTimeout(this._graceTimer);
    this._teardown();
  }
}

// ── WSPeer (no WebRTC at all) ────────────────────────────────────────────────

class WSPeer extends Peer {
  _out(obj) {
    obj.to = this._peerId;
    this._server.send(obj);
  }
  _outChunk(buffer) {
    this._server.send({
      type: "chunk",
      to: this._peerId,
      data: bufferToBase64(buffer),
    });
  }
  _bufferedAmount() {
    return this._server.bufferedAmount;
  }
  _drain() {
    return drainWebSocket(this._server);
  }
  refresh() {}
  destroy() {
    this._failActiveTransfers();
  }
}

function drainWebSocket(server) {
  if (server.bufferedAmount <= WS_HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (server.bufferedAmount <= WS_HIGH_WATER / 4) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });
}

// ── base64 helpers (relay fallback) ──────────────────────────────────────────

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.toBase64) return bytes.toBase64();
  let binary = "";
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBuffer(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64).buffer;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── FileDigester ─────────────────────────────────────────────────────────────

// Assembles incoming chunks. Chunks are periodically consolidated into a Blob
// so the browser can move data out of JS heap memory (Chromium spills large
// blobs to disk) - this is what lets big files land on phones.
class FileDigester {
  constructor(meta) {
    this._parts = [];
    this._partsBytes = 0;
    this.bytesReceived = 0;
    this.size = meta.size;
    this.mime = meta.mime || "application/octet-stream";
    this.name = meta.name;
    this._consolidateThreshold = 32 * 1024 * 1024;
  }

  unchunk(chunk) {
    this._parts.push(chunk);
    this._partsBytes += chunk.byteLength;
    this.bytesReceived += chunk.byteLength;
    if (this._partsBytes >= this._consolidateThreshold) {
      this._parts = [new Blob(this._parts, { type: this.mime })];
      this._partsBytes = 0;
    }
  }

  finalize() {
    const blob = new Blob(this._parts, { type: this.mime });
    this._parts = [];
    return { name: this.name, mime: this.mime, size: blob.size, blob };
  }
}

// ── PeersManager ─────────────────────────────────────────────────────────────

class PeersManager {
  constructor(serverConnection) {
    this.peers = {};
    this._server = serverConnection;
    Events.on("signal", (e) => this._onSignal(e.detail));
    Events.on("server-relay", (e) => this._onRelay(e.detail));
    Events.on("peers", (e) => this._onPeers(e.detail));
    Events.on("peer-joined", (e) => this._onPeerJoined(e.detail));
    Events.on("files-selected", (e) => this._onFilesSelected(e.detail));
    Events.on("send-text", (e) => this._onSendText(e.detail));
    Events.on("peer-left", (e) => this._onPeerLeft(e.detail));
    Events.on("cancel-transfer", (e) => this._onCancelTransfer(e.detail));
    Events.on("respond-to-transfer", (e) => this._onRespond(e.detail));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.refreshAllPeers();
    });
    // Maintenance sweep: a no-op for healthy peers, drives reconnection for
    // broken ones (refresh() is internally guarded against spam).
    setInterval(() => this.refreshAllPeers(), 5000);
  }

  _getOrCreate(peerId, isCaller) {
    if (!this.peers[peerId]) {
      this.peers[peerId] = window.RTCPeerConnection
        ? new RTCPeer(this._server, peerId, isCaller)
        : new WSPeer(this._server, peerId);
    }
    return this.peers[peerId];
  }

  _onSignal(message) {
    const peer = this._getOrCreate(message.sender, false);
    if (peer.onServerMessage) peer.onServerMessage(message);
  }

  _onRelay(message) {
    if (message.type === "reconnect-request") {
      // The other side lost its channel and cannot make offers (it was the
      // callee). Reconnect as caller, creating the peer if we lost it.
      let peer = this.peers[message.sender];
      if (!peer && window.RTCPeerConnection) {
        peer = this.peers[message.sender] = new RTCPeer(
          this._server,
          message.sender,
          true,
        );
        return;
      }
      if (peer && peer.refresh) peer.refresh();
      return;
    }
    // Relayed peer traffic (fallback transport) goes through the same
    // protocol handler as data channel messages.
    const peer = this._getOrCreate(message.sender, false);
    const { sender, ...payload } = message;
    peer._onMessage(JSON.stringify(payload));
  }

  // A device that just joined is registered immediately, as callee: by
  // convention the newcomer makes the offer, and it already has us in the
  // "peers" list it received. Without this the peer object only appeared once
  // the newcomer signalled - so clicking a freshly listed device raced against
  // its offer, and a newcomer with no WebRTC (which never signals) could never
  // be sent anything at all.
  _onPeerJoined(info) {
    if (!info || this.peers[info.id]) return;
    this.peers[info.id] =
      window.RTCPeerConnection && info.rtcSupported
        ? new RTCPeer(this._server, info.id, false)
        : new WSPeer(this._server, info.id);
  }

  _onPeers(peers) {
    const seen = new Set();
    peers.forEach((info) => {
      seen.add(info.id);
      if (this.peers[info.id]) {
        this.peers[info.id].refresh();
        return;
      }
      if (window.RTCPeerConnection && info.rtcSupported) {
        this.peers[info.id] = new RTCPeer(this._server, info.id, true);
      } else {
        this.peers[info.id] = new WSPeer(this._server, info.id);
      }
    });
    // Reconciliation: drop peers the server no longer knows about, so stale
    // objects don't hold dead connections open forever.
    for (const id of Object.keys(this.peers)) {
      if (!seen.has(id)) this._onPeerLeft(id);
    }
  }

  _onFilesSelected(message) {
    const peer = this.peers[message.to];
    if (!peer) {
      Events.fire("notify-user", "That device is no longer available.");
      return;
    }
    peer.sendFiles(message.files);
  }

  _onSendText(message) {
    // to: "*" broadcasts to every connected device (the group conversation)
    if (message.to === "*") {
      const ids = Object.keys(this.peers);
      if (!ids.length) return;
      const messageIds = ids.map((id) =>
        this.peers[id].sendText(message.text, true),
      );
      Events.fire("text-sent", {
        to: "*",
        localId: message.localId,
        messageIds,
        recipients: ids.length,
      });
      return;
    }
    const peer = this.peers[message.to];
    if (!peer) return;
    const id = peer.sendText(message.text, !!message.broadcast);
    Events.fire("text-sent", {
      to: message.to,
      localId: message.localId,
      messageIds: [id],
      recipients: 1,
    });
  }

  _onCancelTransfer(peerId) {
    const peer = this.peers[peerId];
    if (peer) peer.cancelTransfer();
  }

  _onRespond({ peerId, transferId, accepted, reason }) {
    const peer = this.peers[peerId];
    if (peer) peer.respondToRequest(transferId, accepted, reason);
  }

  _onPeerLeft(peerId) {
    const peer = this.peers[peerId];
    if (!peer) return;
    if (peer.destroy) peer.destroy();
    delete this.peers[peerId];
  }

  refreshAllPeers() {
    for (const id in this.peers) {
      if (this.peers[id].refresh) this.peers[id].refresh();
    }
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const server = new ServerConnection();
  const peers = new PeersManager(server);
  window.drplNetwork = { server, peers };
});
