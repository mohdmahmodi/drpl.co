/**
 * drpl.co - Network Javascript
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

// ── Server Connection ────────────────────────────────────────────────────────

class ServerConnection {
  constructor() {
    this._socket = null;
    this._reconnectTimer = null;
    this._connect();
    Events.on("beforeunload", () => this._disconnect());
    Events.on("pagehide", () => this._disconnect());
    document.addEventListener("visibilitychange", () =>
      this._onVisibilityChange(),
    );
  }

  _connect() {
    clearTimeout(this._reconnectTimer);
    if (this._isConnected() || this._isConnecting()) return;
    const ws = new WebSocket(this._endpoint());
    ws.binaryType = "arraybuffer";
    ws.onopen = () => console.log("Server connected");
    ws.onmessage = (e) => this._onMessage(e.data);
    ws.onclose = () => this._onDisconnect();
    ws.onerror = (e) => console.error("WS error:", e);
    this._socket = ws;
  }

  _onMessage(msg) {
    try {
      msg = JSON.parse(msg);
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
        case "display-name":
          Events.fire("display-name", msg.message);
          break;
        default:
          console.error("Unknown message type:", msg.type);
      }
    } catch (e) {
      console.error("Error processing message:", e);
    }
  }

  send(message) {
    if (!this._isConnected()) return;
    this._socket.send(JSON.stringify(message));
  }

  _endpoint() {
    const protocol = location.protocol.startsWith("https") ? "wss" : "ws";
    const webrtc = window.RTCPeerConnection ? "/webrtc" : "/fallback";
    return `${protocol}://${location.host}/server${webrtc}`;
  }

  _disconnect() {
    if (!this._socket) return;
    this.send({ type: "disconnect" });
    this._socket.onclose = null;
    this._socket.close();
  }

  _onDisconnect() {
    Events.fire("notify-user", "Connection lost. Reconnecting in 5 seconds...");
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connect(), 5000);
  }

  _onVisibilityChange() {
    if (!document.hidden) this._connect();
  }
  _isConnected() {
    return this._socket && this._socket.readyState === WebSocket.OPEN;
  }
  _isConnecting() {
    return this._socket && this._socket.readyState === WebSocket.CONNECTING;
  }
}

// ── Base Peer ────────────────────────────────────────────────────────────────

class Peer {
  constructor(serverConnection, peerId) {
    this._server = serverConnection;
    this._peerId = peerId;
    this._filesQueue = [];
    this._busy = false;
  }

  sendJSON(message) {
    this._send(JSON.stringify(message));
  }

  sendFiles(files) {
    for (let i = 0; i < files.length; i++) this._filesQueue.push(files[i]);
    if (!this._busy) this._dequeueFile();
  }

  _dequeueFile() {
    if (!this._filesQueue.length) return;
    this._busy = true;
    this._sendFile(this._filesQueue.shift());
  }

  _sendFile(file) {
    this.sendJSON({
      type: "header",
      name: file.name,
      mime: file.type,
      size: file.size,
    });
    this._chunker = new FileChunker(
      file,
      (chunk) => {
        this._send(chunk);
        // FIX: Fire sender-side progress so the UI can track speed
        Events.fire("file-send-progress", {
          to: this._peerId,
          progress: this._chunker.progress,
          bytesTransferred: this._chunker._offset,
        });
      },
      (offset) => this._onPartitionEnd(offset),
    );
    this._chunker.nextPartition();
  }

  _onPartitionEnd(offset) {
    this.sendJSON({ type: "partition", offset });
  }
  _onReceivedPartitionEnd(msg) {
    this.sendJSON({ type: "partition-received", offset: msg.offset });
  }
  _sendNextPartition() {
    if (this._chunker && !this._chunker.isFileEnd())
      this._chunker.nextPartition();
  }
  _sendProgress(progress) {
    this.sendJSON({ type: "progress", progress });
  }

  _onMessage(message) {
    if (typeof message !== "string") {
      this._onChunkReceived(message);
      return;
    }
    try {
      message = JSON.parse(message);
      switch (message.type) {
        case "header":
          this._onFileHeader(message);
          break;
        case "partition":
          this._onReceivedPartitionEnd(message);
          break;
        case "partition-received":
          this._sendNextPartition();
          break;
        case "progress":
          this._onDownloadProgress(message.progress);
          break;
        case "transfer-complete":
          this._onTransferCompleted();
          break;
        case "text":
          this._onTextReceived(message);
          break;
        case "heartbeat":
          this.sendJSON({ type: "heartbeat-ack" });
          break;
        case "heartbeat-ack":
          break;
      }
    } catch (e) {
      console.error("Error processing peer message:", e);
    }
  }

  _onFileHeader(header) {
    this._lastProgress = 0;
    if (header.size === 0) {
      const emptyBlob = new Blob([], {
        type: header.mime || "application/octet-stream",
      });
      Events.fire("file-receive-start", { header, from: this._peerId });
      Events.fire("file-received", {
        name: header.name,
        mime: header.mime || "application/octet-stream",
        size: 0,
        blob: emptyBlob,
        sender: this._peerId,
      });
      this.sendJSON({ type: "transfer-complete" });
      return;
    }
    this._digester = new FileDigester(
      {
        name: header.name,
        mime: header.mime,
        size: header.size,
        sender: this._peerId,
      },
      (file) => this._onFileReceived(file),
    );
    Events.fire("file-receive-start", { header, from: this._peerId });
  }

  _onChunkReceived(chunk) {
    if (!chunk.byteLength || !this._digester) return;
    this._digester.unchunk(chunk);
    const progress = this._digester.progress;
    const bytesTransferred = Math.floor(progress * this._digester._size);
    this._onDownloadProgress(progress, bytesTransferred);
    if (progress - this._lastProgress < 0.01) return;
    this._lastProgress = progress;
    this._sendProgress(progress);
  }

  _onDownloadProgress(progress, bytesTransferred = 0) {
    Events.fire("file-progress", {
      sender: this._peerId,
      progress,
      bytesTransferred: Math.max(0, bytesTransferred),
    });
  }

  _onFileReceived(proxyFile) {
    Events.fire("file-received", proxyFile);
    this.sendJSON({ type: "transfer-complete" });
    Events.fire("file-transfer-complete");
  }

  _onTransferCompleted() {
    this._onDownloadProgress(1);
    this._busy = false;
    this._dequeueFile();
    Events.fire("notify-user", "File transfer completed.");
    Events.fire("file-transfer-complete");
  }

  sendText(text) {
    this.sendJSON({
      type: "text",
      text: btoa(unescape(encodeURIComponent(text))),
    });
  }

  _onTextReceived(message) {
    Events.fire("text-received", {
      text: decodeURIComponent(escape(atob(message.text))),
      sender: this._peerId,
    });
  }
}

// ── RTCPeer ──────────────────────────────────────────────────────────────────

class RTCPeer extends Peer {
  constructor(serverConnection, peerId) {
    super(serverConnection, peerId);
    this._heartbeatInterval = null;
    if (!peerId) return;
    this._connect(peerId, true);
  }

  static config = {
    sdpSemantics: "unified-plan",
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };

  _connect(peerId, isCaller) {
    if (!this._conn) this._openConnection(peerId, isCaller);
    if (isCaller) this._openChannel();
    else this._conn.ondatachannel = (e) => this._onChannelOpened(e);
  }

  _openConnection(peerId, isCaller) {
    this._isCaller = isCaller;
    this._peerId = peerId;
    this._conn = new RTCPeerConnection(RTCPeer.config);
    this._conn.onicecandidate = (e) => this._onIceCandidate(e);
    this._conn.onconnectionstatechange = () => this._onConnectionStateChange();
    this._conn.oniceconnectionstatechange = () =>
      this._onIceConnectionStateChange();
  }

  _openChannel() {
    const ch = this._conn.createDataChannel("data-channel", { ordered: true });
    ch.onopen = (e) => this._onChannelOpened(e);
    this._conn
      .createOffer()
      .then((d) => this._onDescription(d))
      .catch((e) => this._onError(e));
  }

  _onDescription(d) {
    this._conn
      .setLocalDescription(d)
      .then(() => this._sendSignal({ sdp: d }))
      .catch((e) => this._onError(e));
  }

  _onIceCandidate(e) {
    if (e.candidate) this._sendSignal({ ice: e.candidate });
  }

  onServerMessage(message) {
    if (!this._conn) this._connect(message.sender, false);
    if (message.sdp) {
      this._conn
        .setRemoteDescription(new RTCSessionDescription(message.sdp))
        .then(() =>
          message.sdp.type === "offer"
            ? this._conn.createAnswer().then((d) => this._onDescription(d))
            : null,
        )
        .catch((e) => this._onError(e));
    } else if (message.ice) {
      this._conn
        .addIceCandidate(new RTCIceCandidate(message.ice))
        .catch((e) => this._onError(e));
    }
  }

  _onChannelOpened(event) {
    const ch = event.channel || event.target;
    ch.binaryType = "arraybuffer";
    ch.onmessage = (e) => this._onMessage(e.data);
    ch.onclose = () => this._onChannelClosed();
    this._channel = ch;
    this._startHeartbeat();
    Events.fire("peer-connection-established", this._peerId);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      if (this._isConnected()) this.sendJSON({ type: "heartbeat" });
      else if (!this._isConnecting()) this.refresh();
    }, 10000);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  _onChannelClosed() {
    this._stopHeartbeat();
    if (this._isCaller) this._connect(this._peerId, true);
  }

  _onConnectionStateChange() {
    if (this._conn.connectionState === "disconnected") this._onChannelClosed();
    else if (this._conn.connectionState === "failed") {
      this._conn = null;
      this._onChannelClosed();
    }
  }

  _onIceConnectionStateChange() {
    if (this._conn.iceConnectionState === "failed") console.error("ICE failed");
  }

  _onError(e) {
    console.error("RTCPeer error:", e);
  }

  _send(message) {
    if (!this._channel) return this.refresh();
    this._channel.send(message);
  }
  _sendSignal(signal) {
    signal.type = "signal";
    signal.to = this._peerId;
    this._server.send(signal);
  }
  refresh() {
    if (!this._isConnected() && !this._isConnecting())
      this._connect(this._peerId, this._isCaller);
  }
  _isConnected() {
    return this._channel && this._channel.readyState === "open";
  }
  _isConnecting() {
    return this._channel && this._channel.readyState === "connecting";
  }

  destroy() {
    this._stopHeartbeat();
    if (this._channel) {
      this._channel.onclose = null;
      this._channel.close();
    }
    if (this._conn) {
      this._conn.close();
      this._conn = null;
    }
  }
}

// ── WSPeer ───────────────────────────────────────────────────────────────────

class WSPeer extends Peer {
  constructor(serverConnection, peerId) {
    super(serverConnection, peerId);
  }
  _send(message) {
    message.to = this._peerId;
    this._server.send(message);
  }
  refresh() {
    if (this._server) this._server._connect();
  }
}

// ── PeersManager ─────────────────────────────────────────────────────────────

class PeersManager {
  constructor(serverConnection) {
    this.peers = {};
    this._server = serverConnection;
    Events.on("signal", (e) => this._onMessage(e.detail));
    Events.on("peers", (e) => this._onPeers(e.detail));
    Events.on("files-selected", (e) => this._onFilesSelected(e.detail));
    Events.on("send-text", (e) => this._onSendText(e.detail));
    Events.on("peer-left", (e) => this._onPeerLeft(e.detail));
  }

  _onMessage(message) {
    if (!this.peers[message.sender])
      this.peers[message.sender] = new RTCPeer(this._server);
    this.peers[message.sender].onServerMessage(message);
  }

  _onPeers(peers) {
    peers.forEach((peer) => {
      if (this.peers[peer.id]) {
        this.peers[peer.id].refresh();
        return;
      }
      this.peers[peer.id] =
        window.RTCPeerConnection && peer.rtcSupported
          ? new RTCPeer(this._server, peer.id)
          : new WSPeer(this._server, peer.id);
    });
  }

  _onFilesSelected(message) {
    Events.fire("file-send-start", { files: message.files, to: message.to });
    this.peers[message.to].sendFiles(message.files);
  }

  _onSendText(message) {
    this.peers[message.to].sendText(message.text);
  }

  _onPeerLeft(peerId) {
    const peer = this.peers[peerId];
    if (!peer) return;
    if (peer.destroy) peer.destroy();
    else if (peer._conn) peer._conn.close();
    delete this.peers[peerId];
  }

  refreshAllPeers() {
    for (const id in this.peers)
      if (this.peers[id].refresh) this.peers[id].refresh();
  }
}

// ── FileChunker ──────────────────────────────────────────────────────────────

class FileChunker {
  constructor(file, onChunk, onPartitionEnd) {
    this._chunkSize = 64000;
    this._maxPartitionSize = 1e6;
    this._offset = 0;
    this._partitionSize = 0;
    this._file = file;
    this._onChunk = onChunk;
    this._onPartitionEnd = onPartitionEnd;
    this._reader = new FileReader();
    this._reader.addEventListener("load", (e) =>
      this._onChunkRead(e.target.result),
    );
  }

  nextPartition() {
    this._partitionSize = 0;
    this._readChunk();
  }

  _readChunk() {
    this._reader.readAsArrayBuffer(
      this._file.slice(this._offset, this._offset + this._chunkSize),
    );
  }

  _onChunkRead(chunk) {
    this._offset += chunk.byteLength;
    this._partitionSize += chunk.byteLength;
    this._onChunk(chunk);
    if (this.isFileEnd()) return;
    if (this._isPartitionEnd()) {
      this._onPartitionEnd(this._offset);
      return;
    }
    this._readChunk();
  }

  _isPartitionEnd() {
    return this._partitionSize >= this._maxPartitionSize;
  }
  isFileEnd() {
    return this._offset >= this._file.size;
  }
  get progress() {
    return this._offset / this._file.size;
  }
}

// ── FileDigester ─────────────────────────────────────────────────────────────

class FileDigester {
  constructor(meta, callback) {
    this._buffer = [];
    this._bytesReceived = 0;
    this._size = meta.size;
    this._mime = meta.mime || "application/octet-stream";
    this._name = meta.name;
    this._sender = meta.sender;
    this._callback = callback;
    this.progress = 0;
    this._consolidateThreshold = 50 * 1024 * 1024;
    this._bufferSize = 0;
  }

  unchunk(chunk) {
    this._buffer.push(chunk);
    this._bytesReceived += chunk.byteLength || chunk.size;
    this._bufferSize += chunk.byteLength || chunk.size;
    this.progress = this._size > 0 ? this._bytesReceived / this._size : 1;

    if (this._bufferSize >= this._consolidateThreshold) {
      this._buffer = [new Blob(this._buffer, { type: this._mime })];
      this._bufferSize = 0;
    }

    if (this._bytesReceived < this._size) return;
    const blob = new Blob(this._buffer, { type: this._mime });
    this._buffer = [];
    this._callback({
      name: this._name,
      mime: this._mime,
      size: this._size,
      blob,
      sender: this._sender,
    });
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const server = new ServerConnection();
  const peers = new PeersManager(server);
  window.drplNetwork = { server, peers };
});
