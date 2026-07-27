/**
 * drpl.co - signaling server
 *
 * The server has exactly one job: let devices that share a public IP find
 * each other and exchange small signaling messages (WebRTC offers/answers/ICE,
 * or relayed fallback traffic). File data itself never passes through here
 * when WebRTC is available - transfers run peer-to-peer over the local network.
 *
 * Discovery model: peers are grouped into rooms keyed by the IP address the
 * server sees. Two devices on the same Wi-Fi share a public IP, so they land
 * in the same room. Devices on different networks never see each other.
 */

const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const path = require("path");
const parser = require("ua-parser-js");
const {
  uniqueNamesGenerator,
  colors,
  animals,
} = require("unique-names-generator");

// How often the server sweeps connections, and how stale a connection may be
// before it is terminated. Sweep interval must stay well under proxy idle
// timeouts (Cloudflare ~100s, default nginx 60s) so proxied sockets stay warm.
const SWEEP_INTERVAL = 25 * 1000;
const STALE_TIMEOUT = 70 * 1000;

// Signaling messages are small; relayed fallback chunks are ~90KB base64.
// Anything bigger than this is not legitimate traffic.
const MAX_PAYLOAD = 4 * 1024 * 1024;

const hashCode = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
};

// ── Peer ─────────────────────────────────────────────────────────────────────

class Peer {
  constructor(socket, request) {
    this.socket = socket;
    this.lastSeen = Date.now();
    this._setIP(request);
    this._setPeerId(request);
    this.rtcSupported = request.url.indexOf("webrtc") > -1;
    this._setName(request);
  }

  _setIP(request) {
    if (request.headers["x-forwarded-for"]) {
      this.ip = request.headers["x-forwarded-for"].split(/\s*,\s*/)[0];
    } else {
      this.ip = request.socket.remoteAddress;
    }
    // Normalize loopback so local testing puts every tab in one room
    if (this.ip === "::1" || this.ip === "::ffff:127.0.0.1") {
      this.ip = "127.0.0.1";
    }
  }

  _setPeerId(request) {
    // Per-tab id from the client (sessionStorage) wins; the cookie is a
    // legacy fallback shared across tabs.
    const match = /[?&]pid=([0-9a-zA-Z-]{10,64})/.exec(request.url || "");
    if (match) {
      this.id = match[1];
    } else if (request.peerId) {
      this.id = request.peerId;
    } else if (
      request.headers.cookie &&
      request.headers.cookie.includes("peerid=")
    ) {
      this.id = request.headers.cookie.split("peerid=")[1].split(";")[0];
    } else {
      this.id = Peer.uuid();
    }
  }

  _setName(req) {
    const ua = parser(req.headers["user-agent"]);

    let deviceName = "";
    if (ua.os && ua.os.name) {
      deviceName = ua.os.name.replace("Mac OS", "Mac") + " ";
    }
    // Generic desktop models ("Macintosh") say less than the browser does
    if (ua.device.model && ua.device.model !== "Macintosh") {
      deviceName += ua.device.model;
    } else if (ua.browser.name) {
      deviceName += ua.browser.name;
    }
    deviceName = deviceName.trim();
    if (!deviceName) deviceName = "Unknown Device";

    const displayName = uniqueNamesGenerator({
      length: 2,
      separator: " ",
      dictionaries: [colors, animals],
      style: "capital",
      seed: hashCode(this.id),
    });

    this.name = {
      model: ua.device.model,
      os: ua.os.name,
      browser: ua.browser.name,
      type: ua.device.type,
      deviceName,
      displayName,
    };
  }

  getInfo() {
    return {
      id: this.id,
      name: this.name,
      rtcSupported: this.rtcSupported,
    };
  }

