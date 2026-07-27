/**
 * drpl.co - system notifications
 *
 * Desktop notifications for events that happen while the tab is hidden.
 */

window.NotificationManager = (function () {
  const isURL = (text) => /^((https?:\/\/|www)[^\s]+)$/i.test(text.trim());

  class NotificationHandler {
    constructor() {
      this.hasPermission = false;
      if (!("Notification" in window)) return;
      this.checkPermission();
      this._setupEventListeners();
    }

    _setupEventListeners() {
      Events.on("text-received", (e) => this.textNotification(e.detail));
      Events.on("file-received", (e) => this.fileNotification(e.detail));
      Events.on("peer-joined", (e) => this.peerJoinedNotification(e.detail));
    }

    checkPermission() {
      if (Notification.permission === "granted") {
        this.hasPermission = true;
        return;
      }
      if (Notification.permission === "denied") return;
      // Asking on page load throws a permission dialog at someone who has not
      // done anything yet - browsers penalise it and people reflexively block.
      // Wait until they interact with the page at least once.
      const ask = () => {
        document.removeEventListener("pointerdown", ask);
        document.removeEventListener("keydown", ask);
        this.requestPermission();
      };
      document.addEventListener("pointerdown", ask, { once: true });
      document.addEventListener("keydown", ask, { once: true });
    }

    requestPermission() {
      return Notification.requestPermission()
        .then((permission) => {
          if (permission === "granted") this.hasPermission = true;
        })
        .catch(() => {});
    }

    notify(title, body, data = {}) {
      if (!this.hasPermission) return null;
      try {
        const notification = new Notification(title, {
          body,
          icon: "images/favicon.png",
          data,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
          if (typeof data.action === "function") data.action();
        };
        setTimeout(() => notification.close(), 5000);
        return notification;
      } catch (err) {
        return null;
      }
    }

    textNotification(data) {
      if (document.visibilityState === "visible") return;
      const text = data.text;
      if (isURL(text)) {
        this.notify("Link received", text, {
          action: () =>
            window.open(
              text.startsWith("http") ? text : `https://${text}`,
              "_blank",
              "noopener,noreferrer",
            ),
        });
      } else {
        const truncated = text.length > 60 ? `${text.slice(0, 60)}...` : text;
        this.notify("Message received", truncated, {
          action: () => {
            if (window.drplUI) window.drplUI.openMessages(data.sender);
          },
        });
      }
    }

    fileNotification(file) {
      if (document.visibilityState === "visible") return;
      this.notify("File received", file.name, {
        action: () => {
          if (window.drplUI) window.drplUI.showFiles();
        },
      });
    }

    peerJoinedNotification(peer) {
      if (document.visibilityState === "visible") return;
      this.notify(
        "Device nearby",
        `${peer.name.displayName} (${peer.name.deviceName}) joined your network`,
        { action: () => window.focus() },
      );
    }
  }

  return {
    init: () => new NotificationHandler(),
  };
})();
