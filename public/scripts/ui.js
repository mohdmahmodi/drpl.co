/**
 * drpl.co - UI controller (dashboard)
 *
 * Sidebar lists devices. The main area has three panes:
 *   Transfers - live progress, real throughput chart, transfer internals,
 *               session totals and history
 *   Files     - gallery of everything received, with previews (incl. text
 *               files) and saving
 *   Messages  - conversations per device plus an Everyone group; text,
 *               links and file events; persisted to localStorage
 *
 * Every indicator is bound to real state from network.js events. Nothing
 * here invents data (see ai-generated-ui-things-to-avoid.md, rule 4).
 */

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

const isURL = (text) => /^((https?:\/\/|www)[^\s]+)$/i.test(text.trim());
const isImageURL = (url) =>
  /\.(jpe?g|png|gif|webp|svg|bmp|avif)(\?.*)?$/i.test(url);

const TEXT_PREVIEW_EXT =
  /\.(txt|md|markdown|html?|css|js|mjs|ts|jsx|tsx|json|xml|ya?ml|csv|tsv|log|sh|py|rb|go|rs|c|h|cpp|java|sql|toml|ini|env|conf)$/i;

function isTextPreviewable(file) {
  if (file.mime && file.mime.startsWith("text/")) return true;
  if (
    file.mime &&
    /(json|javascript|xml|yaml|x-sh|x-python|markdown)/.test(file.mime)
  )
    return true;
  return TEXT_PREVIEW_EXT.test(file.name || "");
}

function makeIcon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function deviceIconName(type) {
  if (type === "mobile") return "smartphone";
  if (type === "tablet") return "tablet";
  return "monitor";
}

