# drpl.co

<p align="center">
  <a href="https://github.com/mohdmahmodi/drpl.co/stargazers"><img src="https://img.shields.io/github/stars/mohdmahmodi/drpl.co" alt="Stars"></a>
  <a href="https://github.com/mohdmahmodi/drpl.co/network/members"><img src="https://img.shields.io/github/forks/mohdmahmodi/drpl.co" alt="Forks"></a>
  <a href="https://github.com/mohdmahmodi/drpl.co/issues"><img src="https://img.shields.io/github/issues/mohdmahmodi/drpl.co" alt="Issues"></a>
  <a href="https://github.com/mohdmahmodi/drpl.co/blob/main/LICENSE"><img src="https://img.shields.io/github/license/mohdmahmodi/drpl.co" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-all_browsers-333333" alt="Platform">
</p>

Share files between devices on the same Wi-Fi, in the browser. No apps, no
accounts, no cloud. Open drpl.co on two devices, click one, pick files. The
other device accepts, and the transfer moves directly between the two over
WebRTC, encrypted. The server introduces the devices and never receives a
byte of the files themselves.

Live site: **[https://drpl.co](https://drpl.co)**

## Screenshots

Devices appear in the sidebar. Transfers run in the main area with a live
throughput chart and the transfer internals (chunk size, transport, send
buffer), all read from the real connection:

<p align="center">
  <img src="public/images/image.png" alt="drpl.co after receiving files" width="820">
</p>

Dark mode is an equal citizen:

<p align="center">
  <img src="public/images/screenshot-desktop-dark.png" alt="drpl.co dark mode" width="820">
</p>

A transfer in flight:

<p align="center">
  <img src="public/images/screenshot-transfer.png" alt="A transfer in progress" width="820">
</p>

Everything received lands in the Files pane as a gallery, with image
thumbnails and one-click saving:

<p align="center">
  <img src="public/images/screenshot-files.png" alt="Files pane gallery" width="820">
</p>

Opening a file shows its preview. Text files (markdown, code, config, logs)
show their literal contents:

<p align="center">
  <img src="public/images/screenshot-preview.png" alt="Literal markdown preview" width="820">
</p>

Conversations combine text, links and the files you exchanged:

<p align="center">
  <img src="public/images/screenshot-messages.png" alt="Messages pane" width="820">
</p>

<p align="center">
  <img src="public/images/mobile.png" alt="drpl.co on a phone" width="280">
</p>

## Features

- **Automatic discovery**: devices on the same network see each other, no
  setup. Names are generated per tab, so two tabs are two devices.
- **Direct transfers**: WebRTC data channels with streaming backpressure
  and negotiated chunk sizes (64 to 256 KiB). Any file type, any count, no
  enforced size limit.
- **You accept before anything arrives**: incoming transfers show what is
  being sent and by whom, and nothing is read or transmitted until you say
  yes. Unanswered requests decline themselves after 60 seconds, so the
  sender always finds out rather than waiting forever. A device can be
  trusted for the rest of the session if you would rather not be asked
  again. The check is in the protocol, not just the interface: a transfer
  whose request was never accepted is refused.
- **Drag and drop**: drop files on a device to send them there, or
  anywhere in the window to send them to the open conversation.
- **Live transfer detail**: per-file progress, a real throughput chart,
  speed/average/peak, elapsed and remaining time, chunk size, transport,
  and send buffer state.
- **Files gallery**: every received file in one place, with image
  thumbnails, one-click saving, image, video, audio and literal text
  previews, share sheet (where the platform supports sharing files), and
  zip export for batches.
- **Messages built for moving things between your own devices**: click any
  message to copy it, click a received image to copy the image itself, and
  every file in the timeline can be previewed or saved from where it sits.
  Links get their own card with copy and open actions. Paste an image into
  the composer to send it straight across. Sent messages show a tick only
  once the other device confirms it arrived. Per-device conversations plus
  an Everyone group that reaches every device at once. Conversations
  persist in the browser (localStorage), never on a server.
- **Session panel**: totals for data sent and received, peak speed, and a
  history of this session's transfers.
- **Resilient connections**: the app survives sleep, tab switches, network
  blips and proxy idle timeouts, and reconnects itself. Transfers fail
  loudly with a reason instead of hanging.
- **Relay fallback**: when a firewall blocks WebRTC, transfers relay
  through the server (slower, but they work).
- **Light and dark themes**, a screen wake lock during transfers, desktop
  notifications while the tab is hidden, and a PWA with offline shell.

## How it works

1. A small Node.js server groups connected browsers by the public IP it
   sees. Devices behind the same router land in the same room and get each
   other's names. That is all the server knows: names, IPs and connection
   metadata. Never file contents.
2. Browsers negotiate a WebRTC data channel through the server (STUN via
   Google and Cloudflare, no TURN). On a shared Wi-Fi the channel connects
   directly between the devices, so bytes move at local network speed.
3. The sender asks first. Only after the receiving device accepts does the
   sender read a single byte off disk.
4. Files stream in chunks with backpressure
   (`bufferedamountlow`), and the receiver acknowledges each file. Both
   sides reach a terminal state: sent, received, or failed with a reason.
5. WebRTC data channels are DTLS-encrypted by the browser, always.

### Does the server see my files?

No, and this is measurable rather than a promise. Instrumenting both
transports for one 64 MiB transfer over a working WebRTC connection:

| Destination | Bytes |
| --- | --- |
| Signaling server | 0 |
| WebRTC data channel | 67,109,323 |

The extra 459 bytes over the file size are the JSON control messages
(request, accept, per-file start and end).

The one exception is the relay fallback, used when a firewall or VPN stops
the direct connection from forming. Then the file does pass through the
server, base64 encoded, at about 1.33x its size, and is forwarded straight
back out without ever being written to disk. drpl tells you when this
happens: the Transport row reads `Server relay` instead of `WebRTC P2P`,
and a notice appears when a connection falls back.

## Run it yourself

```bash
git clone https://github.com/mohdmahmodi/drpl.co.git
cd drpl.co
npm install
node server.js
```

Open `http://localhost:3003` (set `PORT` to change it). For other devices
on your network, use your machine's LAN address, e.g.
`http://192.168.1.20:3003`. Chrome may ask for local network permission on
plain-IP origins; HTTPS behind a reverse proxy is recommended for real use
(wss, wake lock, share sheet and notifications need a secure context).

Example nginx proxy:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://localhost:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 3600s;
    }
}
```

`X-Forwarded-For` matters: discovery groups devices by that address.

### Configuration

All optional, all environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3003` | Port to listen on |
| `TRUSTED_PROXY_HOPS` | `1` | How many reverse proxies sit in front of this server |
| `ALLOWED_ORIGINS` | same origin only | Extra origins allowed to open a WebSocket, comma separated |
| `MAX_PEERS_PER_ROOM` | `48` | Cap on devices sharing one address |
| `RELAY_BYTES_PER_SEC` | `134217728` | Runaway guard on relayed traffic, `0` disables it |

