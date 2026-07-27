# drpl.co design system

The binding rulebook is [ai-generated-ui-things-to-avoid.md](ai-generated-ui-things-to-avoid.md).
Read it first. Where this document and the rulebook disagree, the rulebook wins.
This document records the concrete choices made for drpl.co within those rules.

## Direction

drpl.co is a dashboard-shaped tool, not a landing page. The look is derived
from a small set of reference tools (kanban board, macOS-style file browser,
code editor, page editor) that share one language:

- Refined charcoal dark base, no color tint. A genuinely clean light mode as
  its equal, not an afterthought.
- Monochrome first. Color appears only when it carries meaning and stays
  desaturated. Never neon, never a gradient, never a glow.
- Subtly elevated surfaces with a moderate radius. Separation comes from
  elevation and whitespace more than lines. Hairline borders, used rarely.
- Type-led hierarchy: strong titles, one muted gray for secondary text,
  tabular numerics for data.
- Thin line icons, small and quiet, one set (Lucide).
- Primary actions are neutral and high-contrast (light fill on dark, dark
  fill on light), never colored.

## Tokens

Defined once in `public/styles/styles.css`. If a value is not a token, it is
a bug. Gray ramp and state colors are transcribed values from Meta's Astryx
`theme-neutral` (MIT) - values only, no Astryx code, no React.

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` | `#f1f1f1` | `#1b1b1b` |
| `--surface` | `#ffffff` | `#212121` |
| `--surface-2` | `#f4f4f4` | `#2a2a2a` |
| `--border` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.08)` |
| `--border-strong` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.16)` |
| `--text` | `#171717` | `#fafafa` |
| `--muted` | `#6b6b6b` | `#a3a3a3` |
| `--action` / `--on-action` | `#171717` / `#ffffff` | `#ebebeb` / `#171717` |

State colors (meaning only, desaturated; each is a text/background pair):

| State | Light text / bg | Dark text / bg | Used for |
| --- | --- | --- | --- |
| ok | `#0c5700` / `#c5e5c0` | `#9fe59b` / `rgba(132,201,128,.2)` | done badges, checks, online dot |
| info | `#00458c` / `#c4ddfb` | `#c7d3ff` / `rgba(158,183,255,.2)` | live transfer badge, chart line, unread dot |
| warn | `#584400` / `#f8da9d` | `#fdcf4f` / `rgba(222,180,51,.2)` | queued states |
| bad | `#89001a` / `#facecb` | `#ffc6c1` / `rgba(255,158,151,.2)` | failed badges, cancel |

Structure:

- Radius: `--radius: 10px`, the single token. `999px` only for true pills
  (badges, chips, the identity name chip).
- Spacing: multiples of 8 for layout (8/16/24/32); 2/4/6 allowed only for
  icon-to-label micro gaps.
- Type scale: 11/12/13/14/16/28. Body is 14. The transfer percentage is the
  only 28.
- Shadows: `--shadow-soft` for resting cards, `--shadow-panel` for overlays.
  Neutral black alpha only, never colored.

## Typography

- Sans: **Figtree** (SIL OFL), self-hosted variable font
  (`public/fonts/figtree-latin-var.woff2`, ~20 KB, latin). It is the face the
  reference tools use; neutral, SF-adjacent, and not part of the
  Inter/Space Grotesk/Geist slop rotation the rulebook bans.
- Mono: system `ui-monospace` stack, with `font-variant-numeric:
  tabular-nums`. Used for every number that updates (sizes, speeds,
  percentages, counters) and nothing else.
- One uppercase treatment in the app: the `DRPL.CO` wordmark. Everything
  else is sentence case.

## Layout

Dashboard grid:

- **Topbar**: wordmark left; theme, about, GitHub icon buttons right.
- **Sidebar (280px)**: "Devices" + count badge + refresh; scrollable device
  list; identity footer.
- **Main**: segmented tabs (Transfers / Files / Messages) over one pane.

A device row is icon left, then two stacked rows: name (14/600) over device
type (12, weight 350, muted). Rows are transparent; hover reveals `--hover`;
no cards around them. Quick actions (send, message) appear on hover. During
a transfer the row shows a live percentage bound to real progress.

The identity footer reads `You are known as:` with the name in a pill chip
(`--action` background, `--on-action` text). The status dot is bound to the
real signaling connection and the text names the state when offline.

## Components

- **Cards** (`.card`): surface, hairline border, soft shadow, radius token.
  Nesting depth 1: a card never contains another card.
- **Segmented tabs**: `--surface-2` container, active segment gets
  `--surface` + soft shadow. Count badges sit beside labels and render only
  when their number is real and non-zero.
- **State badges** (`.state-badge`): pill, tint background + same-hue text
  (kanban style). Variants: sending/receiving (info), done (ok), failed
  (bad), queued (warn), neutral.
- **Buttons**: primary = `--action`/`--on-action`; secondary = `--surface-2`
  fill; quiet icon buttons are transparent with `--hover` on hover. Actions
  are never colored.
- **Progress**: 3px monochrome bar (`--text` fill on `--surface-2` track).
  Failure turns the fill `--bad-text`. The throughput chart draws only real
  samples from transfer progress events; line and fill use the info color.
- **Stats grid**: hairline-separated cells, muted 11px labels over 13px mono
  values. Every value is read from the live transfer or the network layer
  (chunk size, transport, buffered bytes). If a value is unknown, show "-",
  never invent one.
- **Toasts**: built in, stacking, capped at four so a burst cannot bury the
  app. Surface background, hairline border, small icon (ok/bad tint when
  meaningful), muted text. Click one to dismiss it early.
- **Chat bubbles**: the whole bubble is a copy target, with explicit copy,
  preview, open and save buttons revealed on hover and always visible on
  touch. Text stays selectable, and a click that ends a selection does not
  copy over the top of it.
- **Consent dialog**: shown for every incoming transfer. States who is
  sending, what, and how large, with a live countdown badge that turns
  `--bad-text` in the last ten seconds. Declines itself when it expires.
- **Empty states**: dashed hairline border, small icon, 14/600 title, one
  muted line. All four view states (loading, empty, error, populated) exist
  for every pane.

## Motion

CSS keyframes, applied as a class for the length of one run and then
removed (`Motion` in `ui.js`). No animation library. Rules:

- Motion only on real state change or user action. Nothing animates on
  scroll; nothing loops except the spinner and the live chart.
- Durations 150-350ms on the shared `--ease`. No bounce on layout; a small
  overshoot only for state check-pops.
- Never animate a hidden tab (rAF and timers are throttled there); apply
  final state instantly instead. `prefers-reduced-motion` disables all of it.

## The canvas

The constellation background stays: monochrome dots and hairline
connections, dark gray at low alpha in light mode
(`rgba(23,23,23,.14)` dots), light gray in dark mode. It pauses when the tab
is hidden and renders a single static frame under reduced motion. No accent
particles.

## Review pass

Before shipping UI changes, run the rulebook's Section 6 greps over
`public/`:

```
grep -rnE "border-left|linear-gradient|backdrop-filter" public/styles public/scripts public/index.html
grep -rnE "border-radius:\s*(1[6-9]|[2-9][0-9])px" public/styles
grep -rn "Inter" public/styles public/index.html
grep -rn "Math.random" public/scripts/ui.js
grep -rn "Something went wrong" public
```

Every hit must be either fixed or justified here. Current justified uses:
`Math.random` appears in `network.js` (UUID generation, reconnect jitter)
and `background-animation.js` (particle positions) - logic and decoration
respectively, never data presented as real; the rulebook's ban targets fake
telemetry.