function fileIconName(mime = "") {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "film";
  if (mime.startsWith("audio/")) return "music";
  if (
    mime.includes("zip") ||
    mime.includes("compressed") ||
    mime.includes("archive") ||
    mime.includes("tar")
  )
    return "archive";
  if (
    mime.startsWith("text/") ||
    mime.includes("pdf") ||
    mime.includes("document") ||
    mime.includes("word") ||
    mime.includes("sheet") ||
    mime.includes("presentation") ||
    mime.includes("json") ||
    mime.includes("javascript") ||
    mime.includes("xml")
  )
    return "file-text";
  return "file";
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatSpeed(bps) {
  if (!bps || bps < 1) return "0 B/s";
  if (bps < 1048576) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1048576).toFixed(1)} MB/s`;
}

function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Motion (GSAP with CSS fallback; never animates hidden tabs) ──────────────

const Motion = {
  get ok() {
    const ok =
      !!window.gsap &&
      document.visibilityState === "visible" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.documentElement.classList.toggle("no-gsap", !window.gsap);
    return ok;
  },

  _ensureFinished(tween, ms) {
    setTimeout(() => {
      if (tween && tween.isActive()) tween.progress(1);
    }, ms);
  },

  rowIn(el, index = 0) {
    if (!this.ok) return;
    gsap.fromTo(
      el,
      { y: 6, autoAlpha: 0 },
      {
        y: 0,
        autoAlpha: 1,
        duration: 0.25,
        delay: index * 0.03,
        ease: "power2.out",
        clearProps: "all",
      },
    );
  },

  rowOut(el, done) {
    if (!this.ok) {
      done();
      return;
    }
    this._ensureFinished(
      gsap.to(el, {
        autoAlpha: 0,
        duration: 0.15,
        ease: "power2.in",
        onComplete: done,
      }),
      350,
    );
  },

  paneIn(el) {
    if (!this.ok) return;
    gsap.fromTo(
      el,
      { y: 6, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.22, ease: "power2.out", clearProps: "all" },
    );
  },

  pop(el) {
    if (!this.ok) return;
    gsap.fromTo(
      el,
      { scale: 0.6 },
      { scale: 1, duration: 0.35, ease: "back.out(1.8)", clearProps: "scale" },
    );
  },

  pulse(el) {
    if (!this.ok) return;
    gsap.fromTo(
      el,
      { scale: 0.97 },
      { scale: 1, duration: 0.25, ease: "power2.out", clearProps: "scale" },
    );
  },
};

// ── Toasts (Toastify-js with built-in fallback) ──────────────────────────────

const Toast = {
  show(message, { icon = "info", tone = "", duration = 3200 } = {}) {
    if (window.Toastify) {
      const node = document.createElement("div");
      node.style.display = "contents";
      const iconWrap = document.createElement("span");
      iconWrap.className = `toast-icon${tone ? ` ${tone}` : ""}`;
      iconWrap.appendChild(makeIcon(icon));
      const text = document.createElement("span");
      text.className = "toast-text";
      text.textContent = message;
      node.append(iconWrap, text);
      Toastify({
        node,
        duration,
        gravity: "bottom",
        position: "center",
        offset: { x: 0, y: 12 },
        close: false,
        stopOnFocus: true,
      }).showToast();
      return;
    }
    const t = $("toast");
    if (!t) return;
    t.textContent = message;
    t.classList.add("active");
    clearTimeout(this._fallbackTimer);
    this._fallbackTimer = setTimeout(
      () => t.classList.remove("active"),
      duration,
    );
  },
};

// ── Wake lock: keep the screen on while a transfer runs ──────────────────────

const WakeLock = {
  _lock: null,
  _wanted: false,

  async acquire() {
    this._wanted = true;
    if (!("wakeLock" in navigator) || this._lock) return;
    try {
      this._lock = await navigator.wakeLock.request("screen");
      this._lock.addEventListener("release", () => {
        this._lock = null;
        if (this._wanted && document.visibilityState === "visible")
          this.acquire();
      });
    } catch (e) {
      /* not critical */
    }
  },

  release() {
    this._wanted = false;
    if (this._lock) {
      this._lock.release().catch(() => {});
      this._lock = null;
    }
  },

  init() {
    document.addEventListener("visibilitychange", () => {
      if (
        this._wanted &&
        !this._lock &&
        document.visibilityState === "visible"
      ) {
        this.acquire();
      }
    });
  },
};

// ── Throughput chart (real samples only) ─────────────────────────────────────

class SpeedChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.samples = [];
    this.max = 0;
    window.addEventListener("resize", () => this.draw());
    document.addEventListener("theme-changed", () => this.draw());
  }

  reset() {
    this.samples = [];
    this.max = 0;
    this.draw();
  }

  push(bps) {
    this.samples.push(bps);
    if (this.samples.length > 150) this.samples.shift();
    this.max = Math.max(this.max, bps);
    this.draw();
  }

  _color(varName) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(varName)
      .trim();
  }

  draw() {
    const canvas = this.canvas;
    if (!canvas.isConnected) return;
    const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
    const cssHeight = 96;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const border = this._color("--border-strong") || "rgba(0,0,0,0.16)";
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cssHeight - 0.5);
    ctx.lineTo(cssWidth, cssHeight - 0.5);
    ctx.stroke();

    if (this.samples.length < 2 || this.max <= 0) return;

    const line = this._color("--info-text") || "#00458c";
    const n = this.samples.length;
    const stepX = cssWidth / Math.max(n - 1, 1);
    const scaleY = (cssHeight - 12) / this.max;

    ctx.beginPath();
    this.samples.forEach((v, i) => {
      const x = i * stepX;
      const y = cssHeight - 1 - v * scaleY;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    ctx.lineTo((n - 1) * stepX, cssHeight);
    ctx.lineTo(0, cssHeight);
    ctx.closePath();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = line;
    ctx.fill();
    ctx.globalAlpha = 1;

    const lastY = cssHeight - 1 - this.samples[n - 1] * scaleY;
    ctx.beginPath();
    ctx.arc(cssWidth - 2, lastY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = line;
    ctx.fill();
  }
}

// ── Main controller ──────────────────────────────────────────────────────────

class DrplUI {
  constructor() {
    this.peerInfo = {};
    this.sentSound = $("sent-sound");

    this.transfers = new TransfersPane(this);
    this.files = new FilesPane(this);
    this.messages = new MessagesPane(this);

    this._initTabs();
    this._initSidebar();
    this._initNetworkEvents();
    this._initAboutEscape();
    WakeLock.init();
  }

  // ---- tabs ----

  _initTabs() {
    this.activeTab = "pane-transfers";
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => this.switchTab(tab.dataset.pane));
    });
  }

  switchTab(paneId) {
    if (this.activeTab === paneId) return;
    this.activeTab = paneId;
    document.querySelectorAll(".tab").forEach((tab) => {
      const active = tab.dataset.pane === paneId;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".pane").forEach((pane) => {
      pane.classList.toggle("active", pane.id === paneId);
    });
    const pane = $(paneId);
    Motion.paneIn(pane);
    if (paneId === "pane-files") this.files.onShown();
    if (paneId === "pane-messages") this.messages.onShown();
    if (paneId === "pane-transfers") this.transfers.redraw();
  }

  // ---- sidebar ----

  _initSidebar() {
    $("manual-refresh").addEventListener("click", () => {
      const btn = $("manual-refresh");
      btn.classList.remove("spinning");
      void btn.offsetWidth;
      btn.classList.add("spinning");
      if (window.drplNetwork) {
        window.drplNetwork.server._ensureAlive();
        window.drplNetwork.peers.refreshAllPeers();
      }
      Toast.show("Connections refreshed", { icon: "refresh-cw" });
    });
  }

  peerName(peerId) {
    const info = this.peerInfo[peerId];
    return info ? info.name.displayName : "Unknown device";
  }

  _initNetworkEvents() {
    Events.on("peers", (e) => this._onPeers(e.detail));
    Events.on("peer-joined", (e) => this._onPeerJoined(e.detail));
    Events.on("peer-left", (e) => this._onPeerLeft(e.detail));
    Events.on("display-name", (e) => this._onDisplayName(e.detail));
    Events.on("server-connected", () => this._setOnline(true));
    Events.on("server-disconnected", () => this._setOnline(false));
    Events.on("notify-user", (e) => Toast.show(e.detail));
    Events.on("file-sent", () => this._playSound());
    Events.on("text-sent", () => this._playSound());

    Events.on("transfer-progress", (e) => {
      const d = e.detail;
      this._updatePeerRow(d.peerId, d.bytes, d.totalSize);
    });
    Events.on("transfer-complete", (e) =>
      this._clearPeerRow(e.detail.peerId),
    );
    Events.on("transfer-cancelled", (e) =>
      this._clearPeerRow(e.detail.peerId),
    );
  }

  _onPeers(peers) {
    $("peers").innerHTML = "";
    this.peerInfo = {};
    peers.forEach((peer, i) => this._addPeer(peer, i));
    this._updateCount();
  }

  _onPeerJoined(peer) {
    const existing = $(`peer-${peer.id}`);
    if (existing) {
      if (window.gsap) gsap.killTweensOf(existing);
      existing.remove();
    }
    this._addPeer(peer, 0);
    this._updateCount();
  }

  _onPeerLeft(peerId) {
    delete this.peerInfo[peerId];
    const el = $(`peer-${peerId}`);
    if (el)
      Motion.rowOut(el, () => {
        el.remove();
        this._updateCount();
      });
    this._updateCount();
  }

  _updateCount() {
    const n = Object.keys(this.peerInfo).length;
    $("device-count").textContent = n;
    // Nudge toward adding more devices until the room feels populated
    $("more-devices-hint").classList.toggle("hidden", n === 0 || n >= 3);
    this.messages._renderPeerbar();
  }

  _addPeer(peer, index) {
    this.peerInfo[peer.id] = peer;

    const row = document.createElement("div");
    row.className = "peer";
    row.id = `peer-${peer.id}`;
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");

    const iconWrap = document.createElement("span");
    iconWrap.className = "peer-icon";
    iconWrap.appendChild(makeIcon(deviceIconName(peer.name.type)));

    const text = document.createElement("span");
    text.className = "peer-text";
    const name = document.createElement("div");
    name.className = "peer-name";
    name.textContent = peer.name.displayName;
    const device = document.createElement("div");
    device.className = "peer-device";
    device.textContent = peer.name.deviceName;
    text.append(name, device);

    const transferPct = document.createElement("span");
    transferPct.className = "peer-transfer";

    const actions = document.createElement("span");
    actions.className = "peer-actions";
    const sendBtn = document.createElement("button");
    sendBtn.className = "icon-button sm";
    sendBtn.title = `Send files to ${peer.name.displayName}`;
    sendBtn.setAttribute("aria-label", sendBtn.title);
    sendBtn.appendChild(makeIcon("circle-arrow-up"));
    const msgBtn = document.createElement("button");
    msgBtn.className = "icon-button sm";
    msgBtn.title = `Message ${peer.name.displayName}`;
    msgBtn.setAttribute("aria-label", msgBtn.title);
    msgBtn.appendChild(makeIcon("message-circle"));
    actions.append(sendBtn, msgBtn);

    row.append(iconWrap, text, transferPct, actions);

    const pick = (e) => {
      e.stopPropagation();
      this.pickAndSend(peer.id);
    };
    row.addEventListener("click", pick);
    sendBtn.addEventListener("click", pick);
    msgBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openMessages(peer.id);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.pickAndSend(peer.id);
      }
    });

    $("peers").appendChild(row);
    Motion.rowIn(row, index);
  }

  pickAndSend(peerId) {
    const input = $("file-input");
    input.value = "";
    input.onchange = (e) => {
      if (!e.target.files.length) return;
      Events.fire("files-selected", { files: e.target.files, to: peerId });
    };
    input.click();
  }

  // Pick once, send to every connected device
  pickAndSendToAll() {
    const ids = Object.keys(this.peerInfo);
    if (!ids.length) {
      Toast.show("No devices to send to right now", { icon: "wifi-off" });
      return;
    }
    const input = $("file-input");
    input.value = "";
    input.onchange = (e) => {
      if (!e.target.files.length) return;
      this.messages.logGroupFiles(e.target.files, ids);
      ids.forEach((id) =>
        Events.fire("files-selected", { files: e.target.files, to: id }),
      );
    };
    input.click();
  }

  openMessages(peerId) {
    this.messages.openWith(peerId);
    this.switchTab("pane-messages");
  }

  showFiles() {
    this.switchTab("pane-files");
  }

  _updatePeerRow(peerId, bytes, totalSize) {
    const el = $(`peer-${peerId}`);
    if (!el || !totalSize) return;
    el.classList.add("transferring");
    const pct = el.querySelector(".peer-transfer");
    if (pct) pct.textContent = `${Math.floor((bytes / totalSize) * 100)}%`;
  }

  _clearPeerRow(peerId) {
    const el = $(`peer-${peerId}`);
    if (!el) return;
    el.classList.remove("transferring");
  }

  // ---- identity ----

  _onDisplayName(data) {
    this._myName = data.displayName;
    this._renderIdentity(this._online !== false);
  }

  _setOnline(online) {
    this._online = online;
    this._renderIdentity(online);
    if (!online)
      Toast.show("Connection lost. Reconnecting...", { icon: "wifi-off" });
  }

  _renderIdentity(online) {
    const box = $("display-name");
    if (!box) return;
    box.innerHTML = "";
    const label = document.createElement("span");
    label.className = "identity-label";
    if (this._myName && online !== false) {
      label.textContent = "You are known as:";
      const strong = document.createElement("strong");
      strong.textContent = this._myName;
      strong.title = this._myName;
      box.append(label, strong);
    } else {
      label.textContent = this._myName ? "Reconnecting" : "Connecting";
      box.append(label);
    }
  }

  // ---- misc ----

  _initAboutEscape() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && location.hash === "#about") {
        location.hash = "";
      }
    });
  }

  _playSound() {
    if (this.sentSound) {
      this.sentSound.currentTime = 0;
      this.sentSound.play().catch(() => {});
    }
  }

  showToast(message, opts = {}) {
    Toast.show(message, opts);
  }
}

// ── Transfers pane ───────────────────────────────────────────────────────────

const CANCEL_REASONS = {
  cancelled: "Transfer cancelled.",
  remote: "The other device cancelled the transfer.",
  "connection-lost":
    "Connection to the device was lost mid-transfer. Send the files again once it reappears.",
  "size-mismatch":
    "The received data did not match the expected size, so the transfer was stopped. Send the files again.",
  error:
    "The transfer failed while reading or sending the files. Try sending them again.",
};

class TransfersPane {
  constructor(ui) {
    this.ui = ui;
    this.current = null;
    this.recent = [];
    this.session = {
      sentBytes: 0,
      sentFiles: 0,
      recvBytes: 0,
      recvFiles: 0,
      peak: 0,
      count: 0,
    };
    this.chart = new SpeedChart($("tp-chart"));

    $("tp-action").addEventListener("click", () => {
      const t = this.current;
      if (!t) return;
      if (!t.done && !t.error) {
        Events.fire("cancel-transfer", t.peerId);
      } else if (t.direction === "receive" && t.done) {
        this.ui.showFiles();
      } else {
        this._clearLive();
      }
    });

    Events.on("transfer-started", (e) => this._onStarted(e.detail));
    Events.on("transfer-progress", (e) => this._onProgress(e.detail));
    Events.on("file-active", (e) => this._onFileActive(e.detail));
    Events.on("file-done", (e) => this._onFileDone(e.detail));
    Events.on("file-received", (e) =>
      this._onFileDone({
        peerId: e.detail.sender,
        transferId: e.detail.transferId,
        index: e.detail.index,
      }),
    );
    Events.on("transfer-complete", (e) => this._onComplete(e.detail));
    Events.on("transfer-cancelled", (e) => this._onCancelled(e.detail));

    setInterval(() => this._tick(), 500);
    this._renderSession();
  }

  _onStarted(d) {
    const state = {
      peerId: d.peerId,
      transferId: d.transferId,
      direction: d.direction,
      files: d.files,
      totalSize: d.totalSize,
      bytes: 0,
      doneCount: 0,
      activeIndex: -1,
      startedAt: Date.now(),
      speed: null,
      peak: 0,
      done: false,
      error: null,
      _lastBytes: 0,
      _lastTime: Date.now(),
    };
    this.current = state;
    this.chart.reset();
    WakeLock.acquire();
    this._renderAll();
    this.ui.switchTab("pane-transfers");
  }

  _onProgress(d) {
    const t = this.current;
    if (!t || t.transferId !== d.transferId || t.done) return;
    t.bytes = Math.max(t.bytes, Math.min(d.bytes, t.totalSize));

    const now = Date.now();
    const dt = now - t._lastTime;
    if (dt >= 250) {
      const inst = ((t.bytes - t._lastBytes) / dt) * 1000;
      if (inst >= 0) {
        t.speed = t.speed === null ? inst : t.speed * 0.7 + inst * 0.3;
        t.peak = Math.max(t.peak, inst);
        this.chart.push(inst);
        $("tp-chart-max").textContent = `peak ${formatSpeed(t.peak)}`;
      }
      t._lastBytes = t.bytes;
      t._lastTime = now;
    }
    this._renderProgress(t);
  }

  _onFileActive(d) {
    const t = this.current;
    if (!t || t.transferId !== d.transferId) return;
    t.activeIndex = d.index;
    this._renderFiles(t);
  }

  _onFileDone(d) {
    const t = this.current;
    if (!t || t.transferId !== d.transferId) return;
    t.doneCount = Math.max(t.doneCount, d.index + 1);
    const row = document.querySelector(
      `#tp-files .transfer-file[data-index="${d.index}"]`,
    );
    if (row) {
      row.classList.remove("active");
      row.classList.add("done");
      const status = row.querySelector(".transfer-file-status");
      status.innerHTML = "";
      status.appendChild(makeIcon("check"));
      Motion.pop(status.firstChild);
    }
    this._renderStats(t);
  }

  _onComplete(d) {
    const t = this.current;

    this.session.count++;
    if (d.direction === "send") {
      this.session.sentBytes += d.totalSize;
      this.session.sentFiles += d.fileCount;
    } else {
      this.session.recvBytes += d.totalSize;
      this.session.recvFiles += d.fileCount;
    }
    if (t && t.transferId === d.transferId) {
      this.session.peak = Math.max(this.session.peak, t.peak || 0);
    }
    this._renderSession();

    this._pushRecent({
      direction: d.direction,
      peerName: this.ui.peerName(d.peerId),
      fileCount: d.fileCount,
      totalSize: d.totalSize,
      duration: d.duration,
      status: "done",
      at: Date.now(),
    });
    WakeLock.release();

    if (t && t.transferId === d.transferId) {
      t.done = true;
      t.bytes = t.totalSize;
      t.duration = d.duration;
      this._renderAll();
    }
    if (this.ui.activeTab !== "pane-transfers") {
      const files = d.fileCount === 1 ? "1 file" : `${d.fileCount} files`;
      const name = this.ui.peerName(d.peerId);
      Toast.show(
        d.direction === "receive"
          ? `Received ${files} from ${name}`
          : `Sent ${files} to ${name}`,
        { icon: "check", tone: "ok" },
      );
    }
  }

  _onCancelled(d) {
    const t = this.current;
    this.session.count++;
    this._renderSession();
    this._pushRecent({
      direction: d.direction,
      peerName: this.ui.peerName(d.peerId),
      fileCount: t && t.transferId === d.transferId ? t.files.length : 0,
      totalSize: t && t.transferId === d.transferId ? t.totalSize : 0,
      duration: 0,
      status: "failed",
      at: Date.now(),
    });
    WakeLock.release();

    if (t && t.transferId === d.transferId) {
      t.error = d.reason || "cancelled";
      this._renderAll();
    }
    if (this.ui.activeTab !== "pane-transfers") {
      Toast.show(CANCEL_REASONS[d.reason] || CANCEL_REASONS.cancelled, {
        icon: "circle-alert",
        tone: "bad",
      });
    }
  }

  _tick() {
    const t = this.current;
    if (!t || t.done || t.error) return;
    $("st-elapsed").textContent = formatDuration(Date.now() - t.startedAt);
    this._renderLiveInternals(t);
  }

  redraw() {
    this.chart.draw();
  }

  _clearLive() {
    this.current = null;
    $("tp-live").classList.add("hidden");
    $("tp-empty").classList.remove("hidden");
  }

  _renderSession() {
    const s = this.session;
    $("ss-sent").textContent = `${formatSize(s.sentBytes)}, ${s.sentFiles} ${s.sentFiles === 1 ? "file" : "files"}`;
    $("ss-received").textContent = `${formatSize(s.recvBytes)}, ${s.recvFiles} ${s.recvFiles === 1 ? "file" : "files"}`;
    $("ss-peak").textContent = s.peak ? formatSpeed(s.peak) : "-";
    $("ss-count").textContent = s.count;
  }

  // ---- rendering ----

  _renderAll() {
    const t = this.current;
    if (!t) {
      this._clearLive();
      return;
    }
    $("tp-empty").classList.add("hidden");
    $("tp-live").classList.remove("hidden");

    const badge = $("tp-state");
    badge.className = "state-badge";
    let label;
    if (t.error) {
      badge.classList.add("failed");
      label = "Failed";
      $("tp-live").setAttribute("data-state", "failed");
    } else if (t.done) {
      badge.classList.add("done");
      label = t.direction === "send" ? "Sent" : "Received";
      $("tp-live").setAttribute("data-state", "done");
    } else {
      badge.classList.add(t.direction === "send" ? "sending" : "receiving");
      label = t.direction === "send" ? "Sending" : "Receiving";
      $("tp-live").setAttribute("data-state", "live");
    }
    badge.textContent = label;

    $("tp-title").textContent =
      `${t.direction === "send" ? "to" : "from"} ${this.ui.peerName(t.peerId)}`;

    if (t.error) {
      $("tp-sub").textContent =
        CANCEL_REASONS[t.error] || CANCEL_REASONS.cancelled;
    } else {
      const files =
        t.files.length === 1 ? "1 file" : `${t.files.length} files`;
      $("tp-sub").textContent = `${files}, ${formatSize(t.totalSize)} total`;
    }

    const action = $("tp-action");
    if (!t.done && !t.error) {
      action.textContent = "Cancel";
      action.classList.add("danger-text");
    } else if (t.done && t.direction === "receive") {
      action.textContent = "Open in Files";
      action.classList.remove("danger-text");
    } else {
      action.textContent = "Clear";
      action.classList.remove("danger-text");
    }

    this._renderProgress(t);
    this._renderStats(t);
    this._renderFiles(t);
  }

  _renderProgress(t) {
    const pct = t.totalSize > 0 ? t.bytes / t.totalSize : t.done ? 1 : 0;
    $("tp-percent").textContent = `${Math.floor(pct * 100)}%`;
    $("tp-bar").style.width = `${pct * 100}%`;

    if (t.error) {
      $("tp-progress-stats").textContent = "";
    } else if (t.done) {
      const dur = t.duration || Date.now() - t.startedAt;
      const rate = dur > 0 ? formatSpeed((t.totalSize / dur) * 1000) : "";
      $("tp-progress-stats").textContent =
        `${formatSize(t.totalSize)} in ${formatDuration(dur)}${rate ? ` (${rate})` : ""}`;
    } else {
      $("tp-progress-stats").textContent =
        `${formatSize(t.bytes)} of ${formatSize(t.totalSize)}`;
    }
    this._renderStats(t);
  }

  _renderStats(t) {
    $("st-speed").textContent =
      t.done || t.error ? "-" : formatSpeed(t.speed || 0);
    const elapsed = (t.done ? t.duration : Date.now() - t.startedAt) || 1;
    $("st-avg").textContent = formatSpeed((t.bytes / elapsed) * 1000);
    $("st-peak").textContent = t.peak ? formatSpeed(t.peak) : "-";
    $("st-data").textContent =
      `${formatSize(t.bytes)} / ${formatSize(t.totalSize)}`;
    $("st-files").textContent = `${t.doneCount} / ${t.files.length}`;
    $("st-elapsed").textContent = formatDuration(elapsed);

    if (t.done || t.error) {
      $("st-eta").textContent = "-";
    } else if (t.speed && t.speed > 1024) {
      const remaining = (t.totalSize - t.bytes) / t.speed;
      $("st-eta").textContent =
        remaining > 0.5 ? `${Math.ceil(remaining)} s` : "-";
    } else {
      $("st-eta").textContent = "-";
    }

    this._renderLiveInternals(t);
  }

  _renderLiveInternals(t) {
    const peer =
      window.drplNetwork && window.drplNetwork.peers.peers[t.peerId];
    if (!peer) {
      $("st-chunk").textContent = "-";
      $("st-transport").textContent = "-";
      $("st-buffer").textContent = "-";
      return;
    }
    try {
      const chunk = peer._chunkSize ? peer._chunkSize() : null;
      $("st-chunk").textContent = chunk
        ? `${Math.round(chunk / 1024)} KiB`
        : "-";
      const relay = peer._useRelay || !peer._isOpen || !peer._isOpen();
      $("st-transport").textContent = relay ? "Server relay" : "WebRTC P2P";
      const buffered = peer._bufferedAmount ? peer._bufferedAmount() : 0;
      $("st-buffer").textContent =
        t.done || t.error ? "-" : formatSize(buffered);
    } catch (e) {
      /* peer internals unavailable */
    }
  }

  _renderFiles(t) {
    const list = $("tp-files");
    list.innerHTML = "";
    t.files.forEach((file, i) => {
      const li = document.createElement("li");
      li.className = "transfer-file";
      li.dataset.index = i;
      if (i < t.doneCount) li.classList.add("done");
      else if (i === t.activeIndex && !t.done && !t.error)
        li.classList.add("active");
      if (t.error && i >= t.doneCount) li.classList.add("failed");

      li.appendChild(makeIcon(fileIconName(file.mime), "icon file-type-icon"));

      const name = document.createElement("span");
      name.className = "transfer-file-name";
      name.textContent = file.name;
      li.appendChild(name);

      const size = document.createElement("span");
      size.className = "transfer-file-size";
      size.textContent = formatSize(file.size);
      li.appendChild(size);

      const status = document.createElement("span");
      status.className = "transfer-file-status";
      if (i < t.doneCount) {
        status.appendChild(makeIcon("check"));
      } else if (t.error) {
        status.appendChild(makeIcon("x"));
      } else if (i === t.activeIndex) {
        status.appendChild(makeIcon("loader-circle", "icon spin"));
      } else {
        const dot = document.createElement("span");
        dot.className = "wait-dot";
        status.appendChild(dot);
      }
      li.appendChild(status);

      list.appendChild(li);
    });
  }

  _pushRecent(entry) {
    this.recent.unshift(entry);
    if (this.recent.length > 20) this.recent.pop();
    this._renderRecent();
  }

  _renderRecent() {
    const list = $("tp-recent");
    const badge = $("recent-count");
    list.innerHTML = "";
    $("recent-empty").classList.toggle("hidden", this.recent.length > 0);
    badge.classList.toggle("hidden", this.recent.length === 0);
    badge.textContent = this.recent.length;

    this.recent.forEach((r) => {
      const li = document.createElement("li");
      li.className = "recent-item";

      li.appendChild(
        makeIcon(
          r.direction === "send" ? "circle-arrow-up" : "circle-arrow-down",
        ),
      );

      const text = document.createElement("div");
      text.className = "recent-text";
      const title = document.createElement("span");
      title.className = "recent-title";
      const files = r.fileCount === 1 ? "1 file" : `${r.fileCount} files`;
      title.textContent =
        r.direction === "send"
          ? `${files} to ${r.peerName}`
          : `${files} from ${r.peerName}`;
      const meta = document.createElement("span");
      meta.className = "recent-meta";
      meta.textContent =
        r.status === "done"
          ? `${formatSize(r.totalSize)}, ${formatDuration(r.duration)}, ${formatClock(r.at)}`
          : formatClock(r.at);
      text.append(title, meta);
      li.appendChild(text);

      const badgeEl = document.createElement("span");
      badgeEl.className = `state-badge ${r.status === "done" ? "done" : "failed"}`;
      badgeEl.textContent =
        r.status === "done"
          ? r.direction === "send"
            ? "Sent"
            : "Received"
          : "Failed";
      li.appendChild(badgeEl);

      list.appendChild(li);
    });
  }
}

