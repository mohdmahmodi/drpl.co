/**
 * drpl.co — UI Javascript
 */

const $ = (id) => document.getElementById(id);
const isURL = (text) => /^((https?:\/\/|www)[^\s]+)/g.test(text.toLowerCase());
const isImageURL = (url) =>
  /\.(jpe?g|png|gif|webp|svg|bmp|avif)(\?.*)?$/i.test(url);

// ── Main UI Controller ────────────────────────────────────────────────────────

class DrplUI {
  constructor() {
    this.currentPeer = null;
    this._initEvents();
    this._initDialogs();
    this.sentSound = $("sent-sound");
  }

  _initEvents() {
    Events.on("peer-joined", (e) => this._onPeerJoined(e.detail));
    Events.on("peer-left", (e) => this._onPeerLeft(e.detail));
    Events.on("peers", (e) => this._onPeers(e.detail));
    Events.on("display-name", (e) => this._onDisplayName(e.detail));
    Events.on("peer-connection-established", (e) =>
      this._onPeerConnected(e.detail),
    );

    Events.on("file-progress", (e) => this._onFileProgress(e.detail));
    Events.on("file-send-progress", (e) => this._onFileSendProgress(e.detail));
    Events.on("file-received", (e) => this._onFileReceived(e.detail));
    Events.on("file-transfer-complete", () => this._onFileTransferComplete());
    Events.on("file-send-start", (e) =>
      this._handleFileSendStart(e.detail.files, e.detail.to),
    );
    Events.on("file-receive-start", (e) =>
      this._handleFileReceiveStart(e.detail.header, e.detail.from),
    );

    Events.on("text-received", (e) => this._onTextReceived(e.detail));
    Events.on("notify-user", (e) => this.showToast(e.detail));
    Events.on("file-sent", () => this._playSound());
    Events.on("text-sent", () => this._playSound());

    if ($("manual-refresh"))
      $("manual-refresh").addEventListener("click", () => location.reload());
  }

  _initDialogs() {
    this.dialogs = {
      receive: new ReceiveDialog(),
      chat: new ChatDialog(),
      action: new ActionDialog(),
      transferProgress: new TransferProgressDialog(),
    };
  }

  _playSound() {
    if (this.sentSound) {
      this.sentSound.currentTime = 0;
      this.sentSound.play().catch(() => {});
    }
  }

  _onPeerJoined(peer) {
    if (!$(peer.id)) this._createPeerEl(peer);
  }
  _onPeers(peers) {
    $("peers").innerHTML = "";
    peers.forEach((p) => this._onPeerJoined(p));
  }
  _onPeerLeft(id) {
    const el = $(id);
    if (el) el.remove();
  }
  _onPeerConnected(id) {
    const el = $(id);
    if (el) el.classList.add("connected");
  }

  _onDisplayName(data) {
    const el = $("display-name");
    el.innerHTML = "";
    el.appendChild(document.createTextNode("You are "));
    const span = document.createElement("span");
    span.textContent = data.displayName;
    el.appendChild(span);
    window.drplMyName = data.displayName;
  }

  _onFileProgress(p) {
    const el = $(p.sender);
    if (el) this._setPeerProgress(el, p.progress);
    this.dialogs.transferProgress.updateReceiveProgress(
      p.sender,
      p.progress,
      p.bytesTransferred,
    );
  }

  // FIX: Dedicated handler for sender-side progress events fired from network.js FileChunker
  _onFileSendProgress(p) {
    this.dialogs.transferProgress.updateSendProgress(
      p.to,
      p.progress,
      p.bytesTransferred,
    );
  }

  _onFileReceived(file) {
    this.dialogs.receive.addFile(file);
    this.dialogs.transferProgress.endTransfer(file.sender);
    if (!this.dialogs.receive.element.classList.contains("active"))
      this.dialogs.receive.show();
  }

  _onFileTransferComplete() {
    setTimeout(() => this.dialogs.transferProgress.checkAndHideIfDone(), 600);
  }

  _onTextReceived(msg) {
    this.dialogs.chat.receiveMessage(msg.text, msg.sender);
  }

