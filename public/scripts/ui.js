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

// ── Motion ───────────────────────────────────────────────────────────────────

// Animation is a CSS class the element wears for the length of one keyframe
// run. No animation library, no external request, and nothing to fall back to
// when a CDN is slow. Hidden tabs and reduced-motion skip straight to the end
// state, which is why every helper is safe to call unconditionally.
const Motion = {
  get ok() {
    return (
      document.visibilityState === "visible" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  },

  _play(el, className, duration) {
    if (!el || !this.ok) return;
    el.classList.remove(className);
    void el.offsetWidth; // restart the animation if it is already running
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), duration);
  },

  rowIn(el, index = 0) {
    if (!el || !this.ok) return;
    el.style.animationDelay = `${Math.min(index, 8) * 30}ms`;
    this._play(el, "anim-row-in", 300 + index * 30);
  },

  rowOut(el, done) {
    if (!el || !this.ok) {
      done();
      return;
    }
    el.classList.add("anim-row-out");
    setTimeout(done, 150);
  },

  paneIn(el) {
    this._play(el, "anim-pane-in", 240);
  },

  pop(el) {
    this._play(el, "anim-pop", 360);
  },

  pulse(el) {
    this._play(el, "anim-pulse", 260);
  },
};

// ── Toasts ───────────────────────────────────────────────────────────────────

// Stacking, self-contained, and capped so a burst of events cannot bury the
// app. Replaces Toastify: one less CDN request and one less third party.
const Toast = {
  MAX: 4,

  show(message, { icon = "info", tone = "", duration = 3200 } = {}) {
    const host = $("toasts");
    if (!host) return null;

    while (host.children.length >= this.MAX) host.firstElementChild.remove();

    const el = document.createElement("div");
    el.className = "toast";
    const iconWrap = document.createElement("span");
    iconWrap.className = `toast-icon${tone ? ` ${tone}` : ""}`;
    iconWrap.appendChild(makeIcon(icon));
    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = message;
    el.append(iconWrap, text);
    host.appendChild(el);

    const dismiss = () => {
      if (!el.isConnected) return;
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 200);
    };
    const timer = setTimeout(dismiss, duration);
    el.addEventListener("click", () => {
      clearTimeout(timer);
      dismiss();
    });
    return el;
  },
};

// ── Clipboard ────────────────────────────────────────────────────────────────

