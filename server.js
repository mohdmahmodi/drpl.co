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
 *
 * Because the room key IS the client's address, resolving that address is a
 * security boundary, not a formality - see TRUSTED_PROXY_HOPS below. The same
 * goes for the Origin check: WebSockets are not subject to the same-origin
 * policy, so without it any site a visitor opens could join their room.
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

// Only this path is upgraded to a WebSocket. Everything else stays HTTP.
const WS_PATH_PREFIX = "/server";

// ── Deployment configuration ─────────────────────────────────────────────────

// Number of reverse proxies in front of this server. Each one APPENDS the
// address it saw to X-Forwarded-For, so the client's real address is the
// TRUSTED_PROXY_HOPS-th entry counted from the RIGHT. Everything to the left
// of it was supplied by the client and is therefore attacker-controlled: a
// client that sends its own X-Forwarded-For has that value preserved as the
// leftmost entry. Reading the leftmost entry lets anyone pick which room they
// land in, which means seeing (and sending files to) other people's devices.
//   1 = one proxy, e.g. Cloudflare or a single nginx (the default)
//   0 = no proxy; X-Forwarded-For is ignored entirely
const TRUSTED_PROXY_HOPS = Math.max(
  0,
  Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10) || 0,
);

// WebSockets are exempt from the same-origin policy: without this check any
// website a visitor opens can connect here, land in that visitor's room and
// enumerate or message their devices. Same-origin requests are always allowed;
// set ALLOWED_ORIGINS (comma separated) when the frontend is hosted elsewhere
// and points here via window.DRPL_CONFIG.signalingServer.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Caps. A room is a single Wi-Fi network, so the peer count is naturally
// small; the limit exists so one address cannot exhaust the process.
const MAX_PEERS_PER_ROOM = Math.max(
  2,
  Number.parseInt(process.env.MAX_PEERS_PER_ROOM ?? "48", 10) || 48,
);

// Relayed traffic is the only thing here that costs real bandwidth (it is the
// fallback used when WebRTC is blocked), so a runaway or malicious client
// should not be able to pump through it unbounded.
//
// The default is deliberately high. A relayed transfer over loopback measures
// ~58 MB/s, which is the fastest this path can ever go, so 128 MB/s cannot be
// reached by a real transfer - tripping it means something is wrong. Treat
// this as a runaway guard, not as egress control: capping actual bandwidth
// spend belongs at the edge (Cloudflare rules), not here.
// Set RELAY_BYTES_PER_SEC=0 to disable.
const RELAY_BYTES_PER_SEC = Math.max(
  0,
  Number.parseInt(process.env.RELAY_BYTES_PER_SEC ?? "134217728", 10) || 0,
);
const RELAY_BURST_BYTES = RELAY_BYTES_PER_SEC * 4;

// A peer that cannot keep up with what is being relayed to it would otherwise
// let the sender grow the server's memory without bound.
const MAX_SOCKET_BACKLOG = 16 * 1024 * 1024;

const hashCode = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
};

// ── Address handling ─────────────────────────────────────────────────────────

/**
 * The address this connection really came from.
 *
 * With TRUSTED_PROXY_HOPS = n, the last n entries of X-Forwarded-For were
 * written by our own proxies; entry [len - n] is the address the outermost
 * trusted proxy observed. Counting from the right is what makes this
 * unspoofable - a client-supplied header only ever adds entries on the left.
 */
function clientAddress(request) {
  const socketAddress = request.socket.remoteAddress;
  if (!TRUSTED_PROXY_HOPS) return socketAddress;

  const header = request.headers["x-forwarded-for"];
  if (!header) return socketAddress;

  const chain = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!chain.length) return socketAddress;

  // Fewer entries than configured hops means the request did not traverse the
  // proxy chain we expect, so nothing in this header is trustworthy.
  const index = chain.length - TRUSTED_PROXY_HOPS;
  if (index < 0) return socketAddress;
  return chain[index] || socketAddress;
}

/**
 * Devices on one IPv6 network share a /64 prefix but each carries its own
 * full address, so rooming by the complete address would put two phones on
 * the same Wi-Fi in different rooms. Group by the /64 network instead - the
 * standard per-LAN allocation. Mobile devices each get their own /64 from
 * the carrier, so they stay isolated from each other as before.
 */
function ipv6Prefix64(ip) {
  // Expand the :: abbreviation far enough to read the first four hextets
  const [head, tail = ""] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  // Re-encode each hextet so "0db8" and "db8" produce the same key
  const prefix = full
    .slice(0, 4)
    .map((h) => (parseInt(h, 16) || 0).toString(16))
    .join(":");
  return `${prefix}::/64`;
}

/**
 * Rooms are keyed by address, so two spellings of the same address must not
 * split a network in two. Strips IPv6-mapped IPv4 (::ffff:192.168.1.5), any
 * zone index (fe80::1%eth0), collapses loopback so local testing puts every
 * tab in one room, and reduces IPv6 to its /64 network (see above).
 */
function normalizeIP(address) {
  if (!address) return "unknown";
  let ip = String(address).trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  const zone = ip.indexOf("%");
  if (zone > -1) ip = ip.slice(0, zone);
  if (/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.test(ip)) {
    ip = ip.replace(/^::ffff:/i, "");
  }
  if (ip === "::1" || ip === "127.0.0.1") return "127.0.0.1";
  if (ip.includes(":")) return ipv6Prefix64(ip);
  return ip;
}