  showToast(message, duration = 3000) {
    const t = $("toast");
    t.textContent = message;
    t.classList.add("active");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove("active"), duration);
  }

  _createPeerEl(peer) {
    const el = document.createElement("div");
    el.className = "peer";
    el.id = peer.id;

    const iconWrap = document.createElement("div");
    iconWrap.className = "peer-icon";
    const icon = document.createElement("i");
    icon.className = this._deviceIcon(peer.name.type);
    iconWrap.appendChild(icon);

    const prog = document.createElement("div");
    prog.className = "progress-circle";
    const name = document.createElement("div");
    name.className = "peer-name";
    name.textContent = peer.name.displayName;
    const dev = document.createElement("div");
    dev.className = "peer-device";
    dev.textContent = peer.name.deviceName;

    el.appendChild(iconWrap);
    el.appendChild(prog);
    el.appendChild(name);
    el.appendChild(dev);
    el.addEventListener("click", () => {
      this.currentPeer = peer.id;
      this.dialogs.action.show(peer);
    });
    $("peers").appendChild(el);
  }

  _deviceIcon(type) {
    if (type === "mobile") return "fas fa-mobile-alt";
    if (type === "tablet") return "fas fa-tablet-alt";
    return "fas fa-desktop";
  }

  _setPeerProgress(el, progress) {
    if (progress > 0) el.setAttribute("transfer", "true");
    const c = el.querySelector(".progress-circle");
    c.style.setProperty("--progress", `${progress * 100}%`);
    c.setAttribute("data-progress", Math.round(progress * 100));
    if (progress >= 1) setTimeout(() => el.removeAttribute("transfer"), 500);
  }

  _handleFileSendStart(files, peerId) {
    const totalSize = Array.from(files).reduce((s, f) => s + f.size, 0);
    this.dialogs.transferProgress.startSend(
      peerId,
      files.length > 1 ? `${files.length} files` : files[0].name,
      files.length,
      totalSize,
    );
  }

  _handleFileReceiveStart(header, peerId) {
    this.dialogs.transferProgress.startReceive(
      peerId,
      header.name,
      header.size,
    );
    this.dialogs.transferProgress.show();
  }

  refreshConnections() {
    if (window.drplNetwork?.peers?.refreshAllPeers)
      window.drplNetwork.peers.refreshAllPeers();
    if (window.drplNetwork?.server) window.drplNetwork.server._connect();
  }
}

// ── Base Dialog ───────────────────────────────────────────────────────────────

class Dialog {
  constructor(id) {
    this.element = $(id);
    this.element.querySelectorAll('[id^="close-"]').forEach((btn) => {
      btn.addEventListener("click", () => this.hide());
    });
  }
  show() {
    this.element.classList.add("active");
  }
  hide() {
    this.element.classList.remove("active");
    if (window.drplUI)
      setTimeout(() => window.drplUI.refreshConnections(), 300);
  }
}

// ── Receive Dialog ────────────────────────────────────────────────────────────

class ReceiveDialog extends Dialog {
  constructor() {
    super("receive-dialog");
    this.files = [];
    this.currentIndex = 0;
    this.objectUrls = {};
    this.isTransitioning = false;
    this._setupCarousel();
    this._setupDownloadButtons();
    this._setupKeyboard();
    this._setupTouch();
  }

  _setupCarousel() {
    const prev = $("carousel-prev"),
      next = $("carousel-next");
    [prev, next].forEach((b) =>
      b.addEventListener("mousedown", (e) => e.preventDefault()),
    );
    prev.addEventListener("click", (e) => {
      e.preventDefault();
      if (!this.isTransitioning) this.showPrev();
    });
    next.addEventListener("click", (e) => {
      e.preventDefault();
      if (!this.isTransitioning) this.showNext();
    });
    this.carouselContainer = this.element.querySelector(
      ".carousel-item-container",
    );
  }

  _setupDownloadButtons() {
    $("download-current").addEventListener("click", (e) => {
      e.preventDefault();
      if (this.files.length) this._downloadFile(this.files[this.currentIndex]);
    });
    $("download-all").addEventListener("click", (e) => {
      e.preventDefault();
      this._downloadAll();
    });
  }