// Copying is the whole point of sending a link or an image between your own
// devices, so it gets a real implementation rather than a best effort.
const Clipboard = {
  async writeText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      return this._legacyText(text);
    }
  },

  // image/png is the one type every browser accepts, so anything else is
  // re-encoded through a canvas instead of failing. The value is handed over
  // as a promise because Safari requires the ClipboardItem to be created
  // while the click that triggered it is still the active gesture.
  async writeImage(blob, mime) {
    if (!navigator.clipboard || !window.ClipboardItem) return false;
    const png = mime === "image/png" ? Promise.resolve(blob) : this._toPng(blob);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": png }),
      ]);
      return true;
    } catch (e) {
      return false;
    }
  },

  _toPng(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob(
          (out) => (out ? resolve(out) : reject(new Error("encode failed"))),
          "image/png",
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode failed"));
      };
      img.src = url;
    });
  },

  // Older WebKit and any non-secure context land here
  _legacyText(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
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
    // Samples belong to a transfer, not to the chart: several transfers can
    // run at once and the chart renders whichever one is in focus.
    this.samples = [];
    this.max = 0;
    window.addEventListener("resize", () => this.draw());
    document.addEventListener("theme-changed", () => this.draw());
  }

  show(samples) {
    this.samples = samples || [];
    this.max = this.samples.reduce((m, v) => Math.max(m, v), 0);
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

// ── Incoming transfer consent ────────────────────────────────────────────────

const CONSENT_SECONDS = 60;

// Holds incoming requests until the person answers. Requests queue rather than
// overwrite each other, and each one declines itself when its timer runs out
// so the sending device always learns the outcome instead of hanging.
class ConsentDialog {
  constructor(ui) {
    this.ui = ui;
    this.queue = [];
    this.active = null;
    this.trusted = new Set(); // devices trusted for this session only
    this._tick = null;

    $("consent-accept").addEventListener("click", () => this._answer(true));
    $("consent-decline").addEventListener("click", () => this._answer(false));
    document
      .querySelector("[data-consent-decline]")
      .addEventListener("click", () => this._answer(false));
    // Escape declines. There is deliberately no keyboard shortcut for
    // accepting: the Accept button takes focus when the dialog opens, so
    // Enter still works there, but a stray Enter aimed at something else
    // cannot pull in files on its own.
    document.addEventListener("keydown", (e) => {
      if (!this.active || e.key !== "Escape") return;
      e.preventDefault();
      this._answer(false);
    });

    Events.on("transfer-request", (e) => this._onRequest(e.detail));
    Events.on("transfer-request-withdrawn", (e) =>
      this._onWithdrawn(e.detail),
    );
    Events.on("peer-left", (e) => this._onPeerLeft(e.detail));
  }

  _onRequest(req) {
    if (this.trusted.has(req.peerId)) {
      this._respond(req, true);
      Toast.show(
        `Receiving files from ${this.ui.peerName(req.peerId)}`,
        { icon: "circle-arrow-down" },
      );
      return;
    }
    this.queue.push(req);
    if (!this.active) this._next();
    else this._renderQueue();
  }

  _onWithdrawn({ transferId }) {
    this.queue = this.queue.filter((r) => r.transferId !== transferId);
    if (this.active && this.active.transferId === transferId) {
      this._close();
      Toast.show("The other device cancelled the request", { icon: "info" });
      this._next();
    } else {
      this._renderQueue();
    }
  }

  _onPeerLeft(peerId) {
    this.queue = this.queue.filter((r) => r.peerId !== peerId);
    if (this.active && this.active.peerId === peerId) {
      this._close();
      this._next();
    } else {
      this._renderQueue();
    }
  }

  _next() {
    this.active = this.queue.shift() || null;
    if (!this.active) {
      this._renderQueue();
      return;
    }
    this._render(this.active);
  }

  _render(req) {
    const name = this.ui.peerName(req.peerId);
    const count = req.files.length;
    $("consent-from").textContent = name;
    $("consent-summary").textContent =
      `${count === 1 ? "1 file" : `${count} files`}, ${formatSize(req.totalSize)}`;

    const list = $("consent-files");
    list.innerHTML = "";
    // Long batches are summarised rather than scrolled past
    req.files.slice(0, 6).forEach((file) => {
      const li = document.createElement("li");
      li.appendChild(makeIcon(fileIconName(file.mime), "icon file-type-icon"));
      const fname = document.createElement("span");
      fname.className = "consent-file-name";
      fname.textContent = file.name;
      const fsize = document.createElement("span");
      fsize.className = "consent-file-size mono";
      fsize.textContent = formatSize(file.size);
      li.append(fname, fsize);
      list.appendChild(li);
    });
    if (count > 6) {
      const li = document.createElement("li");
      li.className = "consent-file-more";
      li.textContent = `and ${count - 6} more`;
      list.appendChild(li);
    }

    $("consent-trust").checked = false;
    $("consent").classList.remove("hidden");
    Motion.paneIn(document.querySelector(".consent-panel"));
    $("consent-accept").focus();

    this._startTimer(req);
    this._renderQueue();
  }

  _startTimer(req) {
    clearInterval(this._tick);
    const badge = $("consent-timer");
    const update = () => {
      const left = Math.max(
        0,
        Math.ceil((req.expiresAt - Date.now()) / 1000),
      );
      badge.textContent = `${left}s`;
      badge.classList.toggle("failed", left <= 10);
      badge.classList.toggle("neutral", left > 10);
      if (left <= 0) this._answer(false, "no-response");
    };
    update();
    this._tick = setInterval(update, 250);
  }

  _renderQueue() {
    const el = $("consent-queue");
    el.classList.toggle("hidden", this.queue.length === 0);
    if (this.queue.length) {
      el.textContent =
        this.queue.length === 1
          ? "1 more request waiting"
          : `${this.queue.length} more requests waiting`;
    }
  }

  _answer(accepted, reason) {
    const req = this.active;
    if (!req) return;
    if (accepted && $("consent-trust").checked) this.trusted.add(req.peerId);
    this._respond(req, accepted, reason);
    this._close();

    const name = this.ui.peerName(req.peerId);
    if (!accepted) {
      Toast.show(
        reason === "no-response"
          ? `No answer in time, so the transfer from ${name} was declined`
          : `Declined the files from ${name}`,
        { icon: "x" },
      );
    }
    this._next();
  }

  _respond(req, accepted, reason) {
    Events.fire("respond-to-transfer", {
      peerId: req.peerId,
      transferId: req.transferId,
      accepted,
      reason,
    });
  }

  _close() {
    clearInterval(this._tick);
    this._tick = null;
    this.active = null;
    $("consent").classList.add("hidden");
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
    this.consent = new ConsentDialog(this);

    this._initTabs();
    this._initSidebar();
    this._initNetworkEvents();
    this._initAboutEscape();
    this._initDropzone();
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

    Events.on("peer-connection-changed", (e) => {
      const d = e.detail;

      // The row dims the moment the direct connection to that device drops
      // (lid closed, phone locked, tab gone) and lights back up when it
      // returns - the server's own sweep removes it for good if the device
      // never comes back. Honest state, seconds after it changes.
      const row = $(`peer-${d.peerId}`);
      if (row) {
        row.classList.toggle("unreachable", !d.connected);
        row.title = d.connected
          ? ""
          : `Connection to ${this.peerName(d.peerId)} was interrupted. Reconnecting...`;
      }

      // Falling back to the relay means the files pass through the signaling
      // server instead of going device to device. That is a privacy change,
      // so it is stated plainly rather than left in a stats row.
      if (d.transport !== "ws" || !d.connected) return;
      if (this._relayWarned && this._relayWarned.has(d.peerId)) return;
      (this._relayWarned = this._relayWarned || new Set()).add(d.peerId);
      Toast.show(
        `Could not open a direct connection to ${this.peerName(d.peerId)}. Falling back to relaying through the server.`,
        { icon: "circle-alert", tone: "bad", duration: 6000 },
      );
    });
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
    if (existing) existing.remove();
    this._addPeer(peer, 0);
    this._updateCount();
  }

  _onPeerLeft(peerId) {
    delete this.peerInfo[peerId];
    // The count reads from peerInfo, so it is already correct; the row just
    // has to finish animating out before it goes.
    const el = $(`peer-${peerId}`);
    if (el) Motion.rowOut(el, () => el.remove());
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
    input.onchange = (e) => this.sendFiles(e.target.files, peerId);
    input.click();
  }

  // Open the file picker for a conversation key, which may be a device or the
  // Everyone group
  sendFilesFromPicker(to) {
    if (to === EVERYONE) {
      this.pickAndSendToAll();
      return;
    }
    if (!this.peerInfo[to]) {
      Toast.show("That device is offline right now", { icon: "wifi-off" });
      return;
    }
    this.pickAndSend(to);
  }

  // Pick once, send to every connected device
  pickAndSendToAll() {
    if (!Object.keys(this.peerInfo).length) {
      Toast.show("No devices to send to right now", { icon: "wifi-off" });
      return;
    }
    const input = $("file-input");
    input.value = "";
    input.onchange = (e) => this.sendFiles(e.target.files, EVERYONE);
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

  // ---- drag and drop ----

  // Drop on a device row to send to that device, or anywhere else to send to
  // whoever the Messages tab is pointed at. The dragged-over device row is
  // highlighted, so the target is never a guess.
  _initDropzone() {
    const zone = $("dropzone");
    let depth = 0;

    const hasFiles = (e) =>
      e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

    const target = () => {
      const ids = Object.keys(this.peerInfo);
      if (!ids.length) return null;
      const active = this.messages.activePeer;
      if (active && (active === EVERYONE || this.peerInfo[active])) {
        return active;
      }
      return ids.length === 1 ? ids[0] : null;
    };

    const describe = (peerRow) => {
      if (peerRow) return `Send to ${this.peerName(peerRow)}`;
      const to = target();
      if (!to) return "Drop on a device to send";
      if (to === EVERYONE) return "Send to every device";
      return `Send to ${this.peerName(to)}`;
    };

    document.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      zone.classList.remove("hidden");
    });

    document.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const row = e.target.closest && e.target.closest(".peer");
      document
        .querySelectorAll(".peer.drop-target")
        .forEach((el) => el.classList.remove("drop-target"));
      if (row) row.classList.add("drop-target");
      $("dropzone-text").textContent = describe(
        row ? row.id.replace("peer-", "") : null,
      );
    });

    document.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) this._endDrag();
    });

    document.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      const row = e.target.closest && e.target.closest(".peer");
      this._endDrag();

      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;

      const to = row ? row.id.replace("peer-", "") : target();
      if (!to) {
        Toast.show(
          Object.keys(this.peerInfo).length
            ? "Drop the files on a device to choose where they go"
            : "No devices to send to right now",
          { icon: "circle-alert", tone: "bad" },
        );
        return;
      }
      this.sendFiles(files, to);
    });
  }

  _endDrag() {
    $("dropzone").classList.add("hidden");
    document
      .querySelectorAll(".peer.drop-target")
      .forEach((el) => el.classList.remove("drop-target"));
  }

  // One route for every way files get sent: picker, drag and drop, paste
  sendFiles(files, to) {
    const list = Array.from(files);
    if (!list.length) return;
    if (to === EVERYONE) {
      const ids = Object.keys(this.peerInfo);
      if (!ids.length) {
        Toast.show("No devices to send to right now", { icon: "wifi-off" });
        return;
      }
      this.messages.logGroupFiles(list, ids);
      ids.forEach((id) => Events.fire("files-selected", { files: list, to: id }));
      return;
    }
    if (!this.peerInfo[to]) {
      Toast.show("That device is no longer available", { icon: "wifi-off" });
      return;
    }
    Events.fire("files-selected", { files: list, to });
  }

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
  declined: "The other device declined the files.",
  "no-response":
    "The other device did not answer within a minute, so nothing was sent.",
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
    // Several transfers can be in flight at once (two devices sending to you,
    // or sending while receiving). Each is tracked by id; the card shows the
    // focused one and "Also running" lists the rest.
    this.byId = new Map();
    this.focusId = null;
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

    Events.on("transfer-pending", (e) => this._onPending(e.detail));
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

    $("tp-others").addEventListener("click", (e) => {
      const row = e.target.closest("[data-transfer-id]");
      if (row) this._focus(row.dataset.transferId);
    });

    setInterval(() => this._tick(), 500);
    this._renderSession();
  }

  // The transfer the detail card is showing
  get current() {
    return (this.focusId && this.byId.get(this.focusId)) || null;
  }

  _isLive(t) {
    return t && !t.done && !t.error;
  }

  _liveCount() {
    let n = 0;
    this.byId.forEach((t) => {
      if (this._isLive(t)) n++;
    });
    return n;
  }

  _focus(transferId) {
    if (!this.byId.has(transferId) || this.focusId === transferId) return;
    this.focusId = transferId;
    this._renderAll();
  }

  // Waiting on the other device to accept. Shown as its own state so it is
  // obvious nothing has been sent yet.
  _onPending(d) {
    this._pruneFinished();
    this.byId.set(d.transferId, {
      peerId: d.peerId,
      transferId: d.transferId,
      direction: d.direction,
      files: d.files,
      totalSize: d.totalSize,
      bytes: 0,
      doneCount: 0,
      activeIndex: -1,
      startedAt: Date.now(),
      expiresAt: d.expiresAt,
      pending: true,
      speed: null,
      peak: 0,
      samples: [],
      done: false,
      error: null,
      _lastBytes: 0,
      _lastTime: Date.now(),
    });
    this.focusId = d.transferId;
    this._renderAll();
    this.ui.switchTab("pane-transfers");
  }

  _pruneFinished() {
    this.byId.forEach((t, id) => {
      if (!this._isLive(t) && id !== this.focusId) this.byId.delete(id);
    });
  }

  _onStarted(d) {
    // A send that was waiting for consent keeps its card and drops the
    // pending state rather than starting a second one.
    const waiting = this.byId.get(d.transferId);
    if (waiting) {
      waiting.pending = false;
      waiting.startedAt = Date.now();
      waiting._lastTime = Date.now();
      this.focusId = d.transferId;
      WakeLock.acquire();
      this._renderAll();
      return;
    }

    this._pruneFinished();

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
      pending: false,
      speed: null,
      peak: 0,
      samples: [],
      done: false,
      error: null,
      _lastBytes: 0,
      _lastTime: Date.now(),
    };
    this.byId.set(d.transferId, state);
    this.focusId = d.transferId;
    WakeLock.acquire();
    this._renderAll();
    this.ui.switchTab("pane-transfers");
  }

  _onProgress(d) {
    const t = this.byId.get(d.transferId);
    if (!t || t.done) return;
    t.bytes = Math.max(t.bytes, Math.min(d.bytes, t.totalSize));

    const now = Date.now();
    const dt = now - t._lastTime;
    if (dt >= 250) {
      const inst = ((t.bytes - t._lastBytes) / dt) * 1000;
      if (inst >= 0) {
        t.speed = t.speed === null ? inst : t.speed * 0.7 + inst * 0.3;
        t.peak = Math.max(t.peak, inst);
        t.samples.push(inst);
        if (t.samples.length > 150) t.samples.shift();
        if (t === this.current) {
          this.chart.show(t.samples);
          $("tp-chart-max").textContent = `peak ${formatSpeed(t.peak)}`;
        }
      }
      t._lastBytes = t.bytes;
      t._lastTime = now;
    }
    if (t === this.current) this._renderProgress(t);
    else this._renderOthers();
  }

  _onFileActive(d) {
    const t = this.byId.get(d.transferId);
    if (!t) return;
    t.activeIndex = d.index;
    if (t === this.current) this._renderFiles(t);
  }

  _onFileDone(d) {
    const t = this.byId.get(d.transferId);
    if (!t) return;
    t.doneCount = Math.max(t.doneCount, d.index + 1);
    if (t !== this.current) return;
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
    const t = this.byId.get(d.transferId);

    this.session.count++;
    if (d.direction === "send") {
      this.session.sentBytes += d.totalSize;
      this.session.sentFiles += d.fileCount;
    } else {
      this.session.recvBytes += d.totalSize;
      this.session.recvFiles += d.fileCount;
    }
    if (t) this.session.peak = Math.max(this.session.peak, t.peak || 0);
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

    if (t) {
      t.done = true;
      t.bytes = t.totalSize;
      t.duration = d.duration;
      if (t === this.current) this._renderAll();
      else this.byId.delete(d.transferId);
    }
    this._renderOthers();
    // Other transfers may still be running; the screen has to stay awake
    if (!this._liveCount()) WakeLock.release();

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
    const t = this.byId.get(d.transferId);
    this.session.count++;
    this._renderSession();
    this._pushRecent({
      direction: d.direction,
      peerName: this.ui.peerName(d.peerId),
      fileCount: t ? t.files.length : 0,
      totalSize: t ? t.totalSize : 0,
      duration: 0,
      status:
        d.reason === "declined" || d.reason === "no-response"
          ? "declined"
          : "failed",
      at: Date.now(),
    });

    if (t) {
      t.error = d.reason || "cancelled";
      if (t === this.current) this._renderAll();
      else this.byId.delete(d.transferId);
    }
    this._renderOthers();
    if (!this._liveCount()) WakeLock.release();

    if (this.ui.activeTab !== "pane-transfers") {
      Toast.show(CANCEL_REASONS[d.reason] || CANCEL_REASONS.cancelled, {
        icon: "circle-alert",
        tone: "bad",
      });
    }
  }

  _tick() {
    const t = this.current;
    if (!this._isLive(t)) return;
    if (t.pending) {
      this._renderProgress(t);
      return;
    }
    $("st-elapsed").textContent = formatDuration(Date.now() - t.startedAt);
    this._renderLiveInternals(t);
    this._renderOthers();
  }

  redraw() {
    this.chart.draw();
  }

  // Drops the focused transfer from the card. If others are still running,
  // focus one of them rather than falling back to the empty state.
  _clearLive() {
    if (this.focusId) this.byId.delete(this.focusId);
    this.focusId = null;
    for (const [id, t] of this.byId) {
      if (this._isLive(t)) {
        this.focusId = id;
        break;
      }
    }
    if (this.focusId) {
      this._renderAll();
      return;
    }
    $("tp-live").classList.add("hidden");
    $("tp-empty").classList.remove("hidden");
    this._renderOthers();
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
    const refused = t.error === "declined" || t.error === "no-response";
    if (t.error) {
      badge.classList.add(refused ? "queued" : "failed");
      label = refused ? "Declined" : "Failed";
      $("tp-live").setAttribute("data-state", refused ? "declined" : "failed");
    } else if (t.done) {
      badge.classList.add("done");
      label = t.direction === "send" ? "Sent" : "Received";
      $("tp-live").setAttribute("data-state", "done");
    } else if (t.pending) {
      badge.classList.add("queued");
      label = "Waiting";
      $("tp-live").setAttribute("data-state", "pending");
    } else {
      badge.classList.add(t.direction === "send" ? "sending" : "receiving");
      label = t.direction === "send" ? "Sending" : "Receiving";
      $("tp-live").setAttribute("data-state", "live");
    }
    badge.textContent = label;

    $("tp-title").textContent =
      `${t.direction === "send" ? "to" : "from"} ${this.ui.peerName(t.peerId)}`;

    const files = t.files.length === 1 ? "1 file" : `${t.files.length} files`;
    if (t.error) {
      $("tp-sub").textContent =
        CANCEL_REASONS[t.error] || CANCEL_REASONS.cancelled;
    } else if (t.pending) {
      $("tp-sub").textContent =
        `${files}, ${formatSize(t.totalSize)}. Nothing is sent until ${this.ui.peerName(t.peerId)} accepts.`;
    } else {
      $("tp-sub").textContent = `${files}, ${formatSize(t.totalSize)} total`;
    }

    const action = $("tp-action");
    if (!t.done && !t.error) {
      action.textContent = t.pending ? "Withdraw" : "Cancel";
      action.classList.add("danger-text");
    } else if (t.done && t.direction === "receive") {
      action.textContent = "Open in Files";
      action.classList.remove("danger-text");
    } else {
      action.textContent = "Clear";
      action.classList.remove("danger-text");
    }

    this.chart.show(t.samples);
    $("tp-chart-max").textContent = t.peak ? `peak ${formatSpeed(t.peak)}` : "";

    this._renderProgress(t);
    this._renderStats(t);
    this._renderFiles(t);
    this._renderOthers();
  }

  // Compact rows for everything running that the card is not showing.
  // Progress ticks several times a second, so rows are updated in place and
  // only rebuilt when the set of transfers actually changes.
  _renderOthers() {
    const wrap = $("tp-others-wrap");
    const list = $("tp-others");
    const others = [];
    this.byId.forEach((t, id) => {
      if (id !== this.focusId && this._isLive(t)) others.push(t);
    });

    wrap.classList.toggle("hidden", others.length === 0);
    $("tp-others-count").textContent = others.length;
    if (!others.length) {
      list.innerHTML = "";
      this._otherIds = "";
      return;
    }

    const ids = others.map((t) => t.transferId).join(",");
    if (ids === this._otherIds) {
      others.forEach((t) => {
        const row = list.querySelector(
          `[data-transfer-id="${t.transferId}"]`,
        );
        if (!row) return;
        row.querySelector(".recent-meta").textContent = this._otherMeta(t);
        row.querySelector(".tp-other-pct").textContent = this._otherPct(t);
      });
      return;
    }
    this._otherIds = ids;

    list.innerHTML = "";
    others.forEach((t) => {
      const li = document.createElement("li");
      li.className = "tp-other";
      li.dataset.transferId = t.transferId;
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", "0");
      li.title = "Show this transfer";

      li.appendChild(
        makeIcon(
          t.direction === "send" ? "circle-arrow-up" : "circle-arrow-down",
        ),
      );

      const text = document.createElement("div");
      text.className = "recent-text";
      const title = document.createElement("span");
      title.className = "recent-title";
      const files =
        t.files.length === 1 ? "1 file" : `${t.files.length} files`;
      title.textContent = `${files} ${t.direction === "send" ? "to" : "from"} ${this.ui.peerName(t.peerId)}`;
      const meta = document.createElement("span");
      meta.className = "recent-meta";
      meta.textContent = this._otherMeta(t);
      text.append(title, meta);
      li.appendChild(text);

      const pct = document.createElement("span");
      pct.className = "mono tp-other-pct";
      pct.textContent = this._otherPct(t);
      li.appendChild(pct);

      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this._focus(t.transferId);
        }
      });

      list.appendChild(li);
    });
  }

  _otherMeta(t) {
    if (t.pending) return `Waiting to be accepted, ${formatSize(t.totalSize)}`;
    return `${formatSize(t.bytes)} of ${formatSize(t.totalSize)}${
      t.speed ? `, ${formatSpeed(t.speed)}` : ""
    }`;
  }

  _otherPct(t) {
    if (t.pending) return "--";
    const pct = t.totalSize > 0 ? (t.bytes / t.totalSize) * 100 : 0;
    return `${Math.floor(pct)}%`;
  }

  _renderProgress(t) {
    const pct = t.totalSize > 0 ? t.bytes / t.totalSize : t.done ? 1 : 0;
    $("tp-percent").textContent = t.pending
      ? "--"
      : `${Math.floor(pct * 100)}%`;
    $("tp-bar").style.width = `${pct * 100}%`;

    if (t.pending) {
      const left = Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 1000));
      $("tp-progress-stats").textContent = `Expires in ${left}s`;
    } else if (t.error) {
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
      const tone =
        r.status === "done"
          ? "done"
          : r.status === "declined"
            ? "queued"
            : "failed";
      badgeEl.className = `state-badge ${tone}`;
      badgeEl.textContent =
        r.status === "done"
          ? r.direction === "send"
            ? "Sent"
            : "Received"
          : r.status === "declined"
            ? "Declined"
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

  byId(id) {
    return this.files.find((f) => f.id === id) || null;
  }

  // Used by the Messages tab to jump from a file bubble to the full preview
  openById(id) {
    const index = this.files.findIndex((f) => f.id === id);
    if (index < 0) return false;
    this.ui.switchTab("pane-files");
    this._openDetail(index);
    return true;
  }

  saveById(id) {
    const file = this.byId(id);
    if (!file) return false;
    this._download(file);
    return true;
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
    if (total >= 0xffffffff) {
      Toast.show(
        "This batch is too large for a single zip. Save the files one by one.",
        { icon: "circle-alert", tone: "bad", duration: 5000 },
      );
      return;
    }
    if (
      total > 512 * 1024 * 1024 &&
      !confirm(
        `Package ${formatSize(total)} into one zip in the browser? On phones this can run out of memory. Cancel to save files one by one.`,
      )
    ) {
      return;
    }
    Toast.show("Packaging files", { icon: "archive" });
    try {
      const used = new Set();
      const entries = this.files.map((f) => {
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
        return { name, blob: f.blob, date: f.receivedAt };
      });
      const blob = await buildZip(entries);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "drpl-files.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      Toast.show("Could not build the zip. Save the files one by one.", {
        icon: "circle-alert",
        tone: "bad",
      });
    }
  }
}

