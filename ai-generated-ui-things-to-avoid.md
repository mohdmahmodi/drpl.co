# UI Rules — Avoiding AI-Slop Patterns

**Purpose:** constraints for an AI agent generating or reviewing UI. Every rule is checkable and paired with a do-instead. When generating, obey the hard constraints. When reviewing, flag any violation by name.

**Root cause:** slop is the statistical average of the training data — the model predicts "modern UI" in aggregate with no point of view about *this* product. These rules force specific choices against that average.

**House style used in examples below** (swap the palette/fonts, keep the structure and numbers):

```css
:root {
  /* one bg, one surface, one text, one muted, ONE accent, nothing else */
  --bg:        #0a0a0a;   /* light mode: #ffffff */
  --surface:   #151515;   /* light mode: #f4f4f4 */
  --border:    #262626;   /* 1px hairlines, not shadows, for separation */
  --text:      #ededed;   /* ~13:1 on --bg */
  --muted:     #9a9a9a;   /* FLOOR for body text: keep >= 4.5:1, never #666/#777 */
  --accent:    #4f7cff;   /* pick ONE. used for interactive/active state only */

  --radius:    4px;       /* single token. buttons/inputs/cards all use it */
  --space:     8px;       /* spacing scale = multiples of this: 8/16/24/32 */

  --font-sans: "IBM Plex Sans", "Archivo", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
}
```

---

## 1. Color

**Hard constraints**
- Max **one** accent color. Everything else is `--bg`, `--surface`, `--border`, `--text`, `--muted`.
- Accent is reserved for interactive/active/selected state. Never decorative.
- Body text contrast **>= 4.5:1**, large/heading text **>= 3:1** (WCAG AA). Verify against the actual background.
- No gradients. No glassmorphism (`backdrop-filter: blur`). No colored/glowing `box-shadow`.

