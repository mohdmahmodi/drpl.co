/**
 * drpl.co - Notifications Javascript
 * Handles system notifications for incoming files, messages, and peer events
 */

window.NotificationManager = (function () {
  const isURL = (text) =>
    /^((https?:\/\/|www)[^\s]+)/g.test(text.toLowerCase());

  class NotificationHandler {
    constructor() {
      this.hasPermission = false;
      if (!("Notification" in window)) {
        console.log("This browser does not support desktop notifications");
        return;
      }
      this.checkPermission();
      this._setupEventListeners();
    }

    _setupEventListeners() {
      Events.on("text-received", (e) => this.textNotification(e.detail));
      Events.on("file-received", (e) => this.fileNotification(e.detail));
      Events.on("peer-joined", (e) => this.peerJoinedNotification(e.detail));
      Events.on("peer-left", (e) => this.peerLeftNotification(e.detail));
    }

    checkPermission() {
      if (Notification.permission === "granted") {
        this.hasPermission = true;
      } else if (Notification.permission !== "denied") {
        this.requestPermission();
      }
    }

    requestPermission() {
      return Notification.requestPermission()
        .then((permission) => {
          if (permission === "granted") {
            this.hasPermission = true;
            this.notify("drpl.co", "Notifications enabled");
          }
        })
        .catch((err) =>
          console.error("Error requesting notification permission:", err),
        );
    }

    /**
     * Display a system notification.
     * FIX: Removed redundant visibility check — callers are responsible for that guard.
     */
    notify(title, body, data = {}) {
      if (!this.hasPermission) return null;
      try {
        const notification = new Notification(title, {
          body,
          icon: "favicon.png",
          data,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
          if (data.action && typeof data.action === "function") data.action();
        };
        setTimeout(() => notification.close(), 5000);
        return notification;
      } catch (err) {
        console.error("Error creating notification:", err);
        return null;
      }
    }

    /**
     * FIX: Single visibility guard per notification method.
     * Removed the duplicate check that was also inside notify().
     */
    textNotification(data) {
      if (document.visibilityState === "visible") return;
      const text = data.text;
      if (isURL(text)) {
        this.notify("New Link Received", text, {
          action: () =>
            window.open(
              text.startsWith("http") ? text : `http://${text}`,
              "_blank",
              "noopener,noreferrer",
            ),
        });
      } else {
        const truncated =
          text.substring(0, 50) + (text.length > 50 ? "..." : "");
        this.notify("New Message", truncated, {
          action: () => {
            if (window.drplUI && window.drplUI.dialogs.receiveText) {
              window.drplUI.dialogs.receiveText.showText(text, data.sender);
            }
          },
        });
      }
    }

    fileNotification(file) {
      if (document.visibilityState === "visible") return;
      this.notify("File Received", file.name, {
        action: () => {
          if (window.drplUI && window.drplUI.dialogs.receive) {
            window.drplUI.dialogs.receive.show();
          }
        },
      });
    }

    peerJoinedNotification(peer) {
      if (document.visibilityState === "visible") return;
      this.notify(
        "New Device Available",
        `${peer.name.displayName} (${peer.name.deviceName}) joined the network`,
        { action: () => window.focus() },
      );
    }

    peerLeftNotification(_peerId) {
      // Intentionally no notification on peer departure
    }
  }

  return {
    init: () => new NotificationHandler(),
  };
})();

document.addEventListener("DOMContentLoaded", () => {
  console.log("Notifications module loaded");
});