/**
 * WebSockets ignore the same-origin policy, so the Origin header is the only
 * thing standing between a visitor's room and any site they happen to open.
 */
function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  // Non-browser clients (curl, native apps, health probes) send no Origin.
  if (!origin) return true;

  let host;
  try {
    host = new URL(origin).host;
  } catch (e) {
    return false;
  }
  if (host && host === request.headers.host) return true;
  return ALLOWED_ORIGINS.some((allowed) => {
    try {
      return new URL(allowed).host === host;
    } catch (e) {
      return allowed === host;
    }
  });
}

// ── Peer ─────────────────────────────────────────────────────────────────────

class Peer {
  constructor(socket, request) {
    this.socket = socket;
    this.lastSeen = Date.now();
    // Relay budget, refilled over time (see _spendRelayBudget)
    this.relayTokens = RELAY_BURST_BYTES;
    this.relayCheckedAt = Date.now();
    this._setIP(request);
    this._setPeerId(request);
    this.rtcSupported = request.url.indexOf("webrtc") > -1;
    this._setName(request);
  }

  /**
   * Token bucket over relayed bytes. Returns false once a peer has spent more
   * than RELAY_BYTES_PER_SEC sustained, at which point its connection is
   * dropped rather than silently losing frames mid-transfer.
   */
  _spendRelayBudget(bytes) {
    if (!RELAY_BYTES_PER_SEC) return true;
    const now = Date.now();
    this.relayTokens = Math.min(
      RELAY_BURST_BYTES,
      this.relayTokens + ((now - this.relayCheckedAt) / 1000) * RELAY_BYTES_PER_SEC,
    );
    this.relayCheckedAt = now;
    if (this.relayTokens < bytes) return false;
    this.relayTokens -= bytes;
    return true;
  }

  _setIP(request) {
    this.ip = normalizeIP(clientAddress(request));
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
    this._wss = new WebSocket.Server({
      server,
      maxPayload: MAX_PAYLOAD,
      // Everything outside /server stays a plain HTTP route
      verifyClient: ({ req }, done) => {
        if (!(req.url || "").startsWith(WS_PATH_PREFIX)) {
          return done(false, 404, "Not Found");
        }
        if (!isAllowedOrigin(req)) {
          return done(false, 403, "Forbidden");
        }
        done(true);
      },
    });
    this._wss.on("connection", (socket, request) =>
      this._onConnection(new Peer(socket, request)),
    );
    this._wss.on("headers", (headers, response) =>
      this._onHeaders(headers, response),
    );

    this._rooms = {};

    this._sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL);
  }

  _onConnection(peer) {
    const room = this._rooms[peer.ip];
    // A room is one Wi-Fi network, so this is only ever hit by abuse. Peers
    // already in the room reconnecting (same id) do not count against it.
    if (room && !room[peer.id] && Object.keys(room).length >= MAX_PEERS_PER_ROOM) {
      peer.socket.close(1013, "Room full");
      return;
    }

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

  // ws emits ("headers", responseHeaders, request) - the second argument is
  // the incoming request, which is where the generated id is parked for the
  // Peer constructor to pick up.
  _onHeaders(headers, request) {
    if (
      request.headers.cookie &&
      request.headers.cookie.indexOf("peerid=") > -1
    ) {
      return;
    }
    request.peerId = Peer.uuid();
    // Secure would make the cookie a no-op over plain http, which is how
    // self-hosted instances are usually reached on a LAN.
    const secure = request.headers["x-forwarded-proto"] === "https";
    headers.push(
      `Set-Cookie: peerid=${request.peerId}; SameSite=Strict${secure ? "; Secure" : ""}`,
    );
  }

  _onMessage(sender, rawMessage) {
    sender.lastSeen = Date.now();

    let message;
    try {
      message = JSON.parse(rawMessage);
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

      const size =
        typeof rawMessage === "string"
          ? Buffer.byteLength(rawMessage)
          : rawMessage.length || 0;
      if (!sender._spendRelayBudget(size)) {
        sender.socket.close(1008, "Relay rate limit exceeded");
        return;
      }

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
    // A receiver that cannot drain what is being relayed to it would grow the
    // server's memory without bound. Drop it instead; the client reconnects.
    if (peer.socket.bufferedAmount > MAX_SOCKET_BACKLOG) {
      peer.socket.close(1008, "Receiver too slow");
      return;
    }
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
app.disable("x-powered-by");

// Media and fonts never change under a given name, so they are cached for a
// year - that is where nearly all the bytes are. Scripts, styles and the
// document revalidate instead: the ?v= strings in index.html are maintained by
// hand, and a stale bundle after a deploy costs far more than the 304 saves.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (/\.(woff2?|png|jpe?g|svg|mp3|ico)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

const server = http.createServer(app);
const drpl = new DrplServer(server);

// Real numbers only: what this process is actually holding right now.
app.get("/health", (req, res) => {
  const rooms = Object.values(drpl._rooms);
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    rooms: rooms.length,
    peers: rooms.reduce((n, room) => n + Object.keys(room).length, 0),
  });
});

const PORT = process.env.PORT || 3003;

server.listen(PORT, () => {
  console.log(
    `drpl.co listening on ${PORT} | proxy hops: ${TRUSTED_PROXY_HOPS} | ` +
      `origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "same-origin only"}`,
  );
});