  _setupKeyboard() {
    this._keyHandler = (e) => {
      if (!this.element.classList.contains("active") || this.isTransitioning)
        return;
      if (e.key === "ArrowLeft") {
        this.showPrev();
        e.preventDefault();
      }
      if (e.key === "ArrowRight") {
        this.showNext();
        e.preventDefault();
      }
      if (e.key === "Escape") {
        this.hide();
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", this._keyHandler, true);
  }

  _setupTouch() {
    let sx,
      sy,
      swiping = false;
    const dc = this.element.querySelector(".dialog-content");
    dc.addEventListener(
      "touchstart",
      (e) => {
        if (this.isTransitioning) return;
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        swiping = true;
      },
      { passive: true },
    );
    dc.addEventListener(
      "touchmove",
      (e) => {
        if (!swiping || !sx) return;
        const dx = sx - e.touches[0].clientX,
          dy = sy - e.touches[0].clientY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10)
          e.preventDefault();
      },
      { passive: false },
    );
    dc.addEventListener(
      "touchend",
      (e) => {
        if (!swiping || this.isTransitioning || !sx) {
          swiping = false;
          return;
        }
        const dx = sx - e.changedTouches[0].clientX,
          dy = sy - e.changedTouches[0].clientY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
          dx > 0 ? this.showNext() : this.showPrev();
          e.preventDefault();
        }
        sx = null;
        sy = null;
        swiping = false;
      },
      { passive: false },
    );
  }

  hide() {
    super.hide();
    this._cleanup();
  }

  _cleanup() {
    for (const k in this.objectUrls) {
      try {
        URL.revokeObjectURL(this.objectUrls[k]);
      } catch (_) {}
    }
    this.files = [];
    this.currentIndex = 0;
    this.objectUrls = {};
    if (this.carouselContainer) this.carouselContainer.innerHTML = "";
    this._updateCounter();
    this._updateNavBtns();
    this._updateSwipeHint();
  }

  addFile(file) {
    this.files.push(file);
    this.objectUrls[file.name] = URL.createObjectURL(file.blob);
    this._updateCounter();
    this._updateNavBtns();
    this._updateSwipeHint();
    if (this.files.length === 1) {
      this.currentIndex = 0;
      this._displayCurrent();
    } else if (this.files.length === 2)
      Events.fire(
        "notify-user",
        "Multiple files received. Swipe or use arrows.",
      );
  }

  _displayCurrent() {
    if (!this.files.length) return;
    this.isTransitioning = true;
    const file = this.files[this.currentIndex];
    const url = this.objectUrls[file.name];
    this.carouselContainer.classList.add("fade-out");
    setTimeout(() => {
      this.carouselContainer.innerHTML = "";
      const item = document.createElement("div");
      item.className = "carousel-item";

      const info = document.createElement("div");
      info.className = "file-info";
      const nm = document.createElement("div");
      nm.className = "file-name";
      nm.textContent = file.name;
      const sz = document.createElement("div");
      sz.className = "file-size";
      sz.textContent = this._fmtSize(file.size);
      info.appendChild(nm);
      info.appendChild(sz);
      item.appendChild(info);

      if (file.mime.startsWith("image/")) {
        const wrap = document.createElement("div");
        wrap.className = "preview";
        const img = document.createElement("img");
        img.src = url;
        img.alt = file.name;
        img.className = "carousel-image";
        wrap.appendChild(img);
        item.appendChild(wrap);
      } else {
        const fi = document.createElement("div");
        fi.className = "file-icon";
        const ic = document.createElement("i");
        ic.className = this._fileIcon(file.mime);
        fi.appendChild(ic);
        item.appendChild(fi);
      }

      this.carouselContainer.appendChild(item);
      this.carouselContainer.classList.remove("fade-out");
      this.carouselContainer.classList.add("fade-in");
      this._updateCounter();
      this._updateNavBtns();
      setTimeout(() => {
        this.carouselContainer.classList.remove("fade-in");
        this.isTransitioning = false;
      }, 300);
    }, 150);
  }

  showNext() {
    if (!this.isTransitioning && this.currentIndex < this.files.length - 1) {
      this.currentIndex++;
      this._displayCurrent();
    }
  }
  showPrev() {
    if (!this.isTransitioning && this.currentIndex > 0) {
      this.currentIndex--;
      this._displayCurrent();
    }
  }

  _updateCounter() {
    const c = $("current-file"),
      t = $("total-files");
    if (c && t) {
      c.textContent = this.files.length ? this.currentIndex + 1 : 0;
      t.textContent = this.files.length;
    }
  }

  _updateNavBtns() {
    const prev = $("carousel-prev"),
      next = $("carousel-next");
    if (!prev || !next) return;
    prev.classList.toggle("disabled", this.currentIndex <= 0);
    prev.toggleAttribute("disabled", this.currentIndex <= 0);
    next.classList.toggle(
      "disabled",
      this.currentIndex >= this.files.length - 1,
    );
    next.toggleAttribute(
      "disabled",
      this.currentIndex >= this.files.length - 1,
    );
  }

