# drpl.co research notes

Compiled July 21, 2026. Sources were verified against primary material
(GitHub source, npm registry, MDN, caniuse, browser release notes, live
probes of snapdrop.net and pairdrop.net) at the time of writing.

## 1. Snapdrop and PairDrop

### What happened to snapdrop.net

- Snapdrop was created by Robin Linus in December 2015: vanilla JS client,
  Node.js WebSocket signaling server, WebRTC transfers, GPL-3.0.
- Maintenance stalled from 2021 on. In February 2025 the repo moved to a
  "SnapDrop" org and the README announced the acquisition by **LimeWire**.
- snapdrop.net today still serves the old shell, but its P2P is dead: the
  signaling endpoint no longer accepts connections, and an injected
  `lw_upload.js` uploads selected files to `api.limewire.com` and redirects
  to limewire.com. Transfers are cloud uploads now, not local P2P.
- The community migrated to PairDrop; the Snapdrop Android app dropped
  snapdrop.net for pairdrop.net within a day of the switch.

### PairDrop

- github.com/schlagmichdoch/PairDrop, GPL-3.0, latest release v1.11.2
  (February 2025); in maintenance mode as of mid-2026 but alive.
- Additions over Snapdrop: transfer request/accept before bytes move,
  persistent device pairing (6-digit code / QR) that works across networks
  through their TURN server, temporary public rooms, PWA share target on
  Android, thumbnails and previews, zip download of batches, NoSleep wake
  lock, editable display names, 40+ languages.

### How they work (shared architecture)

- WebSocket signaling server groups peers into rooms keyed by the public IP
  the server sees (`x-forwarded-for` aware). Same Wi-Fi means same public
  IP means same room.
- Peer identity: Snapdrop uses a cookie; PairDrop uses a UUID plus salted
  hash re-sent by the client so identity survives reloads.
- WebRTC: the newer peer makes the offer; the server blindly relays
  offer/answer/ICE. STUN only (`stun.l.google.com:19302`) in Snapdrop;
  PairDrop adds its own TURN for cross-network pairs.
- Transfer protocol: 64,000-byte chunks read with FileReader, sent in 1 MB
  "partitions"; after each partition the sender **stops and waits** for a
  `partition-received` message. Neither project uses
  `bufferedAmount`/`bufferedamountlow` backpressure at all (grep-verified).
  This stop-and-wait window is the root of their top-voted "transfers are
  incredibly slow" issues.
- Receive side buffers every chunk in RAM and assembles one Blob at the
  end. No streaming to disk. iOS crashes above a few hundred MB led
  PairDrop to auto-decline batches over 200 MiB on iOS.
- Keepalive: Snapdrop pings every 30s and drops after two misses; PairDrop
  pings every second and drops after ~5s.
- Encryption: WebRTC data channels are DTLS-encrypted by the browser,
  mandatorily. The server sees metadata only (IPs, names, SDP), never file
  contents. The honest caveat both projects admit: you trust the signaling
  server not to man-in-the-middle the SDP exchange.

### What drpl.co does differently after this rewrite

- Streaming backpressure sender: chunks are pushed while
  `bufferedAmount < 4 MB` and resume on `bufferedamountlow` (512 KB
  threshold). No stop-and-wait round trips.
- Negotiated chunk size: 64 KiB baseline, raised to 256 KiB when
  `RTCSctpTransport.maxMessageSize` allows (Chromium to Chromium).
- Session-level protocol (`transfer-start` / `file-start` / chunks /
  `file-end` / `transfer-received`) with cancel in both directions and
  per-file acknowledgements, so both sides always reach a terminal state
  (sent, received, failed) instead of spinning.
- Zombie-connection defense in depth: server protocol-level pings (browsers
  answer them even when a tab is frozen), server sweep with socket
  termination, client watchdog that detects half-open sockets, reconnect
  with jittered backoff on `visibilitychange` / `online` / `pageshow`, peer
  heartbeats, stale-negotiation restart, and a 5s maintenance sweep.
- A working relay fallback (base64 chunks through the signaling server)
  when WebRTC is blocked; the old WSPeer fallback in this codebase was
  silently broken (it attached `.to` onto a JSON string).

## 2. Web platform, July 2026

Browser versions at the time of writing: Chrome 150, Firefox 152, Safari
26.5 (Apple moved to year-based versions in 2025).

### Transfer tech

- **WebRTC data channels remain the only browser P2P transport.** The W3C
  P2P WebTransport spec is dormant; no implementations. Client-server
  WebTransport is Baseline (Safari shipped 26.4) but does not help P2P.
- 16 KiB chunks are the universally safe floor; Chromium and WebKit accept
  256 KiB messages and expose the limit via `sctp.maxMessageSize`. Keep
  sends well under the ~16 MB internal send queue or the channel dies.
- Realistic LAN throughput is CPU-bound: roughly 18-45 MB/s in published
  measurements; phones over Wi-Fi commonly land 1.5-10 MB/s.
- `RTCDataChannel` is transferable to a Worker in Chrome 130+ and Safari
  17+; Firefox not yet. Worth adopting later together with OPFS.

### The WICG Local Peer-to-Peer API

Intel's proposal (LAN discovery + direct connection without any server) is
still an incubation as of July 2026: no origin trial, no browser ships it.
Do not plan around it yet; it is the thing to watch for a truly
serverless-and-offline drpl.

### Can drpl.co run without the Node server (e.g. GitHub Pages)?