// ── Files pane: gallery + detail ─────────────────────────────────────────────

class FilesPane {
  constructor(ui) {
    this.ui = ui;
    this.files = [];
    this.index = 0;
    this.unseen = 0;
    this.view = "grid";

    $("fp-back").addEventListener("click", () => this._showGrid());
    $("fp-prev").addEventListener("click", () => this._step(-1));
    $("fp-next").addEventListener("click", () => this._step(1));
    $("fp-save").addEventListener("click", () => {
      const f = this.files[this.index];
      if (f) this._download(f);
    });
    $("fp-save-all").addEventListener("click", () => this._downloadAll());
    $("fp-share").addEventListener("click", () => this._share());

    document.addEventListener("keydown", (e) => {
      if (this.ui.activeTab !== "pane-files" || this.view !== "detail") return;
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        this._step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this._step(1);
      } else if (e.key === "Escape") {
        this._showGrid();
      }
    });

    Events.on("file-received", (e) => this.addFile(e.detail));
  }

  addFile(file) {
    file.url = URL.createObjectURL(file.blob);
    file.receivedAt = Date.now();
    this.files.push(file);
    if (this.ui.activeTab !== "pane-files") this.unseen++;
    this._renderBadge();
    this._renderGrid();
    if (this.view === "detail") this._updateNav();
  }

  onShown() {
    this.unseen = 0;
    this._renderBadge();
  }

  _renderBadge() {
    const badge = $("files-count");
    badge.classList.toggle("hidden", this.unseen === 0);
    badge.textContent = this.unseen;
  }

  _renderGrid() {
    const has = this.files.length > 0;
    $("fp-empty").classList.toggle("hidden", has);
    $("fp-body").classList.toggle("hidden", !has);
    if (!has) return;

    $("fp-count").textContent = this.files.length;
    $("fp-save-all").classList.toggle("hidden", this.files.length < 2);

    const grid = $("fp-grid");
    grid.innerHTML = "";
    this.files.forEach((file, i) => {
      const li = document.createElement("li");
      const tile = document.createElement("button");
      tile.className = "fp-tile";
      tile.title = `${file.name}, from ${this._fromName(file)}`;

      const thumb = document.createElement("span");
      thumb.className = "fp-tile-thumb";
      if (file.mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = file.url;
        img.alt = file.name;
        img.loading = "lazy";
        thumb.appendChild(img);
      } else {
        thumb.appendChild(makeIcon(fileIconName(file.mime)));
        const ext = document.createElement("span");
        ext.className = "fp-tile-ext";
        const dot = file.name.lastIndexOf(".");
        ext.textContent = dot > 0 ? file.name.slice(dot + 1) : "file";
        thumb.appendChild(ext);
      }
      tile.appendChild(thumb);

      const save = document.createElement("span");
      save.className = "icon-button sm fp-tile-save";
      save.title = `Save ${file.name}`;
      save.setAttribute("role", "button");
      save.setAttribute("aria-label", save.title);
      save.appendChild(makeIcon("download"));
      save.addEventListener("click", (e) => {
        e.stopPropagation();
        this._download(file);
      });
      tile.appendChild(save);

      const meta = document.createElement("span");
      meta.className = "fp-tile-meta";
      const name = document.createElement("span");
      name.className = "fp-tile-name";
      name.textContent = file.name;
      const size = document.createElement("span");
      size.className = "fp-tile-size";
      size.textContent = formatSize(file.size);
      meta.append(name, size);
      tile.appendChild(meta);

      tile.addEventListener("click", () => this._openDetail(i));
      li.appendChild(tile);
      grid.appendChild(li);
      Motion.rowIn(li, Math.min(i, 8));
    });
  }

  _fromName(file) {
    return this.ui.peerName(file.sender);
  }

  _openDetail(index) {
    this.view = "detail";
    $("fp-grid").classList.add("hidden");
    $("fp-detail").classList.remove("hidden");
    this._select(index, true);
    Motion.paneIn($("fp-detail"));
  }

  _showGrid() {
    this.view = "grid";
    $("fp-detail").classList.add("hidden");
    $("fp-grid").classList.remove("hidden");
    $("fp-stage").innerHTML = "";
  }

  _step(dir) {
    const next = this.index + dir;
    if (next < 0 || next >= this.files.length) return;
    this._select(next);
  }

  _updateNav() {
    $("fp-index").textContent = this.files.length ? this.index + 1 : 0;
    $("fp-total").textContent = this.files.length;
    $("fp-prev").disabled = this.index <= 0;
    $("fp-next").disabled = this.index >= this.files.length - 1;
  }

  async _select(index, instant = false) {
    this.index = index;
    const file = this.files[index];
    if (!file) return;

    const stage = $("fp-stage");
    stage.innerHTML = "";

    if (file.mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = file.url;
      img.alt = file.name;
      stage.appendChild(img);
    } else if (file.mime.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = file.url;
      video.controls = true;
      video.playsInline = true;
      stage.appendChild(video);
    } else if (file.mime.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.src = file.url;
      audio.controls = true;
      stage.appendChild(audio);
    } else if (isTextPreviewable(file)) {
      const LIMIT = 96 * 1024;
      try {
        const slice = file.blob.slice(0, LIMIT);
        const text = await slice.text();
        if (this.files[this.index] !== file) return;
        const pre = document.createElement("pre");
        pre.className = "text-preview";
        pre.textContent = text;
        stage.appendChild(pre);
        if (file.size > LIMIT) {
          const note = document.createElement("span");
          note.className = "text-preview-note";
          note.textContent = `Preview of first ${formatSize(LIMIT)}`;
          stage.appendChild(note);
        }
      } catch (e) {
        this._renderGenericStage(stage, file);
      }
    } else {
      this._renderGenericStage(stage, file);
    }

    if (!instant) Motion.pulse(stage);

    $("fp-name").textContent = file.name;
    $("fp-size").textContent = formatSize(file.size);
    $("fp-from").textContent =
      `from ${this._fromName(file)}, ${formatClock(file.receivedAt)}`;
    this._updateNav();

    const share = $("fp-share");
    const canShare =
      navigator.canShare &&
      navigator.canShare({
        files: [new File([file.blob], file.name, { type: file.mime })],
      });
    share.classList.toggle("hidden", !canShare);
  }

  _renderGenericStage(stage, file) {
    const wrap = document.createElement("div");
    wrap.className = "stage-file";
    wrap.appendChild(makeIcon(fileIconName(file.mime)));
    const ext = document.createElement("span");
    ext.className = "stage-file-ext";
    const dot = file.name.lastIndexOf(".");
    ext.textContent = dot > 0 ? file.name.slice(dot + 1) : "file";
    wrap.appendChild(ext);
    stage.appendChild(wrap);
  }

  _download(file) {
    const a = document.createElement("a");
    a.href = file.url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async _share() {
    const f = this.files[this.index];
    if (!f || !navigator.share) return;
    try {
      await navigator.share({
        files: [new File([f.blob], f.name, { type: f.mime })],
      });
    } catch (e) {
      /* sheet dismissed */
    }
  }

  async _downloadAll() {
    if (this.files.length === 1) {
      this._download(this.files[0]);
      return;
    }
    const total = this.files.reduce((s, f) => s + f.size, 0);
    if (
      total > 512 * 1024 * 1024 &&
      !confirm(
        `Package ${formatSize(total)} into one zip in the browser? On phones this can run out of memory. Cancel to save files one by one.`,
      )
    ) {
      return;
    }
    Toast.show("Packaging files...", { icon: "archive" });
    try {
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      const used = new Set();
      this.files.forEach((f) => {
        let name = f.name;
        let n = 1;
        while (used.has(name)) {
          const dot = f.name.lastIndexOf(".");
          name =
            dot > 0
              ? `${f.name.slice(0, dot)} (${n})${f.name.slice(dot)}`
              : `${f.name} (${n})`;
          n++;
        }
        used.add(name);
        zip.file(name, f.blob);
      });
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "STORE",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "drpl-files.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      Toast.show("Could not build the zip. Save files one by one.", {
        icon: "circle-alert",
        tone: "bad",
      });
    }
  }
}