**`TRUSTED_PROXY_HOPS` is a security setting, not a tuning knob.** Rooms are
keyed by the client's address, so whoever controls that value controls which
room a client joins. Proxies append to `X-Forwarded-For`, and a client can
put anything it likes at the front of that header, so the real address is
counted from the right using this number. Set it to the number of proxies
you actually run:

- `1` for a single nginx or Cloudflare in front (the default)
- `2` for Cloudflare in front of your own nginx
- `0` if Node is exposed directly, which ignores the header entirely

Too high and honest clients scatter into wrong rooms. Too low and a client
can pick its own room by sending its own `X-Forwarded-For`, which would let
it see and send files to strangers' devices.

`ALLOWED_ORIGINS` is only needed when the frontend is hosted somewhere other
than this server, as in the static hosting section below. WebSockets are not
covered by the same-origin policy, so without this check any page a visitor
opens could connect and enumerate their devices. Same-origin requests are
always allowed, so the default suits the usual deployment.

### Static hosting

`public/` is a fully static frontend. You can host it anywhere (GitHub
Pages included) and point it at a signaling server by editing one line in
`index.html`:

```js
window.DRPL_CONFIG = { signalingServer: "wss://your-server.example" };
```

Discovery always needs that one small server. A purely static page cannot
find LAN peers by itself with today's browser APIs; the research notes in
[RESEARCH.md](RESEARCH.md) cover the alternatives and what they cost.

## Tech

- Vanilla HTML, CSS and JavaScript. No framework, no build step.
- Node.js signaling server (`express`, `ws`, `ua-parser-js`,
  `unique-names-generator`).
- No third party runtime dependencies and no outside requests at all.
  Animation, toasts and zip writing are part of the app; nothing is fetched
  from a CDN, so no third party learns who is using drpl.
- Lucide icons inlined as an SVG sprite; Figtree as a 20 KB self-hosted
  variable font.
- Design tokens are transcribed values from Meta's open-source
  [Astryx](https://github.com/facebook/astryx) neutral theme (MIT), with
  the design rules documented in [design-system.md](design-system.md) and
  [ai-generated-ui-things-to-avoid.md](ai-generated-ui-things-to-avoid.md).

## Project structure

```
server.js                       signaling server (discovery + relay)
Dockerfile                      two-stage build, no build step
public/
  index.html                    markup, icon sprite, config
  scripts/network.js            transports and transfer protocol
  scripts/ui.js                 dashboard (Transfers / Files / Messages)
  scripts/theme.js              theme switching
  scripts/background-animation.js
  scripts/notifications.js      desktop notifications
  scripts/sw.js                 service worker
  styles/styles.css             design tokens and all styling
  offline.html                  offline shell
  manifest.json, robots.txt, sitemap.xml
  favicon.ico, apple-touch-icon.png, og.png
  fonts/, images/
```

Version strings are maintained by hand and must be bumped together: the
`?v=` query strings and the two visible labels in `index.html`, and
`APP_VERSION` in `scripts/sw.js`.

## Browser support

Evergreen Chrome, Edge, Firefox and Safari, on Windows, macOS, Linux,
Android and iOS (15+). If WebRTC is blocked, the relay fallback keeps
transfers working.

## Contributing

Issues and pull requests are welcome. Before UI changes, read
[ai-generated-ui-things-to-avoid.md](ai-generated-ui-things-to-avoid.md)
and [design-system.md](design-system.md); before protocol changes, read
[RESEARCH.md](RESEARCH.md). Keep the frontend vanilla and dependency-free.

## License

MIT. See [LICENSE](LICENSE).

## Author

**Mohd Mahmodi**

- Website: [mohdmahmodi.com](https://mohdmahmodi.com)
- X: [@mohdmahmodi](https://x.com/mohdmahmodi)
- Email: mohdmahmodi@pm.me

## Acknowledgments

- [Snapdrop](https://github.com/SnapDrop/snapdrop) by Robin Linus, the
  original browser AirDrop, and [PairDrop](https://github.com/schlagmichdoch/PairDrop),
  its actively maintained successor. drpl.co shares their discovery model
  and rethinks the transfer protocol and interface.
- [Lucide](https://lucide.dev) (ISC) icons,
  [Figtree](https://github.com/erikdkennedy/figtree) (OFL), and
  [Astryx](https://github.com/facebook/astryx) (MIT) token values.