**Detection heuristics — if you're about to write any of these, stop:**
- `linear-gradient(... #a855f7 ... #6366f1 ...)` → "VibeCode Purple" gradient. Banned.
- `background: radial-gradient(... blur ...)` blob behind a hero → decorative glow. Banned.
- a 3rd, 4th, 5th hue on one screen → collapse to accent + neutrals.
- `color: #666` / `#777` on a dark bg → fails contrast. Use `--muted` (>= #949494 on near-black) or lighter.

```css
/* SLOP */                              /* CLEAN */
background: linear-gradient(135deg,     background: var(--bg);
  #667eea, #764ba2);
box-shadow: 0 0 40px #6366f1aa;         border: 1px solid var(--border);
color: #6b7280; /* on #111 → ~3:1 */    color: var(--muted); /* >= 4.5:1 */
```

---

## 2. Typography

**Hard constraints**
- Do **not** default to Inter, Space Grotesk, Instrument Serif, or Geist. Use `--font-sans`.
- Two families max: one sans (UI/body), optionally one mono (code/data). No serif-italic accent word.
- Type scale is fixed: e.g. 12 / 14 / 16 / 20 / 28 / 40px. No arbitrary sizes.
- Section labels are sentence case, not ALL-CAPS eyebrows on every block.

**Detection heuristics**
- `font-family: Inter` with no rationale → replace with `--font-sans`.
- one `<h1>` word wrapped in `<em>` / italic serif → remove the accent-word treatment.
- `text-transform: uppercase; letter-spacing` on every section label → keep for at most one true eyebrow, not all.

---

## 3. Layout & components

**Hard constraints**
- **Radius:** every element uses `--radius` (4px). Never 16–24px on everything. Full-round (`9999px`) only for actual pills/avatars, not cards or buttons.
- **No colored left/top border stripe on cards.** (This is the single most reliable AI tell.) Separate content with `--border` hairlines or whitespace.
- **Card nesting depth <= 1.** Don't wrap a card in a card in a card. Group with whitespace, proximity, and type — not boxes.
- **One layout primitive, repeated.** Not icon-card grid + stat banner + numbered steps + sidebar all on one page. Pick one and reuse it.
- If using shadcn/ui: change the default tokens (radius, colors, shadows). Don't ship stock.

**Detection heuristics — these are the specific fingerprints:**
- `border-left: 3px solid <accent>` on a card → remove.
- three identical `<Card>` blocks each with an icon on top → the icon-card grid. Only use if it's the one repeated primitive.
- a `<Badge>`/pill rendered directly above the hero `<h1>` → remove or justify.
- `border-radius: 20px` (or higher) applied broadly → collapse to `--radius`.

```jsx
/* SLOP: colored stripe + big radius + nested cards */
<div style={{borderLeft:'4px solid #8b5cf6', borderRadius:'20px', padding:24}}>
  <div style={{borderRadius:'16px', background:'#1a1a2e'}}>
    <div style={{borderRadius:'12px'}}>…</div>
  </div>
</div>

/* CLEAN: hairline, single radius, flat, no nesting */
<div style={{border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16}}>
  …
</div>
```

---

## 4. Fake liveness (decoration disguised as data)

**Rule: an indicator may only render if it is bound to a real state variable.** No exceptions. If there is no data source, there is no indicator.

**Banned unless wired to real state:**
- Pulsing status dots on nav items / headers / labels. A status dot requires (a) a real state value and (b) a text label or legend defining each state.
- `"System online"` / `"All systems operational"` badges — only if backed by an actual health check.
- Live activity feeds (`"Sarah from Ohio just signed up"`), ticking counters, `"1,204 online now"` — only from real events, never synthesized.
- Fake telemetry: charts fed `Math.random()`, decorative terminal/console readouts, `"AI is thinking…"` shimmer when nothing async is running.
- Invented trust metrics: `"99.9% uptime"`, `"10k+ users"`, `"24/7"` with no source. Omit until real.

```jsx
/* SLOP */                                    /* CLEAN */
<span className="dot pulse-green" />          {status && (
System online                                   <span className="dot" data-state={status} />
                                                <span>{STATE_LABELS[status]}</span> )}
{Array.from({length:20}, () => Math.random())}  {realSeries /* from API, or render empty state */}
```

---

## 5. States, copy & motion (the behavioral layer — invisible in a screenshot)

**Hard constraints**
- Every view defines all four states: **loading, empty, error, populated.** Don't ship only the happy path.
- Error copy names the actual failure and the next action. Ban generic placeholders: `"Something went wrong. Please try again."`
- Interactive elements need visible `:focus`/`:focus-visible` states and keyboard handling.
- **Icons come from one set**, consistent stroke width and size. **No emoji as UI chrome** (nav icons, section headers, bullet replacements).
- Motion only on real state change or user action. No blanket scroll-triggered fade-up on every element. Respect `prefers-reduced-motion`.
- No left-in placeholders: Lorem ipsum, `"Company Name"`, fake avatar testimonials, three-word triads (`"Fast. Simple. Powerful."`).

**Detection heuristics**
- component renders data but has no `isLoading` / `isEmpty` / `isError` branch → incomplete.
- `"Something went wrong"` string → replace with specific message.
- emoji inside `<nav>`, `<h2>`, or as a list bullet → replace with an icon from the chosen set.
- `whileInView`/`animate` fade-up on every section → remove; reserve motion for interaction.

---

## 6. Consistency (the meta-rule that catches everything above)

Define tokens **once** — radius, spacing, color, type scale, one icon set — and reuse them everywhere. Most slop is "locally fine, globally chaos": a button floats slightly, radius drifts screen to screen, a 4th accent creeps in. If a value isn't a token, it's a bug.

**Review pass:** grep the output for `border-left`, `linear-gradient`, `backdrop-filter`, `border-radius:\s*(1[6-9]|[2-9]\d)px`, `Inter`, `Math.random`, `"Something went wrong"`, and raw emoji in JSX. Each hit is a named violation above.

---

## Priority order (if you can only fix a few things)

1. Kill fake-liveness indicators — they're the most dishonest and the easiest to spot.
2. Collapse to one accent + neutrals; fix contrast to AA.
3. Remove colored border-stripes and oversized radius; unify to one radius token.
4. Add the missing loading/empty/error states and real error copy.
5. Replace Inter default + emoji-as-icons with the house font and one icon set.