let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => {
        jszipPromise = null;
        reject(new Error("JSZip failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return jszipPromise;
}

// ── Messages pane ────────────────────────────────────────────────────────────

const EVERYONE = "everyone";
const CONVO_STORE_KEY = "drpl-convos-v1";
const CONVO_ENTRY_CAP = 300;

class MessagesPane {
  constructor(ui) {
    this.ui = ui;
    this.convos = {}; // key (peerId | EVERYONE) -> entries
    this.names = {}; // last known display name per peerId
    this.unread = {};
    this.activePeer = null;
    this._saveTimer = null;

    this._timeline = $("mp-timeline");
    this._input = $("mp-input");

    this._load();

    $("mp-send").addEventListener("click", () => this._send());
    this._input.addEventListener("keydown", (e) => {
      const isEnter =
        e.key === "Enter" || e.key === "Return" || e.keyCode === 13;
      if (isEnter && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });
    this._input.addEventListener("input", () => this._resize());
    $("mp-attach").addEventListener("click", () => {
      if (this.activePeer === EVERYONE) {
        this.ui.pickAndSendToAll();
      } else if (this.activePeer) {
        if (!this.ui.peerInfo[this.activePeer]) {
          Toast.show("That device is offline right now", { icon: "wifi-off" });
          return;
        }
        this.ui.pickAndSend(this.activePeer);
      }
    });

    Events.on("text-received", (e) => {
      const d = e.detail;
      this.names[d.sender] = this.ui.peerName(d.sender);
      const key = d.broadcast ? EVERYONE : d.sender;
      this._addEntry(key, {
        kind: "text",
        sent: false,
        time: Date.now(),
        text: d.text,
        senderName: this.ui.peerName(d.sender),
      });
    });

    // File activity shows up in the conversation timeline
    Events.on("files-selected", (e) => {
      const to = e.detail.to;
      if (this._suppressLog && this._suppressLog.has(to)) {
        this._suppressLog.delete(to);
        return;
      }
      Array.from(e.detail.files).forEach((f) => {
        this._addEntry(
          to,
          {
            kind: "file",
            sent: true,
            time: Date.now(),
            name: f.name,
            size: f.size,
            mime: f.type || "application/octet-stream",
            url:
              f.type && f.type.startsWith("image/")
                ? URL.createObjectURL(f)
                : null,
          },
          { silent: true },
        );
      });
    });
    Events.on("file-received", (e) => {
      const d = e.detail;
      this.names[d.sender] = this.ui.peerName(d.sender);
      this._addEntry(
        d.sender,
        {
          kind: "file",
          sent: false,
          time: Date.now(),
          name: d.name,
          size: d.size,
          mime: d.mime,
          url: d.mime.startsWith("image/")
            ? URL.createObjectURL(d.blob)
            : null,
          senderName: this.ui.peerName(d.sender),
        },
        { silent: true },
      );
    });
  }

  // Group file sends log once under Everyone; the per-peer events that
  // follow are suppressed so the timeline shows one entry per file
  logGroupFiles(files, peerIds) {
    this._suppressLog = new Set(peerIds);
    Array.from(files).forEach((f) => {
      this._addEntry(
        EVERYONE,
        {
          kind: "file",
          sent: true,
          time: Date.now(),
          name: f.name,
          size: f.size,
          mime: f.type || "application/octet-stream",
          url:
            f.type && f.type.startsWith("image/")
              ? URL.createObjectURL(f)
              : null,
        },
        { silent: true },
      );
    });
  }

  // ---- persistence (text and file metadata; blobs are not persisted) ----

  _load() {
    try {
      const raw = localStorage.getItem(CONVO_STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || data.v !== 1 || !data.convos) return;
      for (const key of Object.keys(data.convos)) {
        const rec = data.convos[key];
        if (rec.name) this.names[key] = rec.name;
        this.convos[key] = (rec.entries || []).map((e) => ({
          kind: e.k === "f" ? "file" : "text",
          sent: !!e.s,
          time: e.t,
          text: e.x,
          name: e.fn,
          size: e.fs,
          mime: e.fm,
          url: null,
          senderName: e.n,
        }));
      }
    } catch (e) {
      /* corrupted storage; start fresh */
    }
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const data = { v: 1, convos: {} };
      for (const key of Object.keys(this.convos)) {
        const entries = this.convos[key].slice(-CONVO_ENTRY_CAP).map((e) =>
          e.kind === "file"
            ? {
                k: "f",
                s: e.sent ? 1 : 0,
                t: e.time,
                fn: e.name,
                fs: e.size,
                fm: e.mime,
                n: e.senderName,
              }
            : { k: "t", s: e.sent ? 1 : 0, t: e.time, x: e.text, n: e.senderName },
        );
        data.convos[key] = { name: this.names[key], entries };
      }
      try {
        localStorage.setItem(CONVO_STORE_KEY, JSON.stringify(data));
      } catch (e) {
        // Quota: drop the oldest half of every conversation and retry once
        for (const key of Object.keys(data.convos)) {
          const es = data.convos[key].entries;
          data.convos[key].entries = es.slice(Math.floor(es.length / 2));
        }
        try {
          localStorage.setItem(CONVO_STORE_KEY, JSON.stringify(data));
        } catch (e2) {
          /* storage unavailable */
        }
      }
    }, 400);
  }

  // ---- naming ----

  nameFor(key) {
    if (key === EVERYONE) return "Everyone";
    const live = this.ui.peerInfo[key];
    if (live) return live.name.displayName;
    return this.names[key] || "Unknown device";
  }

  // ---- state ----

  openWith(key) {
    this.activePeer = key;
    if (!this.convos[key]) this.convos[key] = [];
    this.unread[key] = 0;
    this._renderAll();
    setTimeout(() => this._input.focus(), 150);
  }

  onShown() {
    if (!this.activePeer) {
      const livePeers = Object.keys(this.ui.peerInfo);
      const stored = Object.keys(this.convos);
      const first = livePeers[0] || stored.find((k) => k !== EVERYONE);
      this.openWith(first || EVERYONE);
      return;
    }
    this.unread[this.activePeer] = 0;
    this._renderAll();
  }

  _addEntry(key, entry, { silent = false } = {}) {
    if (!this.convos[key]) this.convos[key] = [];
    this.convos[key].push(entry);
    this._save();

    const isVisible =
      this.ui.activeTab === "pane-messages" && this.activePeer === key;
    if (isVisible) {
      this._renderAll();
    } else if (!entry.sent) {
      this.unread[key] = (this.unread[key] || 0) + 1;
      if (!silent) {
        const label =
          key === EVERYONE
            ? `${entry.senderName} to everyone`
            : this.nameFor(key);
        const preview =
          entry.text && entry.text.length > 56
            ? `${entry.text.slice(0, 56)}...`
            : entry.text;
        Toast.show(`${label}: ${preview}`, { icon: "message-circle" });
      }
      this._renderBadges();
    } else {
      this._renderBadges();
    }
  }

  _totalUnread() {
    return Object.values(this.unread).reduce((s, n) => s + n, 0);
  }

  _renderBadges() {
    const badge = $("messages-count");
    const total = this._totalUnread();
    badge.classList.toggle("hidden", total === 0);
    badge.textContent = total;
    this._renderPeerbar();
  }

  _send() {
    const text = this._input.value.trim();
    if (!text || !this.activePeer) return;

    if (this.activePeer === EVERYONE) {
      if (!Object.keys(this.ui.peerInfo).length) {
        Toast.show("No devices to message right now", { icon: "wifi-off" });
        return;
      }
      Events.fire("send-text", { to: "*", text });
    } else {
      if (!this.ui.peerInfo[this.activePeer]) {
        Toast.show("That device is offline right now", { icon: "wifi-off" });
        return;
      }
      Events.fire("send-text", { to: this.activePeer, text });
    }

    this._addEntry(this.activePeer, {
      kind: "text",
      sent: true,
      time: Date.now(),
      text,
    });
    this._input.value = "";
    this._resize();
  }

  _clearActive() {
    if (!this.activePeer) return;
    if (!confirm(`Clear the conversation with ${this.nameFor(this.activePeer)}?`))
      return;
    delete this.convos[this.activePeer];
    delete this.unread[this.activePeer];
    this._save();
    this._renderAll();
  }

  _resize() {
    this._input.style.height = "auto";
    this._input.style.height = Math.min(this._input.scrollHeight, 120) + "px";
  }

  // ---- rendering ----

  _keys() {
    const keys = new Set([
      EVERYONE,
      ...Object.keys(this.ui.peerInfo),
      ...Object.keys(this.convos).filter((k) => k !== EVERYONE),
    ]);
    return [...keys];
  }

  _renderAll() {
    const hasAnything =
      Object.keys(this.ui.peerInfo).length > 0 ||
      Object.keys(this.convos).some((k) => this.convos[k].length);
    $("mp-empty").classList.toggle("hidden", hasAnything);
    $("mp-body").classList.toggle("hidden", !hasAnything);
    if (!hasAnything) return;

    if (!this.activePeer) this.activePeer = EVERYONE;
    this._renderPeerbar();
    this._renderTimeline();
    this._renderBadges();
  }

  _renderPeerbar() {
    const bar = $("mp-peerbar");
    if (!bar) return;
    bar.innerHTML = "";

    this._keys().forEach((key) => {
      const chip = document.createElement("button");
      chip.className = "mp-peer-chip";
      if (key === this.activePeer) chip.classList.add("active");
      if (key === EVERYONE) {
        chip.appendChild(makeIcon("users"));
      } else {
        const info = this.ui.peerInfo[key];
        chip.appendChild(
          makeIcon(deviceIconName(info ? info.name.type : undefined)),
        );
      }
      const label = document.createElement("span");
      label.textContent = this.nameFor(key);
      chip.appendChild(label);
      if (this.unread[key]) {
        const dot = document.createElement("span");
        dot.className = "unread-dot";
        chip.appendChild(dot);
      }
      chip.addEventListener("click", () => this.openWith(key));
      bar.appendChild(chip);
    });

    const clear = document.createElement("button");
    clear.className = "icon-button sm mp-clear";
    clear.title = "Clear this conversation";
    clear.setAttribute("aria-label", clear.title);
    clear.appendChild(makeIcon("trash-2"));
    clear.addEventListener("click", () => this._clearActive());
    bar.appendChild(clear);
  }

  _renderTimeline() {
    this._timeline.innerHTML = "";
    const msgs = this.convos[this.activePeer] || [];
    if (!msgs.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      const p = document.createElement("p");
      if (this.activePeer === EVERYONE) {
        p.appendChild(document.createTextNode("Message "));
        const strong = document.createElement("strong");
        strong.textContent = "every device on this network";
        p.appendChild(strong);
        p.appendChild(
          document.createTextNode(" at once. Replies come back here too."),
        );
      } else {
        p.appendChild(document.createTextNode("Message "));
        const strong = document.createElement("strong");
        strong.textContent = this.nameFor(this.activePeer);
        p.appendChild(strong);
        p.appendChild(
          document.createTextNode(
            ". Text, links and files stay between your devices.",
          ),
        );
      }
      empty.appendChild(p);
      this._timeline.appendChild(empty);
      return;
    }

    let lastDate = null;
    msgs.forEach((msg) => {
      const dateStr = new Date(msg.time).toLocaleDateString([], {
        weekday: "long",
        month: "short",
        day: "numeric",
      });
      if (dateStr !== lastDate) {
        const sep = document.createElement("div");
        sep.className = "chat-date-sep";
        sep.textContent = dateStr;
        this._timeline.appendChild(sep);
        lastDate = dateStr;
      }
      this._appendEntry(msg);
    });
    this._scrollBottom();
  }

  _appendEntry(msg) {
    const row = document.createElement("div");
    row.className = `chat-row ${msg.sent ? "sent" : "received"}`;

    // In the group conversation, name who said it
    if (!msg.sent && this.activePeer === EVERYONE && msg.senderName) {
      const sender = document.createElement("div");
      sender.className = "chat-sender";
      sender.textContent = msg.senderName;
      row.appendChild(sender);
    }

    let bubble;
    if (msg.kind === "file") {
      bubble = document.createElement("div");
      bubble.className = "chat-file";
      if (msg.url) {
        const img = document.createElement("img");
        img.className = "chat-file-thumb";
        img.src = msg.url;
        img.alt = msg.name;
        bubble.appendChild(img);
      } else {
        bubble.appendChild(
          makeIcon(fileIconName(msg.mime), "icon file-type-icon"),
        );
        const text = document.createElement("div");
        text.className = "chat-file-text";
        const name = document.createElement("div");
        name.className = "chat-file-name";
        name.textContent = msg.name;
        const size = document.createElement("div");
        size.className = "chat-file-size";
        size.textContent = formatSize(msg.size);
        text.append(name, size);
        bubble.appendChild(text);
      }
    } else {
      bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      this._renderContent(bubble, msg.text);
    }

    const time = document.createElement("div");
    time.className = "chat-time";
    time.textContent = formatClock(msg.time);

    row.append(bubble, time);
    this._timeline.appendChild(row);
    Motion.pulse(bubble);
  }

  _renderContent(bubble, text) {
    const trimmed = text.trim();

    if (isURL(trimmed) && isImageURL(trimmed)) {
      bubble.classList.add("bubble-image");
      const img = document.createElement("img");
      img.src = trimmed;
      img.alt = "Image";
      img.className = "chat-inline-image";
      img.addEventListener("click", () =>
        window.open(trimmed, "_blank", "noopener,noreferrer"),
      );
      img.addEventListener("error", () => {
        bubble.classList.remove("bubble-image");
        bubble.innerHTML = "";
        this._appendLink(bubble, trimmed);
      });
      bubble.appendChild(img);
      return;
    }

    if (isURL(trimmed)) {
      this._appendLink(bubble, trimmed);
      return;
    }

    const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
    let lastIndex = 0;
    let match;
    const frag = document.createDocumentFragment();
    while ((match = urlPattern.exec(trimmed)) !== null) {
      if (match.index > lastIndex) {
        frag.appendChild(
          document.createTextNode(trimmed.slice(lastIndex, match.index)),
        );
      }
      const a = document.createElement("a");
      a.href = match[0].startsWith("http") ? match[0] : `https://${match[0]}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[0];
      frag.appendChild(a);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < trimmed.length) {
      frag.appendChild(document.createTextNode(trimmed.slice(lastIndex)));
    }
    bubble.appendChild(frag);
  }

  _appendLink(bubble, url) {
    bubble.classList.add("bubble-link");
    const a = document.createElement("a");
    a.href = url.startsWith("http") ? url : `https://${url}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.appendChild(makeIcon("link"));
    const span = document.createElement("span");
    span.textContent = url;
    a.appendChild(span);
    bubble.appendChild(a);
  }

  _scrollBottom() {
    requestAnimationFrame(() => {
      this._timeline.scrollTop = this._timeline.scrollHeight;
    });
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  window.drplUI = new DrplUI();
  window.NotificationManager.init();
  new BackgroundAnimation();
});