  static uuid() {
    let uuid = "";
    for (let i = 0; i < 32; i++) {
      switch (i) {
        case 8:
        case 20:
          uuid += "-";
          uuid += ((Math.random() * 16) | 0).toString(16);
          break;
        case 12:
          uuid += "-";
          uuid += "4";
          break;
        case 16:
          uuid += "-";
          uuid += ((Math.random() * 4) | 8).toString(16);
          break;
        default:
          uuid += ((Math.random() * 16) | 0).toString(16);
      }
    }
    return uuid;
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

class DrplServer {
  constructor(server) {
    this._wss = new WebSocket.Server({ server, maxPayload: MAX_PAYLOAD });
    this._wss.on("connection", (socket, request) =>
      this._onConnection(new Peer(socket, request)),
    );
    this._wss.on("headers", (headers, response) =>
      this._onHeaders(headers, response),
    );

    this._rooms = {};

    this._sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL);

    console.log("drpl.co signaling server running");
  }

  _onConnection(peer) {
    this._joinRoom(peer);

    peer.socket.on("message", (message) => this._onMessage(peer, message));
    peer.socket.on("error", console.error);
    peer.socket.on("close", () => this._leaveRoom(peer));
    // Browsers answer protocol-level pings automatically, even when the
    // tab is backgrounded and its JS timers are frozen. This keeps mobile
    // devices registered while the screen is off.
    peer.socket.on("pong", () => {
      peer.lastSeen = Date.now();
    });

    this._send(peer, {
      type: "display-name",
      message: {
        displayName: peer.name.displayName,
        deviceName: peer.name.deviceName,
        peerId: peer.id,
      },
    });
  }

  _onHeaders(headers, response) {
    if (
      response.headers.cookie &&
      response.headers.cookie.indexOf("peerid=") > -1
    ) {
      return;
    }
    response.peerId = Peer.uuid();
    headers.push(
      "Set-Cookie: peerid=" + response.peerId + "; SameSite=Strict; Secure",
    );
  }

  _onMessage(sender, message) {
    sender.lastSeen = Date.now();

    try {
      message = JSON.parse(message);
    } catch (e) {
      return; // binary or malformed frames are not part of the protocol
    }

    switch (message.type) {
      case "disconnect":
        this._leaveRoom(sender);
        return;
      case "pong":
        return;
      case "ping":
        // Client-initiated liveness probe (used after a tab wakes up)
        this._send(sender, { type: "pong" });
        return;
    }

    // Relay signaling/fallback traffic to a peer in the same room only
    if (message.to && this._rooms[sender.ip]) {
      const recipient = this._rooms[sender.ip][message.to];
      if (!recipient) return;
      delete message.to;
      message.sender = sender.id;
      this._send(recipient, message);
    }
  }

  _joinRoom(peer) {
    if (!this._rooms[peer.ip]) {
      this._rooms[peer.ip] = {};
    }
    const room = this._rooms[peer.ip];

    // Same peer id reconnecting (page refresh, network blip, tab wake):
    // replace the stale entry and tell everyone to rebuild cleanly.
    const existing = room[peer.id];
    if (existing) {
      existing.replacedBy = peer;
      try {
        existing.socket.terminate();
      } catch (e) {
        /* already dead */
      }
      delete room[peer.id];
      this._broadcast(room, { type: "peer-left", peerId: peer.id });
    }

    this._broadcast(room, { type: "peer-joined", peer: peer.getInfo() });

    const otherPeers = Object.values(room).map((p) => p.getInfo());
    this._send(peer, { type: "peers", peers: otherPeers });

    room[peer.id] = peer;
  }

  _leaveRoom(peer) {
    const room = this._rooms[peer.ip];
    // Identity check: if this id was replaced by a fresh connection, the
    // old socket's close event must not evict the new peer.
    if (!room || room[peer.id] !== peer) return;

    delete room[peer.id];

    if (!Object.keys(room).length) {
      delete this._rooms[peer.ip];
    } else {
      this._broadcast(room, { type: "peer-left", peerId: peer.id });
    }
  }

  _broadcast(room, message) {
    for (const id in room) {
      this._send(room[id], message);
    }
  }

  _send(peer, message) {
    if (!peer || !peer.socket) return;
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    try {
      peer.socket.send(JSON.stringify(message));
    } catch (e) {
      console.error("Send error:", e);
    }
  }

  _sweep() {
    const now = Date.now();
    for (const ip in this._rooms) {
      for (const id in this._rooms[ip]) {
        const peer = this._rooms[ip][id];
        if (now - peer.lastSeen > STALE_TIMEOUT) {
          try {
            peer.socket.terminate();
          } catch (e) {
            /* noop */
          }
          this._leaveRoom(peer);
        } else {
          try {
            peer.socket.ping();
          } catch (e) {
            /* noop */
          }
          this._send(peer, { type: "ping" });
        }
      }
    }
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const app = express();

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ status: "ok" }));

const server = http.createServer(app);
const PORT = process.env.PORT || 3003;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  new DrplServer(server);
});