// ── Zip writer ───────────────────────────────────────────────────────────────

/**
 * Writes a stored (uncompressed) zip. Replaces the JSZip CDN load: these
 * files already arrived over the network once, so pulling a library from a
 * third party just to box them up would be the only outside request the app
 * makes.
 *
 * Stored entries mean no compression work, which is the right trade here
 * because the batch is usually photos and video that will not compress. File
 * data is passed through as Blob slices, so only the checksum pass touches
 * memory. Sizes are 32 bit, which is why the caller rejects batches at 4 GB
 * rather than writing an archive no tool would open.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const CRC_CHUNK = 8 * 1024 * 1024;

async function crc32OfBlob(blob) {
  let state = -1;
  for (let offset = 0; offset < blob.size; offset += CRC_CHUNK) {
    const bytes = new Uint8Array(
      await blob.slice(offset, offset + CRC_CHUNK).arrayBuffer(),
    );
    for (let i = 0; i < bytes.length; i++) {
      state = (state >>> 8) ^ CRC_TABLE[(state ^ bytes[i]) & 0xff];
    }
  }
  return (state ^ -1) >>> 0;
}

// MS-DOS packed date and time, which is what the zip format stores
function dosDateTime(ts) {
  const d = new Date(ts || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time:
      ((d.getHours() << 11) |
        (d.getMinutes() << 5) |
        (Math.floor(d.getSeconds() / 2) & 0x1f)) &
      0xffff,
    date:
      (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

async function buildZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = await crc32OfBlob(entry.blob);
    const size = entry.blob.size;
    const { time, date } = dosDateTime(entry.date);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 file names
    local.setUint16(8, 0, true); // stored, no compression
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // no extra field

    parts.push(local.buffer, nameBytes, entry.blob);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); // central directory header
    dir.setUint16(4, 20, true); // version made by
    dir.setUint16(6, 20, true); // version needed
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, size, true);
    dir.setUint32(24, size, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint16(30, 0, true); // extra
    dir.setUint16(32, 0, true); // comment
    dir.setUint16(34, 0, true); // disk number
    dir.setUint16(36, 0, true); // internal attributes
    dir.setUint32(38, 0, true); // external attributes
    dir.setUint32(42, offset, true); // offset of local header
    central.push(dir.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralOffset = offset;
  const centralSize = central.reduce(
    (sum, part) => sum + (part.byteLength || part.length),
    0,
  );

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(4, 0, true); // this disk
  end.setUint16(6, 0, true); // disk with central directory
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);
  end.setUint16(20, 0, true); // no comment

  return new Blob([...parts, ...central, end.buffer], {
    type: "application/zip",
  });
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
    // Files this device sent, kept for the session so their bubbles stay
    // actionable. Not persisted: a Blob cannot go into localStorage.
    this.sentFiles = new Map();
    this._sentSeq = 0;

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
    this._input.addEventListener("paste", (e) => this._onPaste(e));
    $("mp-attach").addEventListener("click", () => {
      if (!this.activePeer) return;
      this.ui.sendFilesFromPicker(this.activePeer);
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

    Events.on("text-sent", (e) => this._onTextSent(e.detail));
    Events.on("text-delivered", (e) => this._onTextDelivered(e.detail));

    // File activity shows up in the conversation timeline
    Events.on("files-selected", (e) => {
      const to = e.detail.to;
      if (this._suppressLog && this._suppressLog.has(to)) {
        this._suppressLog.delete(to);
        return;
      }
      Array.from(e.detail.files).forEach((f) => this._logSentFile(to, f));
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
          fileId: d.id,
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

  // Sent files stay reachable for the session so the bubble can preview and
  // save them, the same as a received one.
  _logSentFile(key, file) {
    const id = `s${Date.now().toString(36)}-${this._sentSeq++}`;
    this.sentFiles.set(id, file);
    this._addEntry(
      key,
      {
        kind: "file",
        sent: true,
        time: Date.now(),
        sentFileId: id,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        url:
          file.type && file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : null,
      },
      { silent: true },
    );
  }

  // Group file sends log once under Everyone; the per-peer events that
  // follow are suppressed so the timeline shows one entry per file
  logGroupFiles(files, peerIds) {
    this._suppressLog = new Set(peerIds);
    Array.from(files).forEach((f) => this._logSentFile(EVERYONE, f));
  }

  // Pasting an image into the composer sends it, which is the fastest way to
  // move a screenshot between two machines.
  _onPaste(e) {
    if (!this.activePeer || !e.clipboardData) return;
    const files = Array.from(e.clipboardData.files || []);
    if (!files.length) return;
    e.preventDefault();
    const named = files.map((f) =>
      f.name && f.name !== "image.png"
        ? f
        : new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${(f.type.split("/")[1] || "png")}`, {
            type: f.type,
          }),
    );
    this.ui.sendFiles(named, this.activePeer);
  }

  _onTextSent(d) {
    if (!d || !d.localId) return;
    const entry = this._findByLocalId(d.localId);
    if (!entry) return;
    entry.messageIds = d.messageIds;
    entry.recipients = d.recipients;
    entry.status = "sent";
    this._refreshEntry(entry);
  }

  _onTextDelivered(d) {
    if (!d || !d.id) return;
    for (const key of Object.keys(this.convos)) {
      for (const entry of this.convos[key]) {
        if (entry.messageIds && entry.messageIds.includes(d.id)) {
          entry.delivered = (entry.delivered || 0) + 1;
          if (entry.delivered >= (entry.recipients || 1)) {
            entry.status = "delivered";
          }
          this._refreshEntry(entry);
          return;
        }
      }
    }
  }

  _findByLocalId(localId) {
    for (const key of Object.keys(this.convos)) {
      const found = this.convos[key].find((e) => e.localId === localId);
      if (found) return found;
    }
    return null;
  }

  // Re-render just the row that changed rather than the whole timeline
  _refreshEntry(entry) {
    if (!entry.localId) return;
    const row = this._timeline.querySelector(
      `[data-local-id="${entry.localId}"]`,
    );
    if (!row) return;
    const status = row.querySelector(".chat-status");
    if (status) this._paintStatus(status, entry);
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
          // Blobs cannot be stored, so a reloaded file entry keeps its
          // details but loses its actions until the file is sent again.
          status: e.st,
          recipients: e.rc,
          delivered: e.dv,
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
            : {
                k: "t",
                s: e.sent ? 1 : 0,
                t: e.time,
                x: e.text,
                n: e.senderName,
                st: e.status,
                rc: e.recipients,
                dv: e.delivered,
              },
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

    const toEveryone = this.activePeer === EVERYONE;
    if (toEveryone && !Object.keys(this.ui.peerInfo).length) {
      Toast.show("No devices to message right now", { icon: "wifi-off" });
      return;
    }
    if (!toEveryone && !this.ui.peerInfo[this.activePeer]) {
      Toast.show("That device is offline right now", { icon: "wifi-off" });
      return;
    }

    // The entry has to exist before the send fires, because the acknowledgement
    // that flips it to delivered can come back in the same tick.
    const localId = `l${Date.now().toString(36)}-${this._sentSeq++}`;
    this._addEntry(this.activePeer, {
      kind: "text",
      sent: true,
      time: Date.now(),
      text,
      localId,
      status: "sending",
    });

    Events.fire("send-text", {
      to: toEveryone ? "*" : this.activePeer,
      text,
      localId,
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
      const target =
        this.activePeer === EVERYONE
          ? "every device on this network"
          : this.nameFor(this.activePeer);
      p.appendChild(document.createTextNode("Send a link, a note or a file to "));
      const strong = document.createElement("strong");
      strong.textContent = target;
      p.appendChild(strong);
      p.appendChild(document.createTextNode("."));
      empty.appendChild(p);

      const hint = document.createElement("p");
      hint.className = "chat-empty-hint";
      hint.textContent =
        "Anything that arrives can be copied with one click. Paste an image here to send it straight away.";
      empty.appendChild(hint);
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
    if (msg.localId) row.dataset.localId = msg.localId;

    // In the group conversation, name who said it
    if (!msg.sent && this.activePeer === EVERYONE && msg.senderName) {
      const sender = document.createElement("div");
      sender.className = "chat-sender";
      sender.textContent = msg.senderName;
      row.appendChild(sender);
    }

    const bubble =
      msg.kind === "file" ? this._buildFile(msg) : this._buildText(msg);
    row.appendChild(bubble);

    const foot = document.createElement("div");
    foot.className = "chat-foot";
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = formatClock(msg.time);
    foot.appendChild(time);
    if (msg.sent && msg.kind === "text") {
      const status = document.createElement("span");
      status.className = "chat-status";
      this._paintStatus(status, msg);
      foot.appendChild(status);
    }
    row.appendChild(foot);

    this._timeline.appendChild(row);
    Motion.pulse(bubble);
  }

  // Delivery state comes from the receiver acknowledging the message, so this
  // reflects what actually arrived rather than what was handed to the socket.
  _paintStatus(el, msg) {
    el.innerHTML = "";
    el.title = "";
    if (msg.status === "delivered") {
      el.appendChild(makeIcon("check-check", "icon chat-status-icon"));
      el.title = "Delivered";
      return;
    }
    if (msg.status === "sent") {
      const total = msg.recipients || 1;
      if (total > 1) {
        const label = document.createElement("span");
        label.textContent = `${msg.delivered || 0}/${total}`;
        el.appendChild(label);
        el.title = `Delivered to ${msg.delivered || 0} of ${total} devices`;
      } else {
        el.appendChild(makeIcon("check", "icon chat-status-icon"));
        el.title = "Sent";
      }
      return;
    }
    el.appendChild(makeIcon("clock", "icon chat-status-icon"));
    el.title = "Sending";
  }

  // ---- text bubbles ----

  _buildText(msg) {
    const trimmed = (msg.text || "").trim();
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";

    if (isURL(trimmed)) {
      bubble.classList.add("bubble-link");
      bubble.appendChild(this._buildLinkCard(trimmed));
      return bubble;
    }

    const body = document.createElement("div");
    body.className = "chat-text";
    this._renderLinkedText(body, trimmed);
    bubble.appendChild(body);
    bubble.appendChild(
      this._actionBar([
        {
          icon: "copy",
          label: "Copy message",
          run: () => this._copyText(trimmed),
        },
      ]),
    );

    // Clicking anywhere that is not a link copies, which is the thing you
    // almost always want a message on another device for. Selecting text by
    // hand still works: a click that ends a selection is not a copy.
    bubble.addEventListener("click", (e) => {
      if (e.target.closest("a") || e.target.closest(".chat-actions")) return;
      if (String(window.getSelection() || "").length) return;
      this._copyText(trimmed);
    });
    bubble.title = "Click to copy";
    return bubble;
  }

  _buildLinkCard(url) {
    const href = url.startsWith("http") ? url : `https://${url}`;
    const card = document.createElement("div");
    card.className = "link-card";

    let host = url;
    try {
      host = new URL(href).host.replace(/^www\./, "");
    } catch (e) {
      /* keep the raw string */
    }

    const icon = document.createElement("span");
    icon.className = "link-card-icon";
    icon.appendChild(makeIcon("link"));

    const text = document.createElement("div");
    text.className = "link-card-text";
    const hostEl = document.createElement("div");
    hostEl.className = "link-card-host";
    hostEl.textContent = host;
    const urlEl = document.createElement("div");
    urlEl.className = "link-card-url";
    urlEl.textContent = url;
    text.append(hostEl, urlEl);

    card.append(icon, text);
    card.appendChild(
      this._actionBar([
        { icon: "copy", label: "Copy link", run: () => this._copyText(url) },
        {
          icon: "external-link",
          label: "Open link",
          run: () => window.open(href, "_blank", "noopener,noreferrer"),
        },
      ]),
    );
    card.addEventListener("click", (e) => {
      if (e.target.closest(".chat-actions")) return;
      this._copyText(url);
    });
    card.title = "Click to copy, or use Open";
    return card;
  }

  // Links inside a longer message stay clickable; the rest is plain text
  _renderLinkedText(host, text) {
    const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
    let lastIndex = 0;
    let match;
    while ((match = urlPattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        host.appendChild(
          document.createTextNode(text.slice(lastIndex, match.index)),
        );
      }
      const a = document.createElement("a");
      a.href = match[0].startsWith("http") ? match[0] : `https://${match[0]}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[0];
      host.appendChild(a);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      host.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  // ---- file bubbles ----

  _buildFile(msg) {
    const bubble = document.createElement("div");
    bubble.className = "chat-file";
    const isImage = (msg.mime || "").startsWith("image/");
    const available = this._blobFor(msg) !== null;

    if (isImage && msg.url) {
      bubble.classList.add("chat-file-image");
      const img = document.createElement("img");
      img.className = "chat-file-thumb";
      img.src = msg.url;
      img.alt = msg.name;
      img.loading = "lazy";
      bubble.appendChild(img);
      const caption = document.createElement("div");
      caption.className = "chat-file-caption";
      caption.textContent = `${msg.name}, ${formatSize(msg.size)}`;
      bubble.appendChild(caption);
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
      size.textContent = available
        ? formatSize(msg.size)
        : `${formatSize(msg.size)}, no longer held on this device`;
      text.append(name, size);
      bubble.appendChild(text);
    }

    const actions = [];
    if (available && isImage) {
      actions.push({
        icon: "copy",
        label: "Copy image",
        run: () => this._copyImage(msg),
      });
    }
    if (available) {
      actions.push({
        icon: "eye",
        label: "Preview",
        run: () => this._previewFile(msg),
      });
      actions.push({
        icon: "download",
        label: `Save ${msg.name}`,
        run: () => this._saveFile(msg),
      });
    }
    if (actions.length) bubble.appendChild(this._actionBar(actions));

    if (available && isImage) {
      bubble.addEventListener("click", (e) => {
        if (e.target.closest(".chat-actions")) return;
        this._copyImage(msg);
      });
      bubble.title = "Click to copy the image";
    } else if (available) {
      bubble.addEventListener("click", (e) => {
        if (e.target.closest(".chat-actions")) return;
        this._previewFile(msg);
      });
      bubble.title = "Click to preview";
    }

    return bubble;
  }

  _actionBar(actions) {
    const bar = document.createElement("div");
    bar.className = "chat-actions";
    actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.className = "icon-button sm";
      btn.title = action.label;
      btn.setAttribute("aria-label", action.label);
      btn.appendChild(makeIcon(action.icon));
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        action.run();
      });
      bar.appendChild(btn);
    });
    return bar;
  }

  // A received file lives in the Files tab; a sent one is held here for the
  // session. Reloading the page drops both, and the bubble says so.
  _blobFor(msg) {
    if (msg.fileId) {
      const file = this.ui.files.byId(msg.fileId);
      return file ? file.blob : null;
    }
    if (msg.sentFileId) return this.sentFiles.get(msg.sentFileId) || null;
    return null;
  }

  async _copyText(text) {
    const ok = await Clipboard.writeText(text);
    Toast.show(
      ok ? "Copied to clipboard" : "Could not copy. Select the text to copy it",
      {
        icon: ok ? "check" : "circle-alert",
        tone: ok ? "ok" : "bad",
        duration: 1600,
      },
    );
  }

  async _copyImage(msg) {
    const blob = this._blobFor(msg);
    if (!blob) return;
    const ok = await Clipboard.writeImage(blob, msg.mime);
    Toast.show(
      ok ? "Image copied to clipboard" : "This browser will not copy images, use Save",
      {
        icon: ok ? "check" : "circle-alert",
        tone: ok ? "ok" : "bad",
        duration: 1800,
      },
    );
  }

  _previewFile(msg) {
    if (msg.fileId && this.ui.files.openById(msg.fileId)) return;
    const blob = this._blobFor(msg);
    if (!blob) return;
    // A file this device sent is not in the Files tab, so open it directly
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  _saveFile(msg) {
    const blob = this._blobFor(msg);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = msg.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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
  window.drplBackground = new BackgroundAnimation();
});