  _updateSwipeHint() {
    const c = this.element.querySelector(".file-carousel");
    if (c) c.classList.toggle("multi-file", this.files.length > 1);
  }

  _downloadFile(file) {
    const a = document.createElement("a");
    a.href = this.objectUrls[file.name];
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  _downloadAll() {
    if (!this.files.length) return;
    if (this.files.length === 1) {
      this._downloadFile(this.files[0]);
      return;
    }
    const total = this.files.reduce((s, f) => s + f.size, 0);
    if (
      total > 200 * 1024 * 1024 &&
      !confirm(
        `Compress ${this._fmtSize(total)} in browser?\nThis may use significant memory. Proceed?`,
      )
    )
      return;
    Events.fire("notify-user", "Creating ZIP…");
    const zip = new JSZip();
    this.files.forEach((f) => zip.file(f.name, f.blob));
    zip
      .generateAsync({ type: "blob" })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "drpl-files.zip";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      })
      .catch(() =>
        Events.fire("notify-user", "ZIP failed — download files individually."),
      );
  }

  _fmtSize(b) {
    if (!b) return "0 B";
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(2)} GB`;
  }

  _fileIcon(mime) {
    if (mime.startsWith("image/")) return "fas fa-file-image fa-4x";
    if (mime.startsWith("video/")) return "fas fa-file-video fa-4x";
    if (mime.startsWith("audio/")) return "fas fa-file-audio fa-4x";
    if (mime.startsWith("text/")) return "fas fa-file-alt fa-4x";
    if (mime.includes("pdf")) return "fas fa-file-pdf fa-4x";
    if (mime.includes("zip") || mime.includes("archive"))
      return "fas fa-file-archive fa-4x";
    if (mime.includes("word")) return "fas fa-file-word fa-4x";
    if (mime.includes("sheet") || mime.includes("excel"))
      return "fas fa-file-excel fa-4x";
    return "fas fa-file fa-4x";
  }
}

// ── Transfer Progress Dialog ──────────────────────────────────────────────────
// FIX: Completely separate send vs receive tracking. Sender fires 'file-send-progress'
// from network.js directly, so we get real bytesTransferred on the sender side.

class TransferProgressDialog extends Dialog {
  constructor() {
    super("transfer-progress-dialog");
    this._t = {}; // transfer state keyed by peerId
    $("close-transfer").addEventListener("click", () => this.hide());
  }

  startSend(peerId, filename, totalFiles, totalSize) {
    this._t[peerId] = {
      filename,
      totalFiles,
      totalSize,
      progress: 0,
      currentFile: 1,
      done: false,
      isSender: true,
      lastBytes: 0,
      lastTime: Date.now(),
      speed: null,
    };
    $("transfer-title").textContent = "Sending Files";
    this._render(peerId);
    this.show();
  }

  startReceive(peerId, filename, fileSize) {
    this._t[peerId] = {
      filename,
      totalFiles: 1,
      totalSize: fileSize,
      progress: 0,
      currentFile: 1,
      done: false,
      isSender: false,
      lastBytes: 0,
      lastTime: Date.now(),
      speed: null,
    };
    $("transfer-title").textContent = "Receiving Files";
    this._render(peerId);
  }

  // Called by sender-side progress (real bytes from chunker)
  updateSendProgress(peerId, progress, bytesTransferred) {
    const t = this._t[peerId];
    if (!t || t.done) return;
    t.progress = progress;
    this._calcSpeed(t, bytesTransferred);
    this._render(peerId);
  }

  // Called by receiver-side progress
  updateReceiveProgress(peerId, progress, bytesTransferred) {
    const t = this._t[peerId];
    if (!t || t.done) return;
    t.progress = progress;
    this._calcSpeed(t, bytesTransferred);
    this._render(peerId);
  }

  _calcSpeed(t, bytesTransferred) {
    const now = Date.now();
    const elapsed = (now - t.lastTime) / 1000;
    if (elapsed < 0.4) return;
    const delta = bytesTransferred - t.lastBytes;
    if (delta >= 0) t.speed = delta / elapsed;
    t.lastBytes = bytesTransferred;
    t.lastTime = now;
  }

  endTransfer(peerId) {
    const t = this._t[peerId];
    if (!t) return;
    t.done = true;
    t.progress = 1;
    this._render(peerId);
  }

  checkAndHideIfDone() {
    if (Object.values(this._t).every((t) => t.done)) {
      setTimeout(() => {
        this.hide();
        this._t = {};
      }, 800);
    }
  }

  _render(peerId) {
    const t = this._t[peerId];
    if (!t) return;

    const pct = Math.round(t.progress * 100);
    const pctEl = this.element.querySelector(".progress-percentage");
    if (pctEl) pctEl.textContent = `${pct}%`;

    const ring = this.element.querySelector(".spinner-ring");
    if (ring) ring.style.borderTopColor = t.done ? "#4caf50" : "";

    const fnEl = $("transfer-filename");
    if (fnEl) fnEl.textContent = t.filename;

    const curEl = $("current-transfer-file"),
      totEl = $("total-transfer-files");
    if (curEl) curEl.textContent = t.currentFile;
    if (totEl) totEl.textContent = t.totalFiles;

    const spdEl = $("transfer-speed");
    if (spdEl) {
      if (t.done) spdEl.textContent = "Complete ✓";
      else if (t.speed !== null && t.speed > 0)
        spdEl.textContent = this._fmtSpeed(t.speed);
      else spdEl.textContent = "Check other device...";
    }
  }

  _fmtSpeed(bps) {
    if (bps < 1024) return `${Math.round(bps)} B/s`;
    if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / 1048576).toFixed(1)} MB/s`;
  }
}