Honest answer: **a purely static page cannot discover peers on the same
Wi-Fi by itself.** Every option still needs some rendezvous point:

- **Keep a tiny signaling server** (what drpl does). The frontend is now
  fully static-hostable; `window.DRPL_CONFIG.signalingServer` points it at
  any wss endpoint, so the static files can live on GitHub Pages while a
  small server (Node, or a port to Cloudflare Workers Durable Objects,
  whose free tier - 100k requests/day with WebSocket hibernation - fits
  this load) does discovery.
- **Tracker-style signaling with no owned server**: the `trystero` library
  (actively maintained, v0.25.x July 2026) does signaling over public
  Nostr relays / MQTT brokers / BitTorrent trackers, and the "LAN room"
  can be derived client-side by hashing the public IP learned from a STUN
  lookup (the old ShareDrop trick). It works, with real costs: joins take
  seconds, public relays flake, CGNAT puts strangers in your room (needs a
  confirm step), dual-stack IPv4/IPv6 splits rooms, and corporate networks
  block the relays. Fine as an experimental mode, not as the only path.
- Browsers hide LAN IPs behind mDNS candidates; same-SSID resolution works,
  but AP/client isolation or multicast-blocking routers break it. Always
  configure STUN so a reflexive candidate exists as fallback.

### Chrome's Local Network Access permission

Since Chrome 141/142 (fall 2025), pages connecting to private addresses
trigger a user permission prompt, with WebSocket enforcement following
(~M147) and WebRTC on the way. Self-hosted drpl instances reached by LAN IP
should expect the prompt; surface a friendly hint when connections fail.

### Platform limits that shape the design

- **iOS Safari**: the page is suspended seconds after screen lock or
  backgrounding; sockets die. Mitigations shipped: Screen Wake Lock during
  transfers (iOS 16.4+), reconnect on `pageshow`/`visibilitychange`, and a
  protocol where both sides fail loudly instead of hanging. Per-tab memory
  is the hard ceiling for RAM-buffered receives (as low as ~100-200 MB on
  low-RAM devices); the receive path minimizes duplication by folding
  chunks into a Blob every 32 MB.
- **bfcache everywhere**: Chrome 149+ silently closes WebSockets when a
  page enters the back/forward cache; reconnect-on-`pageshow` is mandatory
  now, not optional.
- **Proxy idle timeouts**: Cloudflare kills idle WebSockets at ~100s, nginx
  at 60s by default. The server pings every 25s (both protocol-level and
  JSON) and sweeps dead peers at 70s.
- **Saving files**: `showSaveFilePicker` (true streaming saves) is still
  Chromium-only; Safari and Firefox get Blob downloads, and iOS gets the
  share sheet (`navigator.share` with files), which drpl offers when
  available.

### Future work worth doing (not in this pass)

1. **OPFS receive buffering**: write incoming chunks to the Origin Private
   File System (supported everywhere incl. iOS 15.2+, `createWritable` in
   Safari 26) via a worker, removing the RAM ceiling for multi-GB files;
   pair with `showSaveFilePicker` streaming on Chromium.
2. Transfer resume (chunk-offset acks) to survive iOS suspensions.
3. Optional transfer request/accept consent step, like PairDrop.
4. A Cloudflare Workers + Durable Objects port of the signaling server for
   zero-maintenance hosting.

## 3. Libraries and assets (all verified against CDNs)

| Choice | Version | Cost | Why |
| --- | --- | --- | --- |
| GSAP (jsdelivr, pinned) | 3.15.0 | 27.7 KB gz | Free including all plugins since the Webflow acquisition (May 2025). Not vendored: its "no charge" license is not MIT, so it stays a CDN reference. Loaded `async`; every animation has a CSS or instant fallback. |
| Toastify-js (cdnjs) | 1.12.0 | ~5 KB | Smallest vanilla toast lib that themes cleanly. Its stock stylesheet ships a gradient, so it is not loaded; toast appearance lives in styles.css. Built-in fallback toast if the CDN is blocked. |
| Lucide icons | lucide-static 1.25.0 | ~10 KB inlined | ISC license. Inlined as an SVG symbol sprite in index.html: zero requests, no flash of missing icons, styleable via currentColor. Full UMD build would cost 96 KB. GitHub glyph comes from Simple Icons (Lucide removed brand icons in v1). |
| Figtree font | Fontsource variable, latin | 20 KB self-hosted | The face used by the reference aesthetic (it is Astryx neutral's face). Self-hosted because cache partitioning makes shared font CDNs pointless and Google Fonts embeds have GDPR problems. |
| JSZip (cdnjs, lazy) | 3.10.1 | loaded on demand | Only fetched when "Save all" zips multiple files; STORE mode (no compression) for speed. |

Removed: Font Awesome (was ~100 KB+ of CSS/fonts for a handful of glyphs),
eagerly-loaded JSZip.

### Astryx (Meta's design system)

`@astryxdesign/core` is Meta's open-source design system (announced with a
CLI and MCP server in June 2026; grew inside Meta for ~8 years). The
component runtime is React 19 + StyleX, unusable in a vanilla app - but its
theme packages ship plain generated CSS custom properties. drpl.co
transcribes ~25 token values from `@astryxdesign/theme-neutral` (gray ramp,
monochrome accent model, 10px radius, desaturated state color pairs) into
its own hand-rolled tokens. No Astryx code or runtime is imported. Details
in [design-system.md](design-system.md).