// ── Chat Dialog ───────────────────────────────────────────────────────────────

class ChatDialog extends Dialog {
  constructor() {
    super("chat-dialog");
    this._peerId = null;
    this._peerName = null;
    this._convos = {}; // { [peerId]: [{ text, sent, time }] }
    this._unread = {}; // { [peerId]: count }

    this._msgsEl = $("chat-messages");
    this._inputEl = $("chat-input");
    this._sendBtn = $("chat-send-btn");
    this._nameEl = $("chat-peer-name");

    this._sendBtn.addEventListener("click", () => this._send());
    this._inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });
    this._inputEl.addEventListener("input", () => this._resize());

    $("chat-clear").addEventListener("click", () => this._clearConversation());
  }

  openWith(peerId, peerName) {
    this._peerId = peerId;
    this._peerName = peerName;
    if (this._nameEl) this._nameEl.textContent = peerName;
    if (!this._convos[peerId]) this._convos[peerId] = [];
    this._unread[peerId] = 0;
    this._renderAll();
    this.show();
    setTimeout(() => this._inputEl.focus(), 120);
  }

  receiveMessage(text, senderId) {
    if (!this._convos[senderId]) this._convos[senderId] = [];
    const msg = { text, sent: false, time: Date.now() };
    this._convos[senderId].push(msg);

    const isOpen =
      this._peerId === senderId && this.element.classList.contains("active");
    if (isOpen) {
      this._appendBubble(msg);
      this._scrollBottom();
    } else {
      this._unread[senderId] = (this._unread[senderId] || 0) + 1;
      const peerEl = $(senderId);
      const name = peerEl
        ? peerEl.querySelector(".peer-name").textContent
        : "Someone";
      const preview = text.length > 60 ? text.substring(0, 60) + "…" : text;
      Events.fire("notify-user", `💬 ${name}: ${preview}`);
      // Flash the peer icon
      if (peerEl) {
        peerEl.classList.add("has-message");
        setTimeout(() => peerEl.classList.remove("has-message"), 2000);
      }
    }
  }

  _send() {
    const text = this._inputEl.value.trim();
    if (!text || !this._peerId) return;
    Events.fire("send-text", { to: this._peerId, text });
    Events.fire("text-sent");
    const msg = { text, sent: true, time: Date.now() };
    if (!this._convos[this._peerId]) this._convos[this._peerId] = [];
    this._convos[this._peerId].push(msg);
    this._appendBubble(msg);
    this._scrollBottom();
    this._inputEl.value = "";
    this._resize();
  }

  _clearConversation() {
    if (!this._peerId) return;
    if (!confirm("Clear all messages with this contact?")) return;
    this._convos[this._peerId] = [];
    this._renderAll();
  }

  _resize() {
    this._inputEl.style.height = "auto";
    this._inputEl.style.height =
      Math.min(this._inputEl.scrollHeight, 120) + "px";
  }

  _renderAll() {
    this._msgsEl.innerHTML = "";
    const msgs = this._convos[this._peerId] || [];
    if (!msgs.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.innerHTML = `<i class="fas fa-comment-dots"></i><p>Start a conversation with<br><strong>${this._peerName}</strong></p>`;
      this._msgsEl.appendChild(empty);
    } else {
      let lastDate = null;
      msgs.forEach((msg) => {
        const d = new Date(msg.time);
        const dateStr = d.toLocaleDateString([], {
          weekday: "long",
          month: "short",
          day: "numeric",
        });
        if (dateStr !== lastDate) {
          this._appendDateSeparator(dateStr);
          lastDate = dateStr;
        }
        this._appendBubble(msg);
      });
    }
    this._scrollBottom();
  }

  _appendDateSeparator(label) {
    const sep = document.createElement("div");
    sep.className = "chat-date-sep";
    sep.textContent = label;
    this._msgsEl.appendChild(sep);
  }

  _appendBubble(msg) {
    const empty = this._msgsEl.querySelector(".chat-empty");
    if (empty) empty.remove();

    const row = document.createElement("div");
    row.className = `chat-row ${msg.sent ? "sent" : "received"}`;

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";

    this._renderContent(bubble, msg.text);

    const time = document.createElement("div");
    time.className = "chat-time";
    time.textContent = new Date(msg.time).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    row.appendChild(bubble);
    row.appendChild(time);
    this._msgsEl.appendChild(row);
  }

  _renderContent(bubble, text) {
    const trimmed = text.trim();

    // Image URL → render inline image
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
        // fallback to link if image fails to load
        bubble.classList.remove("bubble-image");
        bubble.innerHTML = "";
        this._appendLink(bubble, trimmed);
      });
      bubble.appendChild(img);
      return;
    }

    // Regular URL → styled link card
    if (isURL(trimmed)) {
      this._appendLink(bubble, trimmed);
      return;
    }

    // Plain text — detect embedded URLs and linkify
    const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
    let lastIndex = 0,
      match;
    const frag = document.createDocumentFragment();
    while ((match = urlPattern.exec(trimmed)) !== null) {
      if (match.index > lastIndex)
        frag.appendChild(
          document.createTextNode(trimmed.slice(lastIndex, match.index)),
        );
      const a = document.createElement("a");
      a.href = match[0].startsWith("http") ? match[0] : `http://${match[0]}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[0];
      frag.appendChild(a);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < trimmed.length)
      frag.appendChild(document.createTextNode(trimmed.slice(lastIndex)));
    bubble.appendChild(frag);
  }

  _appendLink(bubble, url) {
    bubble.classList.add("bubble-link");
    const href = url.startsWith("http") ? url : `http://${url}`;
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const iconEl = document.createElement("i");
    iconEl.className = "fas fa-link";
    const textEl = document.createElement("span");
    textEl.textContent = url;
    const extEl = document.createElement("i");
    extEl.className = "fas fa-external-link-alt link-ext";

    a.appendChild(iconEl);
    a.appendChild(textEl);
    a.appendChild(extEl);
    bubble.appendChild(a);
  }

  _scrollBottom() {
    requestAnimationFrame(() => {
      this._msgsEl.scrollTop = this._msgsEl.scrollHeight;
    });
  }
}

// ── Action Dialog ─────────────────────────────────────────────────────────────

class ActionDialog extends Dialog {
  constructor() {
    super("action-dialog");

    $("send-file-button").addEventListener("click", () => {
      const inp = $("file-input");
      inp.value = "";
      inp.onchange = (e) => {
        Events.fire("files-selected", {
          files: e.target.files,
          to: window.drplUI.currentPeer,
        });
        this.hide();
      };
      inp.click();
    });

    $("send-text-action").addEventListener("click", () => {
      this.hide();
      const id = window.drplUI.currentPeer;
      const el = $(id);
      const name = el ? el.querySelector(".peer-name").textContent : "Unknown";
      window.drplUI.dialogs.chat.openWith(id, name);
    });
  }

  show(peer) {
    // Populate action dialog header with avatar + name
    $("action-title").textContent = peer.name.displayName;
    $("action-device-label").textContent = peer.name.deviceName;
    super.show();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  window.drplUI = new DrplUI();
  window.NotificationManager.init();
  new BackgroundAnimation();
});
