# Magma: a third design, and the Gor brand

**Status: design spec, awaiting the owner's sign-off** (feature *Gor: Magma theme,
rebrand, grouped side-nav with live counters, messenger-style office chats*,
phase 1/4). Nothing here is built yet. No app code changes until this document
is signed off in the next card; phases 2–4 implement it. Every "will" below is
the proposal being signed off, and § 15 lists what the owner still has to
decide.

Magma is a third design beside **Classic** (`theme.css`) and **Glass**
(`glass.css`, `docs/glass.md`): red, yellow and black, with the colour coming
off a black field as glow. Like Glass it is a restyle, not a rebuild. The tree,
the routes and every behaviour stay as they are, and it is picked per device.
The same feature also brings in the **Gor** brand mark and wordmark, a
**grouped side-nav with live counters**, and **messenger-style chats**. The
nav and the chats are specified for all three designs. Only the colours and
materials are Magma's alone.

Owner's notes on this card (2026-11-07): "use frontend agent to design at
least 5 mockups before proceeding — add minimal pure design parts, like this
background sparkles in glass design. Magma's dominant color should be red or
orange, propose." The mockups are in § Mockups. The proposal is **orange**,
argued in § 1.

## Contents

0. [Mockups](#mockups)
1. [Intent and principles](#1-intent-and-principles)
2. [Scheme decision](#2-scheme-decision-magma-is-dark-only)
3. [Structural base](#3-structural-base)
4. [Token table](#4-token-table)
5. [Contrast proof](#5-contrast-proof)
6. [Focus ring](#6-focus-ring)
7. [Typography and spacing](#7-typography-and-spacing)
8. [Motion](#8-motion)
9. [xterm colours](#9-xterm-colours)
10. [The Gor mark](#10-the-gor-mark)
11. [Side-nav anatomy](#11-side-nav-anatomy)
12. [Counter definitions](#12-counter-definitions)
13. [Messenger chat anatomy](#13-messenger-chat-anatomy)
14. [Screen-by-screen checklist](#14-screen-by-screen-checklist)
15. [Open questions for the owner](#15-open-questions-for-the-owner)

## Mockups

Six directions plus the mark sheet. They were drawn by a frontend-design agent
from this spec's palettes, as static, self-contained HTML (no external assets).
They live in `docs/magma/` (re-render any of them with a headless Chromium
screenshot at the size given). The PNGs are in the task's artifacts
(`server/data/artifacts/3ab94277-…/`, shown in the task panel). The PNGs were
rendered with Playwright's `chrome-headless-shell` inside a heavy lease,
because headless Brave never wrote a screenshot on this Mac
(`CVDisplayLinkCreateWithCGDisplay failed`).

| File | Size | Direction | Verdict |
|---|---|---|---|
| `magma-a-ember.html` | 1440×900 | **A · Ember: orange dominant** (proposed). § 4's tokens, the wallpaper, the ember dot field, a lava hairline under the header, the active nav rail + inner glow, an ember primary button, the messenger pane | Reads best: orange = live, yellow = review, red = failed and violet = asks-you stay four distinct families. Weak point: the wallpaper's glows are faint at 1440, so A sits close to C at a glance |
| `magma-b-molten.html` | 1440×900 | **B · Molten: red dominant.** Crimson glows; accent, running and send all `#ff4a3d`; failed moved to magenta `#ff4fa3` | Fails honestly (annotated on the mockup). The "act now" colour is on everywhere, and failed in magenta looks like it belongs to another palette |
| `magma-c-basalt.html` | 1440×900 | **C · Basalt: minimal.** Flat `#080605`, one glow behind the brand, the hairline, accent only on active/running | Calm and very legible, but barely "magma": Classic recoloured |
| `magma-d-caldera.html` | 1440×900 | **D · Caldera: Glass structure at full strength.** Floating blurred header capsules and chat pane, radius-22 inset-grouped cards with an ember rim and specular edge, 5 glows + larger sparks | The most premium-looking. The board loses contrast and the header gets busy |
| `magma-e-ember-phone.html` | 390×844 @2× | **E · Ember on a phone.** Top bar, Board list, the floating tab bar with the ember Board disc | Works; the raised disc is the strongest element on the screen |
| `magma-e-tabbar-states.html` | 390×400 @2× | the tab bar with Board active (solid disc + glow) and with Inbox active (glass lens, outlined disc) | the lens is visible only when another tab is active, as in Glass |
| `magma-f-ember-phone-chat.html` | 390×844 @2× | **F · the messenger thread on a phone**, pushed from "‹ Chats", keyboard open, composer above it, jump pill | Works; this is § 13's phone layout |
| `gor-mark.html` | 1440×740 | the mark at 16/32/64/180/512 on black and on `#f2f2f7`, the monochrome template at 18/36, the sidebar lockup | see § 10 for the small-size note |

**Proposal: A's surfaces and decoration as the design, with D's floating
materials only where Glass already floats things** (header capsules, the phone
tab bar, sheets, the jump pill). That is exactly what § 3 (Glass structure)
plus § 4 (Magma tokens) produce: Glass's blur rules decide *where* there is
material, and Magma's flat near-black cards keep the board as legible as A's.

Where the mockups and this text differ, **the text wins** and the mockups
are illustrations:

- the mockups caption the middle nav group "Plan" and list Shared before
  Terminals. § 11 calls it **Agents** and puts Terminals first in Setup;
- mockup A draws the urgent Inbox counter as an ember pill with a glow. § 11
  keeps counters quiet: urgent is `--tm-status-attention` text with no pill,
  because violet is the "needs you" hue (§ 1) and a pill would be a fifth glow
  (§ 8);
- the working dots are drawn tinted. They are static in both.

## 1. Intent and principles

- **Glow on black.** The page is a warm near-black (`#0a0605`, black with a
  trace of red). Colour is what is *lit*: the accent, the live status, the
  active nav item, the primary action. A surface is never a saturated colour.
  The light comes from a few places, the way magma shows through cracks in
  dark rock.
- **Red, yellow, black, magma.** One dominant hue, one hot highlight, black.
  - **Orange `#ff7a2e` is the accent** (proposed dominant). It marks running,
    links, the switch, the active tab and the Board disc.
  - **Yellow `#ffc93d` is the highlight**: the focus ring, the brand spark,
    review/auto-review, and the hot end of the ember gradient.
  - **Red** is reserved for `failed`/danger (`#ff5468`) and for the cool
    end of the ember gradient (`#ff5a14`).
- **Why orange and not red is dominant.** The app's single most important
  colour signal is *failed* / destructive, and it is red in every design and
  in the user's habits (Telegram, push, the TM Bar). A red accent would sit on
  every running row and every primary button, so "this broke" would stop
  standing out. Direction B in the mockups (red dominant) shows the cost: it
  has to move *failed* to magenta, which reads as "attention", not "broken". A
  red accent also tires the eye at the density of a board with 50+ rows. Orange
  keeps the magma reading (orange *is* the colour of molten rock), and red keeps
  its meaning. Red is still there as the second stop of the ember gradient and
  in the wallpaper's lower glow, so the look is red-orange, not "an orange
  theme".
- **Cool hues only where the human is needed.** On a warm field, violet
  (`attention`, *asks you*) is the one hue that pops. It is kept for "needs
  you" and nothing else, as it is in Classic.
- **Dark-first, and dark-only** (§ 2).
- **Pure decoration is static.** The "minimal pure design parts" the owner
  asked for (§ 0, § 8) are CSS backgrounds and shadows. They never need JS or
  an image, and nothing about them runs forever: an ember wallpaper, a sparse
  field of ember dots, a lava hairline, and a soft ember glow on the few lit
  controls.
- **Restyle, not rebuild.** Magma changes the same component tree as Glass. It
  reuses Glass's structure (§ 3) and brings its own colours (§ 4).

## 2. Scheme decision: Magma is dark-only

**Decision (proposed): no light Magma ships.** "Glow on black" has no light
form. On white the ember glow turns into a pastel stain. Every status hue would
need its increased-contrast twin (orange text on white is 2.6:1 at `#ff7a2e`).
The result would be a second, different design with the same name, and it would
double the contrast proof and the verification matrix. If the owner wants a
light warm design later, it gets its own name (open question Q3).

What Light / System mean while Magma is the design:

| Control | Under Magma |
|---|---|
| Config → Appearance → **Light or dark** (`System \| Light \| Dark`) | Shown, disabled, with the hint "Magma is dark-only. This choice applies to Glass and Classic." The stored `tm.theme` is **left untouched**, so switching back to Glass restores the device's pick. |
| `html[data-theme]` | Forced to `dark` by `appearance.ts` `resolve()` and the `index.html` twin, so every `[data-theme='dark']` rule applies and `color-scheme: dark` holds. |
| Header sun/moon `ThemeToggle` (desktop header, phone More sheet) | Not rendered. A toggle that does nothing is worse than none. |
| System appearance `change` event | Still re-resolves (`refresh(true)`), but the result is unchanged, so nothing animates. |
| Terminals | Dark, as in every design. They take the Magma xterm theme (§ 9). |

## 3. Structural base

`magma.css` will load after `theme.css` (and after `glass.css`). `theme.css`'s
unscoped rules are **Classic's structure**. So unless this section decides
otherwise, Magma would get:

- Classic's opaque sheets;
- Classic's phone tab bar, with no lens (`TabBar` writes `--tab-i`/`--tab-n`/`--lens`
  in every design, `Layout.tsx:1076-1077`, but only `glass.css` l.596-617 draws
  the lens);
- no `motion.ts` effects (`glassMotion()` at `motion.ts:8` checks
  `dataset.design === 'glass'`);
- no view transition in `appearance.ts` `refresh()` (`:95` animates only when
  Glass is on either side);
- no `data-entering` row cascade (`glass.css` l.1241-1255) and no `tm-exit`
  ghosts (`glass.css` l.1267-1307).

Two facts bear on the decision. `docs/decisions.md` 2026-10-03 says Classic "is
going away" and that the sheet material is Glass-only "since it is going away
and a Classic-tuned glass would be work for a design with no future" (l.706-709).
And the brief's `docs/roadmap.md` does not exist yet, so the only written plan
for Classic's retirement is that decisions entry.

### The decision, per feature

| Feature | Magma uses | Mechanism |
|---|---|---|
| Sheet material (`--tm-sheet-*`, react-modal-sheet `.more-sheet`, `.sheet-*`, `FullSheet`) | **Glass** | Widen the selectors in `glass.css` l.920-1051. The tween reads `--tm-sheet-dur`/`--tm-sheet-ease` through `getComputedStyle` (`Sheet.tsx:20-29`), so widening the scheme-independent Glass token block in `theme.css` (l.290-322) gives Magma the 560 ms smooth tween. Magma supplies its own `--tm-glass-thick`/`-rim`/`-specular` values (§ 4). |
| Phone tab bar: lens, floating capsules, Board disc | **Glass** | Widen `glass.css` l.562-713 and the `.app.mobile` Glass token block in `theme.css` (l.523-533, `--tm-tabbar-float`/`-clear`, the tab label size). No JS change: `TabBar` already writes the lens variables in every design. |
| `motion.ts` effects (`exitGhost`, `tm-exit` clones) | **Glass** | JS gate `motion.ts:8`: `glassMotion()` becomes `layeredMotion()`, true for `glass` or `magma`. `Sheet.tsx:137`, `TaskSlideOver` and `QuestionModal` call it unchanged. The unscoped `.tm-exit` rules (`glass.css` l.1268-1276) already apply. Widen the scoped exits (l.1277-1307). |
| Appearance view transition | **Glass** | JS gate `appearance.ts:95`: animate when `look.design !== 'classic' \|\| next.design !== 'classic'`, so Glass↔Magma and Classic↔Magma cross-fade. A Classic-only flip stays instant. The `::view-transition` duration rule (`glass.css` l.1311) is unscoped already. |
| `data-entering` row cascade, page rise | **Glass** | Widen `glass.css` l.1232-1265. `Layout.tsx:1170-1177` already sets `.main[data-entering]` in every design. |
| Header and shell (floating transparent header, `.edge-top`, sidebar pane, wallpaper, capsules) | **Glass** | Widen `glass.css` l.20-212 and l.487-560, including the "shown only in Glass" half of `.edge-top, .glass-only` (the unscoped hide at l.20 stays). Magma's own `--tm-wallpaper` value replaces the Glass glows. **Magma only** (in `magma.css`): the ember dot field on `body::before`, and the lava hairline under the sidebar brand. |
| `GLASS_HIDDEN` on phone (Features and Chat left out of the More sheet) | **Not hidden** (proposed; owner question Q4) | JS gate `Layout.tsx:843-847` `useNav()`. It stays `design === 'glass' && mobile`, so Magma shows both. This feature makes Chat a centrepiece (§ 13), and hiding its nav entry on the phone would contradict that. If the owner wants Glass's behaviour, the gate becomes `design !== 'classic' && mobile`. |

**Recommendation: Magma uses Glass's structure everywhere, by widening
selectors.** Every structural rule in `glass.css` and every scheme-independent
or reduced-* Glass block in `theme.css` changes its scope from
`[data-design='glass']` to `:is([data-design='glass'], [data-design='magma'])`.
`:where([data-design='glass'])` becomes `:where([data-design='glass'], [data-design='magma'])`,
and `:root[data-design='glass']` becomes `:root:is(…)`.

Reasoning:

- **Glass computes exactly as before.** `:is()` takes the specificity of its
  most specific argument, and both arguments are one attribute selector
  (0,1,0), the same as today. `:where()` stays at 0. Every Glass rule therefore
  keeps its specificity and its source order, and Glass's computed styles do
  not change. That is the exit test of phase 2 (below).
- **Duplicating is the expensive option and the one that drifts.**
  `glass.css` has about 236 rule blocks (241 `[data-design='glass']` selectors).
  A copy in `magma.css` doubles the coverage task now. Every later Glass fix
  (and there are several a week) would then need a twin, and the first one
  forgotten is a Magma bug.
- **Classic is going away** (decisions.md 2026-10-03). Building a third design
  on its structure would tie the new design to the one being retired. Glass's
  structure is the one with a future.
- `glass.css` "has no colours of its own" (its header, glass.md § Rules). It
  draws only through tokens, so with Magma's tokens behind it, a widened rule
  renders in Magma's colours without edits.

**What does NOT widen:** the two Glass *colour* blocks in `theme.css`
(`[data-design='glass'][data-theme='dark']` l.332-424 and `…[data-theme='light']`
l.426-518) stay Glass-only. Magma has its own colour block,
`[data-design='magma']`, in `theme.css` after Glass's, mirrored in
`docs/tm-design-tokens.html`. It also gets its own rows in the
reduced-transparency and no-backdrop-filter blocks (l.538-557), which turn its
materials solid.

**What goes in `magma.css`:** only Magma's own rules, all scoped to
`[data-design='magma']`. These are the ember dot field, the lava hairline, the
ember glows (§ 8), the focus-ring colour (§ 6), `.tab-count.urgent`'s label
(today `--tm-gray-0`, which is 2.03:1 on Magma's violet), and the messenger
Magma deltas (§ 13). It uses only tokens.

**JS gates to change** (complete list; every other read of the design is
CSS):

| File:line | Today | Change |
|---|---|---|
| `appearance.ts:14` | `Design = 'classic' \| 'glass'` | add `'magma'` |
| `appearance.ts:55-62` `resolve()` | anything but `'classic'` → `glass` (a stored `'magma'` would silently become Glass) | three-way; `scheme = design === 'magma' ? 'dark' : pin ?? system ?? 'dark'`; `pref` keeps the stored pick |
| `appearance.ts:95` `refresh()` | view transition when Glass is on either side | when either side is not Classic |
| `index.html:20-37` inline twin | `g === 'classic' ? 'classic' : 'glass'` | the same three-way plus forced dark; keep keys and defaults in step with `appearance.ts` |
| `motion.ts:8` | `dataset.design === 'glass'` | `glass` or `magma` |
| `Layout.tsx:68-77` `ThemeToggle` | always | not rendered under Magma (§ 2) |
| `Layout.tsx:843-847` `useNav()` | hide on Glass phone | unchanged, or `!== 'classic'` (Q4) |
| `Layout.tsx:807-823` `NAV` | flat | gains `group` (§ 11); the brand block at `:1186-1190` takes the mark (§ 10) |
| `AppearanceSettings.tsx:4-7, 58-60` | Glass, Classic | add Magma and its hint; disable the scheme control under Magma |
| `settingsRegistry.tsx:225` | `glass ? 'Glass' : 'Classic'` | three-way label |
| `TerminalDrawer.tsx:278`, `ShellPane.tsx:49` | hard-coded xterm theme | pick the theme by design; on a change set `term.options.theme` (§ 9) |
| `main.tsx:11` | imports `glass.css` | also import `magma.css` after it |

**Phase-2 exit test for the widening:** a computed-style snapshot taken before
and after the widening must be byte-identical for Glass dark, Glass light and
Classic dark, on desktop 1440×900 and phone 390×844. The snapshot is
`getComputedStyle` of every element on the Board, an open sheet, the task
panel and /office, with a fixture store, in headless Chromium inside a heavy
lease.

## 4. Token table

Every `--tm-*` token Magma sets, in the `[data-design='magma']` block of
`theme.css` (scheme-independent: Magma is dark-only). A token not listed keeps
its `:root` value, or the widened scheme-independent Glass value (fonts, radii,
springs, durations, blur), which Magma inherits unchanged. oklch values are
given for the hues people will tune.

### Surfaces, borders, text

| Token | Magma | oklch | Classic dark (for reference) |
|---|---|---|---|
| `--tm-bg` | `#0a0605` | 0.13 0.01 35 | `#0c0e10` |
| `--tm-bg-raised` | `#160d0a` | 0.17 0.02 40 | `#141619` |
| `--tm-bg-overlay` | `#22140f` | 0.21 0.03 42 | `#1d2024` |
| `--tm-bg-inset` | `#070403` | 0.11 0.01 35 | `#08090b` |
| `--tm-border` | `#3a2219` | 0.28 0.04 40 | `#2c3036` |
| `--tm-border-strong` | `#8f5a44` | 0.52 0.08 45 | `#464b52` |
| `--tm-text` | `#fbefe6` | 0.96 0.02 60 | `#f1f2f4` |
| `--tm-text-muted` | `#c9ab9b` | 0.76 0.04 50 | `#9aa0a6` |
| `--tm-text-faint` | `#8a6c5e` | 0.55 0.04 45 | `#6b7178` |

`--tm-border-strong` is deliberately brighter than Classic's. In Magma it is
the outline of every input and select, and a component boundary needs 3:1
(§ 5). Classic's own `#464b52` is 2.2:1 on its bg.

### Accent and status

| Token | Magma | oklch | Role |
|---|---|---|---|
| `--tm-accent` | `#ff7a2e` | 0.72 0.19 45 | running, links, switch, active nav, disc |
| `--tm-accent-strong` | `#ff5a14` | 0.67 0.22 38 | pressed/fill end of the ember gradient |
| `--tm-accent-subtle` | `rgba(255,106,26,.18)` | — | own bubbles, active nav fill, selection |
| `--tm-accent-contrast` | `#1a0802` | 0.16 0.04 40 | label on any accent/ember fill (never white) |
| `--tm-status-queued` | `#b39d92` | 0.71 0.03 45 | |
| `--tm-status-running` | `#ff7a2e` | = accent | |
| `--tm-status-review` | `#ffc93d` | 0.86 0.16 85 | review, auto-review, checking |
| `--tm-status-done` | `#6fe39a` | 0.83 0.15 150 | |
| `--tm-status-published` | `#3fcf73` | 0.76 0.17 150 | |
| `--tm-status-failed` | `#ff5468` | 0.67 0.21 15 | failed, `.btn.danger`, `.warn-text` |
| `--tm-status-attention` | `#c4a1ff` | 0.76 0.13 300 | asks you, needs attention |

### Groups, presets, charts, diff, terminal

| Token | Magma | Token | Magma |
|---|---|---|---|
| `--tm-group-1` | `#c4a1ff` | `--tm-preset-small` | `#6fe39a` |
| `--tm-group-2` | `#7ab8ff` | `--tm-preset-routine` | `#7ab8ff` |
| `--tm-group-3` | `#ffd23f` | `--tm-preset-complex` | `#c4a1ff` |
| `--tm-group-4` | `#ff6fa8` | `--tm-preset-codexFree` | `#ff9a4d` |
| `--tm-group-5` | `#6fe39a` | `--tm-chart-worker` | `#ff7a2e` |
| `--tm-group-6` | `#ff9a4d` | `--tm-chart-analyze` | `#c4a1ff` |
| `--tm-group-7` | `#5fd8e0` | `--tm-tl-checks` | `#ffc93d` |
| `--tm-group-tint` | `16%` | `--tm-tl-fixing` | `#ff6fa8` |
| `--tm-diff-add-fg` | `#6fe39a` | `--tm-diff-add-bg` | `rgba(111,227,154,.12)` |
| `--tm-diff-del-fg` | `#ff5468` | `--tm-diff-del-bg` | `rgba(255,84,104,.14)` |
| `--tm-diff-hunk-fg` | `#7ab8ff` | `--tm-diff-hunk-bg` | `rgba(122,184,255,.10)` |
| `--tm-terminal-bg` | `#0a0605` | `--tm-terminal-text` | `#f3e6dc` |
| `--tm-grid-dot` | `transparent` | | |

### Shadows and Glass materials (Magma's values for the widened Glass rules)

| Token | Magma |
|---|---|
| `--tm-shadow-sm` | `0 1px 2px rgba(0,0,0,.6)` |
| `--tm-shadow-md` | `0 8px 24px rgba(0,0,0,.5)` |
| `--tm-shadow-lg` | `0 24px 64px rgba(0,0,0,.6)` |
| `--tm-glass-card` / `-card-hover` | `#160d0a` / `#1c110d`: **opaque** (= `--tm-bg-raised` and one step up; see below) |
| `--tm-glass-bar` | `rgba(30,14,10,.58)` |
| `--tm-glass-thick` | `rgba(26,12,9,.86)` |
| `--tm-glass-btn` / `-btn-hover` | `#2b1d17` / `#37261e`: **opaque** (what `rgba(255,190,150,.09/.14)` composites to over a card) |
| `--tm-glass-lens` | `rgba(255,160,92,.16)` |
| `--tm-glass-rim` | `rgba(255,160,92,.22)` |
| `--tm-glass-specular` | `rgba(255,220,180,.16)` |
| `--tm-glass-shadow` | `0 1px 1px rgba(0,0,0,.3), 0 10px 32px rgba(0,0,0,.45)` |
| `--tm-glass-shadow-sm` | `0 1px 2px rgba(0,0,0,.28), 0 6px 18px rgba(0,0,0,.2)` |
| `--tm-edge-tint` | `rgba(10,6,5,.6)` |
| `--tm-scrim` | `rgba(0,0,0,.55)` |
| `--tm-fill-press` | `rgba(255,170,120,.08)` |
| `--tm-switch-on` / `--tm-switch-off` | `var(--tm-accent)` / `rgba(143,90,68,.4)` |
| `--tm-knob` / `--tm-knob-shadow` | `#fff7f0` / `0 2px 6px rgba(0,0,0,.35)` |
| `--tm-seg-thumb` | `#4a2e22` |

Under `prefers-reduced-transparency` and without `backdrop-filter`, Magma's
rows in those blocks set `--tm-glass-bar: #1e100c` and `--tm-glass-thick: #1a0c09`,
both solid (`--tm-glass-card` and `--tm-glass-btn` are opaque already).

**Why the card and button fills are opaque in Magma.** In Glass they are
white at 5–15 % over the wallpaper. In Magma the same translucency over the
wallpaper's brightest point (the top-left ember glow, composited `#50260d`)
fails: a translucent button there puts the accent at 4.03:1, failed at 3.36:1
and faint at 2.19:1. A translucent card (`rgba(255,170,120,.055)`,
composited `#5a2d13`) puts faint at 2.41:1 and failed at 3.69:1. Text on a card or a button therefore always sits on a known opaque
colour (graded in § 5), and the wallpaper and sparks show only in the gaps
between cards. Only the materials that float and blur (`--tm-glass-bar`,
`--tm-glass-thick`, the lens) stay translucent. They are graded composited at
that same worst point in § 5.

### Office skins

The skins have their own art direction. Magma takes Glass dark's values
verbatim, because Glass's colour block does not widen: `--tm-office-floor #2c2c2e`,
`-wall #48484a`, `-wood #a2845e`, `-metal #636366`, `-skin #f1c7a1`, `-leaf #30d158`,
`-paper #f2f2f7`, `-shade #000000`; `--tm-bridge-space #04060c`, `-hull #1c2130`,
`-bulkhead #48506a`, `-console #2a2f3e`, `-trim #0b0d12`, `-star #d1d9ee`;
`--tm-guild-plank #4d3a2a`, `-stone #66605a`, `-oak #74502f`, `-parchment #efe3c2`,
`-flame #ff9f0a`, `-iron #2c2a28`. (A warm "magma" skin for the office place is
a possible later card, not this feature.)

### Magma-only tokens (new; read only by `magma.css`)

| Token | Value |
|---|---|
| `--tm-link` | `#ffa05c` (inline links in prose; lighter than the accent, so a link inside accent-coloured text stays distinct) |
| `--tm-focus` | `#ffc93d` (§ 6) |
| `--tm-ember` | `linear-gradient(135deg, #ffc93d 0%, #ff7a2e 55%, #ff5a14 100%)`: primary buttons, the Board disc, the brand mark. Stops at `#ff5a14` on purpose: the darker `#e5312b` fails a black label (4.45:1, § 5). |
| `--tm-ember-text` | `linear-gradient(90deg, #ffc93d, #ff7a2e)`: the wordmark only, via `background-clip: text` with `--tm-text` as the fallback colour |
| `--tm-ember-glow` | `0 0 0 1px rgba(255,122,46,.35), 0 0 18px rgba(255,90,20,.28)` |
| `--tm-lava-line` | `linear-gradient(90deg, transparent, #ff5a14 20%, #ffc93d 50%, #ff5a14 80%, transparent)` (1px hairlines) |
| `--tm-wallpaper` | see below |
| `--tm-sparks` | see below |

```css
--tm-wallpaper:
  radial-gradient(70% 50% at 10% 0%, rgba(255,90,20,.20), transparent 60%),
  radial-gradient(60% 45% at 100% 100%, rgba(229,49,43,.16), transparent 62%),
  radial-gradient(40% 30% at 85% 8%, rgba(255,201,61,.08), transparent 60%),
  linear-gradient(180deg, #120806 0%, #0a0605 55%, #070403 100%);
```

**The ember dot field** (`--tm-sparks`, the "pure design part" the owner asked
for, Magma's answer to Glass's wallpaper glows). Eighteen static dots of 1–2 px
in the three ember hues at 40–70 % alpha, placed by hand so that no two line up.
It is one layer, painted once:

```css
[data-design='magma'] body::before {
  content: ''; position: fixed; inset: 0; z-index: 0; pointer-events: none;
  background: var(--tm-sparks);
}
--tm-sparks:
  radial-gradient(1.6px 1.6px at 7% 12%, rgba(255,201,61,.70), transparent),
  radial-gradient(1px 1px at 18% 64%, rgba(255,160,92,.55), transparent),
  radial-gradient(1.4px 1.4px at 27% 31%, rgba(255,122,46,.60), transparent),
  radial-gradient(1px 1px at 34% 86%, rgba(255,201,61,.45), transparent),
  radial-gradient(2px 2px at 43% 9%, rgba(255,122,46,.55), transparent),
  radial-gradient(1px 1px at 51% 47%, rgba(255,201,61,.40), transparent),
  radial-gradient(1.4px 1.4px at 58% 78%, rgba(255,90,20,.60), transparent),
  radial-gradient(1px 1px at 64% 22%, rgba(255,201,61,.50), transparent),
  radial-gradient(1.8px 1.8px at 71% 58%, rgba(255,160,92,.45), transparent),
  radial-gradient(1px 1px at 77% 5%, rgba(255,201,61,.65), transparent),
  radial-gradient(1.4px 1.4px at 83% 38%, rgba(255,122,46,.50), transparent),
  radial-gradient(1px 1px at 89% 91%, rgba(255,201,61,.45), transparent),
  radial-gradient(1.6px 1.6px at 94% 17%, rgba(255,90,20,.55), transparent),
  radial-gradient(1px 1px at 12% 93%, rgba(255,122,46,.45), transparent),
  radial-gradient(1.2px 1.2px at 3% 44%, rgba(255,201,61,.50), transparent),
  radial-gradient(1px 1px at 47% 66%, rgba(255,160,92,.40), transparent),
  radial-gradient(1.2px 1.2px at 68% 95%, rgba(255,201,61,.45), transparent),
  radial-gradient(1px 1px at 98% 70%, rgba(255,122,46,.50), transparent);
```

The dots are decoration, below every surface (`z-index: 0`, and the shell sits
above it). They are never under text: cards and buttons are opaque in Magma
(§ 4, `--tm-glass-card`/`-btn`), and the translucent floating materials blur
what is behind them (graded at the wallpaper's brightest point, § 5). Under
`prefers-reduced-transparency` they stay, because they are not a material.

**Other decoration, from mockup A** (all static, all `magma.css`):

- *Lava hairline:* `height: 1px; background: var(--tm-lava-line); opacity: .6`
  as a pseudo-element under the sidebar brand block, and on the phone under the
  top bar. It is a pseudo-element of `.sidebar`/the top bar's inner row, never
  of `.header` or `.main` (both hold fixed overlays).
- *Active nav item:* `background: linear-gradient(90deg, rgba(255,122,46,.20), rgba(255,122,46,.05));
  box-shadow: inset 0 0 0 1px rgba(255,122,46,.26), inset 0 0 14px rgba(255,90,20,.16)`,
  and a 2px rail `linear-gradient(180deg, #ffc93d, #ff7a2e 50%, #ff5a14)` with
  `box-shadow: 0 0 8px rgba(255,90,20,.9)` (this is the nav's one glow).
- *Primary button:* `background: var(--tm-ember); color: var(--tm-accent-contrast);
  box-shadow: inset 0 1px 0 rgba(255,236,200,.45), inset 0 0 12px rgba(255,201,61,.25), 0 0 18px rgba(255,90,20,.35)`.
- *Board disc (phone), active:* `background: var(--tm-ember); color: var(--tm-accent-contrast);
  box-shadow: inset 0 1px 0 rgba(255,240,210,.55), inset 0 -8px 14px rgba(229,49,43,.30), 0 0 0 4px rgba(10,6,5,.85), 0 0 24px rgba(255,90,20,.55)`.
  Inactive: `--tm-glass-thick` with an inset 1.5px `rgba(255,122,46,.65)` ring
  and an accent icon. The lens on the capsules is Glass's, in Magma's
  `--tm-glass-lens`/`-rim`/`-specular`.

## 5. Contrast proof

**Method.** WCAG 2.x relative luminance over linearised sRGB:
`L = 0.2126 R + 0.7152 G + 0.0722 B` with `c ≤ 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`,
and `ratio = (L_light + 0.05) / (L_dark + 0.05)`. A translucent colour (a badge
tint, the own-bubble fill, a selection) is first alpha-blended in sRGB over the
surface it sits on, and the blended hex is shown. Thresholds: text 4.5:1;
large text and non-text UI (borders of inputs, the focus ring, switches,
progress fills) 3:1. `--tm-text-faint` is **decoration and disabled state
only**, never a label or a hint (`docs/mobile.md` § Contrast already says
labels use muted), so it is held to 3:1. The script that produced the table
(Node, no dependencies; output pasted verbatim below it):

```js
const hex = h => { h = h.replace('#',''); const a = h.length === 8 ? parseInt(h.slice(6,8),16)/255 : 1;
  return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)).concat(a); };
const blend = (f,b) => f.slice(0,3).map((c,i) => c*f[3] + b[i]*(1-f[3]));
const lin = c => { c /= 255; return c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4; };
const L = ([r,g,b]) => 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
const ratio = (fg,bg) => { const B = hex(bg), F = blend(hex(fg),B);
  const [a,b] = [L(F),L(B)].sort((x,y) => y-x); return (a+0.05)/(b+0.05); };
// tints: mix(colour, alpha, surface) → the blended hex, then ratio(colour, tint)
```

| Pair | Foreground | Background | Ratio | Needs | Result |
|---|---|---|---:|---:|---|
| Body text on bg | `text #fbefe6` | `bg #0a0605` | 17.86 | 4.5:1 | pass |
| Body text on raised | `text #fbefe6` | `raised #160d0a` | 16.96 | 4.5:1 | pass |
| Body text on overlay | `text #fbefe6` | `overlay #22140f` | 15.82 | 4.5:1 | pass |
| Body text on inset | `text #fbefe6` | `inset #070403` | 18.09 | 4.5:1 | pass |
| Muted text on bg | `muted #c9ab9b` | `bg #0a0605` | 9.40 | 4.5:1 | pass |
| Muted text on raised | `muted #c9ab9b` | `raised #160d0a` | 8.92 | 4.5:1 | pass |
| Muted text on overlay | `muted #c9ab9b` | `overlay #22140f` | 8.33 | 4.5:1 | pass |
| Muted text on inset | `muted #c9ab9b` | `inset #070403` | 9.52 | 4.5:1 | pass |
| Faint (decoration/disabled only) on bg | `faint #8a6c5e` | `bg #0a0605` | 4.21 | 3:1 | pass |
| Faint (decoration/disabled only) on raised | `faint #8a6c5e` | `raised #160d0a` | 4.00 | 3:1 | pass |
| Faint (decoration/disabled only) on overlay | `faint #8a6c5e` | `overlay #22140f` | 3.73 | 3:1 | pass |
| Accent text on bg | `accent #ff7a2e` | `bg #0a0605` | 7.76 | 4.5:1 | pass |
| Accent text on raised | `accent #ff7a2e` | `raised #160d0a` | 7.37 | 4.5:1 | pass |
| Accent text on overlay | `accent #ff7a2e` | `overlay #22140f` | 6.87 | 4.5:1 | pass |
| Link on bg | `link #ffa05c` | `bg #0a0605` | 10.02 | 4.5:1 | pass |
| Link on raised | `link #ffa05c` | `raised #160d0a` | 9.52 | 4.5:1 | pass |
| Link on overlay | `link #ffa05c` | `overlay #22140f` | 8.88 | 4.5:1 | pass |
| Status queued text on raised | `queued #b39d92` | `raised #160d0a` | 7.44 | 4.5:1 | pass |
| Badge queued: text on its 16% tint | `queued #b39d92` | `tint #2f2420` | 5.85 | 4.5:1 | pass |
| Status running text on raised | `running #ff7a2e` | `raised #160d0a` | 7.37 | 4.5:1 | pass |
| Badge running: text on its 16% tint | `running #ff7a2e` | `tint #3b1e10` | 5.86 | 4.5:1 | pass |
| Status review text on raised | `review #ffc93d` | `raised #160d0a` | 12.48 | 4.5:1 | pass |
| Badge review: text on its 16% tint | `review #ffc93d` | `tint #3b2b12` | 8.88 | 4.5:1 | pass |
| Status done text on raised | `done #6fe39a` | `raised #160d0a` | 11.98 | 4.5:1 | pass |
| Badge done: text on its 16% tint | `done #6fe39a` | `tint #242f21` | 8.73 | 4.5:1 | pass |
| Status published text on raised | `published #3fcf73` | `raised #160d0a` | 9.47 | 4.5:1 | pass |
| Badge published: text on its 16% tint | `published #3fcf73` | `tint #1d2c1b` | 7.27 | 4.5:1 | pass |
| Status failed text on raised | `failed #ff5468` | `raised #160d0a` | 6.13 | 4.5:1 | pass |
| Badge failed: text on its 16% tint | `failed #ff5468` | `tint #3b1819` | 5.05 | 4.5:1 | pass |
| Status attention text on raised | `attention #c4a1ff` | `raised #160d0a` | 9.02 | 4.5:1 | pass |
| Badge attention: text on its 16% tint | `attention #c4a1ff` | `tint #322531` | 6.85 | 4.5:1 | pass |
| Primary button label on ember fill stop | `contrast #1a0802` | `fill #ffc93d` | 12.67 | 4.5:1 | pass |
| Primary button label on ember fill stop | `contrast #1a0802` | `fill #ff7a2e` | 7.48 | 4.5:1 | pass |
| Primary button label on ember fill stop | `contrast #1a0802` | `fill #ff5a14` | 6.23 | 4.5:1 | pass |
| Ghost button label on overlay | `text #fbefe6` | `overlay #22140f` | 15.82 | 4.5:1 | pass |
| Danger button label on failed fill | `contrast #1a0802` | `failed #ff5468` | 6.22 | 4.5:1 | pass |
| Own bubble text on accent-subtle | `text #fbefe6` | `own #401e0d` | 13.19 | 4.5:1 | pass |
| Own bubble timestamp (muted) on accent-subtle | `muted #c9ab9b` | `own #401e0d` | 6.94 | 4.5:1 | pass |
| Role bubble text on overlay | `text #fbefe6` | `overlay #22140f` | 15.82 | 4.5:1 | pass |
| Role bubble timestamp on overlay | `muted #c9ab9b` | `overlay #22140f` | 8.33 | 4.5:1 | pass |
| Active nav label (text) on active fill | `text #fbefe6` | `nav-on #361809` | 14.40 | 4.5:1 | pass |
| Active nav counter (accent) on active fill | `accent #ff7a2e` | `nav-on #361809` | 6.25 | 4.5:1 | pass |
| Nav counter (muted) on sidebar | `muted #c9ab9b` | `bg #0a0605` | 9.40 | 4.5:1 | pass |
| Tab count label on accent pill | `contrast #1a0802` | `accent #ff7a2e` | 7.48 | 4.5:1 | pass |
| Urgent tab count label on attention pill | `contrast #1a0802` | `attention #c4a1ff` | 9.16 | 4.5:1 | pass |
| Tainted chip (review) on raised | `review #ffc93d` | `tint` | 8.88 | 4.5:1 | pass |
| Focus ring vs bg (non-text) | `focus #ffc93d` | `bg #0a0605` | 13.13 | 3:1 | pass |
| Input border (border-strong) vs bg (non-text) | `border-strong #8f5a44` | `bg #0a0605` | 3.57 | 3:1 | pass |
| Input border (border-strong) vs raised (non-text) | `border-strong #8f5a44` | `raised #160d0a` | 3.39 | 3:1 | pass |
| Switch on (accent) vs bg (non-text) | `accent #ff7a2e` | `bg #0a0605` | 7.76 | 3:1 | pass |
| Progress bar fill vs track (non-text) | `accent #ff7a2e` | `overlay #22140f` | 6.87 | 3:1 | pass |
| Group 1 chip text on its tint | `g1 #c4a1ff` | `tint #322531` | 6.85 | 4.5:1 | pass |
| Group 2 chip text on its tint | `g2 #7ab8ff` | `tint #262831` | 7.08 | 4.5:1 | pass |
| Group 3 chip text on its tint | `g3 #ffd23f` | `tint #3b2d12` | 9.26 | 4.5:1 | pass |
| Group 4 chip text on its tint | `g4 #ff6fa8` | `tint #3b1d23` | 5.84 | 4.5:1 | pass |
| Group 5 chip text on its tint | `g5 #6fe39a` | `tint #242f21` | 8.73 | 4.5:1 | pass |
| Group 6 chip text on its tint | `g6 #ff9a4d` | `tint #3b2415` | 6.89 | 4.5:1 | pass |
| Group 7 chip text on its tint | `g7 #5fd8e0` | `tint #222d2c` | 8.37 | 4.5:1 | pass |
| Diff add fg on diff add bg | `add #6fe39a` | `add-bg #162117` | 10.39 | 4.5:1 | pass |
| Diff body text on add bg | `text #fbefe6` | `add-bg #162117` | 14.71 | 4.5:1 | pass |
| Diff del fg on diff del bg | `del #ff5468` | `del-bg #2c1113` | 5.62 | 4.5:1 | pass |
| Diff body text on del bg | `text #fbefe6` | `del-bg #2c1113` | 15.54 | 4.5:1 | pass |
| Diff hunk fg on diff hunk bg | `hunk #7ab8ff` | `hunk-bg #15181e` | 8.57 | 4.5:1 | pass |
| Diff body text on hunk bg | `text #fbefe6` | `hunk-bg #15181e` | 15.74 | 4.5:1 | pass |
| Terminal foreground | `foreground #f3e6dc` | `terminal-bg #0a0605` | 16.48 | 4.5:1 | pass |
| Terminal black (a TUI background, not text) | `black #2a1c17` | `terminal-bg #0a0605` | 1.23 | n/a | — |
| Terminal red | `red #ff5468` | `terminal-bg #0a0605` | 6.45 | 4.5:1 | pass |
| Terminal green | `green #6fe39a` | `terminal-bg #0a0605` | 12.61 | 4.5:1 | pass |
| Terminal yellow | `yellow #ffc93d` | `terminal-bg #0a0605` | 13.13 | 4.5:1 | pass |
| Terminal blue | `blue #7ab8ff` | `terminal-bg #0a0605` | 9.73 | 4.5:1 | pass |
| Terminal magenta | `magenta #ff6fa8` | `terminal-bg #0a0605` | 7.77 | 4.5:1 | pass |
| Terminal cyan | `cyan #5fd8e0` | `terminal-bg #0a0605` | 11.90 | 4.5:1 | pass |
| Terminal white | `white #e8d8cc` | `terminal-bg #0a0605` | 14.53 | 4.5:1 | pass |
| Terminal brightBlack (dim text, UI ≥ 3) | `brightBlack #8a6c5e` | `terminal-bg #0a0605` | 4.21 | 3:1 | pass |
| Terminal brightRed | `brightRed #ff8590` | `terminal-bg #0a0605` | 8.65 | 4.5:1 | pass |
| Terminal brightGreen | `brightGreen #9af0b6` | `terminal-bg #0a0605` | 14.90 | 4.5:1 | pass |
| Terminal brightYellow | `brightYellow #ffe08a` | `terminal-bg #0a0605` | 15.64 | 4.5:1 | pass |
| Terminal brightBlue | `brightBlue #a8d0ff` | `terminal-bg #0a0605` | 12.61 | 4.5:1 | pass |
| Terminal brightMagenta | `brightMagenta #ff9cc4` | `terminal-bg #0a0605` | 10.38 | 4.5:1 | pass |
| Terminal brightCyan | `brightCyan #8ce8ee` | `terminal-bg #0a0605` | 14.30 | 4.5:1 | pass |
| Terminal brightWhite | `brightWhite #fff7f0` | `terminal-bg #0a0605` | 19.03 | 4.5:1 | pass |
| Terminal foreground on selection | `fg #f3e6dc` | `selection #582b12` | 9.70 | 4.5:1 | pass |
| Terminal cursor vs bg (non-text) | `cursor #ffc93d` | `terminal-bg` | 13.13 | 3:1 | pass |

All 82 graded pairs above pass. Terminal black is a TUI background colour, not text, so it is not graded. The tightest are the input border on raised (3.39) and on bg (3.57) against 3:1, faint on overlay (3.73, decoration only), the failed badge on its tint (5.05), and the darkest primary-button stop (6.23).

**Translucent surfaces, composited at the worst case.** Text in Magma also sits on
Glass's floating materials, which are translucent over the wallpaper. Each is
graded over the wallpaper's **brightest point**: the gradient's top stop
`#120806` under the top-left ember glow at its peak alpha (.20) plus the
yellow glow (.08), which composites to `#50260d`. Real content under a blurred
bar is darker than that. Card and button fills are opaque (§ 4), so they are
graded on their own colour. The tab lens carries only tab labels (body,
muted, and accent when active).

| Pair | Foreground | Background | Ratio | Needs | Result |
|---|---|---|---:|---:|---|
| Body on card hover (opaque) | `text #fbefe6` | `card-hover #1c110d` | 16.37 | 4.5:1 | pass |
| Muted on card hover (opaque) | `muted #c9ab9b` | `card-hover #1c110d` | 8.62 | 4.5:1 | pass |
| Faint (decoration) on card hover (opaque) | `faint #8a6c5e` | `card-hover #1c110d` | 3.86 | 3:1 | pass |
| Accent on card hover (opaque) | `accent #ff7a2e` | `card-hover #1c110d` | 7.11 | 4.5:1 | pass |
| Failed on card hover (opaque) | `failed #ff5468` | `card-hover #1c110d` | 5.92 | 4.5:1 | pass |
| Attention on card hover (opaque) | `attention #c4a1ff` | `card-hover #1c110d` | 8.71 | 4.5:1 | pass |
| Review on card hover (opaque) | `review #ffc93d` | `card-hover #1c110d` | 12.04 | 4.5:1 | pass |
| Body on button (opaque) | `text #fbefe6` | `btn #2b1d17` | 14.40 | 4.5:1 | pass |
| Muted on button (opaque) | `muted #c9ab9b` | `btn #2b1d17` | 7.58 | 4.5:1 | pass |
| Faint (decoration) on button (opaque) | `faint #8a6c5e` | `btn #2b1d17` | 3.40 | 3:1 | pass |
| Accent on button (opaque) | `accent #ff7a2e` | `btn #2b1d17` | 6.26 | 4.5:1 | pass |
| Failed on button (opaque) | `failed #ff5468` | `btn #2b1d17` | 5.21 | 4.5:1 | pass |
| Attention on button (opaque) | `attention #c4a1ff` | `btn #2b1d17` | 7.66 | 4.5:1 | pass |
| Review on button (opaque) | `review #ffc93d` | `btn #2b1d17` | 10.59 | 4.5:1 | pass |
| Body on button hover (opaque) | `text #fbefe6` | `btn-hover #37261e` | 12.75 | 4.5:1 | pass |
| Muted on button hover (opaque) | `muted #c9ab9b` | `btn-hover #37261e` | 6.71 | 4.5:1 | pass |
| Faint (decoration) on button hover (opaque) | `faint #8a6c5e` | `btn-hover #37261e` | 3.01 | 3:1 | pass |
| Accent on button hover (opaque) | `accent #ff7a2e` | `btn-hover #37261e` | 5.54 | 4.5:1 | pass |
| Failed on button hover (opaque) | `failed #ff5468` | `btn-hover #37261e` | 4.61 | 4.5:1 | pass |
| Attention on button hover (opaque) | `attention #c4a1ff` | `btn-hover #37261e` | 6.78 | 4.5:1 | pass |
| Review on button hover (opaque) | `review #ffc93d` | `btn-hover #37261e` | 9.38 | 4.5:1 | pass |
| Body on glass bar over the glow peak | `text #fbefe6` | `bar on peak #33180b` | 14.57 | 4.5:1 | pass |
| Muted on glass bar over the glow peak | `muted #c9ab9b` | `bar on peak #33180b` | 7.66 | 4.5:1 | pass |
| Faint (decoration) on glass bar over the glow peak | `faint #8a6c5e` | `bar on peak #33180b` | 3.44 | 3:1 | pass |
| Accent on glass bar over the glow peak | `accent #ff7a2e` | `bar on peak #33180b` | 6.33 | 4.5:1 | pass |
| Failed on glass bar over the glow peak | `failed #ff5468` | `bar on peak #33180b` | 5.27 | 4.5:1 | pass |
| Attention on glass bar over the glow peak | `attention #c4a1ff` | `bar on peak #33180b` | 7.75 | 4.5:1 | pass |
| Review on glass bar over the glow peak | `review #ffc93d` | `bar on peak #33180b` | 10.71 | 4.5:1 | pass |
| Body on glass thick (sheets) over the glow peak | `text #fbefe6` | `thick on peak #22100a` | 16.22 | 4.5:1 | pass |
| Muted on glass thick (sheets) over the glow peak | `muted #c9ab9b` | `thick on peak #22100a` | 8.53 | 4.5:1 | pass |
| Faint (decoration) on glass thick (sheets) over the glow peak | `faint #8a6c5e` | `thick on peak #22100a` | 3.83 | 3:1 | pass |
| Accent on glass thick (sheets) over the glow peak | `accent #ff7a2e` | `thick on peak #22100a` | 7.04 | 4.5:1 | pass |
| Failed on glass thick (sheets) over the glow peak | `failed #ff5468` | `thick on peak #22100a` | 5.86 | 4.5:1 | pass |
| Attention on glass thick (sheets) over the glow peak | `attention #c4a1ff` | `thick on peak #22100a` | 8.63 | 4.5:1 | pass |
| Review on glass thick (sheets) over the glow peak | `review #ffc93d` | `thick on peak #22100a` | 11.93 | 4.5:1 | pass |
| Body on tab lens over the bar over the glow peak | `text #fbefe6` | `lens on bar #542e18` | 10.44 | 4.5:1 | pass |
| Muted on tab lens over the bar over the glow peak | `muted #c9ab9b` | `lens on bar #542e18` | 5.49 | 4.5:1 | pass |
| Accent on tab lens over the bar over the glow peak | `accent #ff7a2e` | `lens on bar #542e18` | 4.53 | 4.5:1 | pass |

All 38 composited rows pass. The tightest is the active tab label on the lens
at the theoretical peak (4.53), which in practice sits at the bottom of the
screen, far from the top-left glow.

**Pairs that FAIL and are therefore not used:**

| Pair | Ratio | Instead |
|---|---:|---|
| white on `#ff5a14` (a white-label orange button) | 3.12 | `--tm-accent-contrast` `#1a0802` label (6.23) |
| `#1a0802` on `#e5312b` (a red end stop for the ember gradient) | 4.45 | gradient stops at `#ff5a14` |
| `--tm-gray-0` on `#c4a1ff` (today's `.tab-count.urgent` label) | 2.03 | `--tm-accent-contrast` (9.16), a `magma.css` rule |
| Classic's `--tm-border-strong` `#464b52` as an input outline | 2.20 | Magma's `#8f5a44` (3.57 on bg, 3.39 on raised) |

## 6. Focus ring

- **Colour `--tm-focus` `#ffc93d` (ember yellow), not the accent.** Classic
  draws `:focus-visible` in `--tm-accent` (`theme.css:619-623`). In Magma most
  focusable things that matter (primary buttons, the active nav item, the
  Board disc) are already orange, and an orange ring on an orange button
  disappears. Yellow is 13.1:1 on bg and visibly different from the button
  under it.
- **Geometry: Classic's** `outline: 2px solid; outline-offset: 2px` with the
  element's own radius. Rows keep `outline-offset: -2px`
  (`.task-row:focus-visible`, `theme.css:1286`), so the ring stays inside the
  panel's clip. The dialogs that take focus without a ring
  (`.slideover`, `.qmodal`) stay ringless.
- **No glow on focus.** A ring is an outline, never a box-shadow. Box-shadows
  are already used by the ember glows, and a focus state must not look like
  "lit".
- Rule: `[data-design='magma'] :focus-visible { outline-color: var(--tm-focus); }`
  in `magma.css`. That one declaration wins over every component rule that
  only sets the offset, because those rules never set the colour.
- **Composer and inputs:** focus also brightens the border to `--tm-accent`
  (an input's own focus treatment, already in Glass). The yellow ring then
  sits outside it.

## 7. Typography and spacing

**No deltas.** Magma inherits Glass's scheme-independent block: SF (`-apple-system`)
for display and body, `ui-monospace`/SF Mono for code, the Glass radii
(8/12/22/32), the phone type scale (15pt base, 34pt large titles) and Dynamic
Type. Spacing (`--tm-space-1..9`) is untouched in every design.

The only typographic additions are both Magma-only and both local:

- the **wordmark** "Gor" (§ 10): display face, 700, `letter-spacing: -0.01em`,
  filled with `--tm-ember-text`;
- **counters** (§ 11): `font-variant-numeric: tabular-nums` (in every design,
  since the counters are not a Magma feature).

## 8. Motion

- **Entry only.** Magma uses Glass's motion as it is: page rise, the
  `data-entering` row cascade, press and spring, sheets on the
  react-modal-sheet tween, `exitGhost` exits, and the view transition on a
  design change. It adds **one** animation of its own: the active nav item's
  ember glow fades in over `--tm-dur-base` when it changes, as a `transition`
  on `box-shadow`, not a keyframe.
- **No new infinite animations.** The existing live pulses (badge dots, live
  dots, the queue chip) run in Magma as in Glass: stepped `steps(4, jump-none)`
  while awake, stopped under `html[data-calm]`
  (`docs/spa-performance.md` § Calm). Magma adds nothing to either list. The
  chat's working indicator (§ 13) is static for that reason. A future Magma
  pulse would have to go in BOTH lists at the end of `theme.css`.
- **Reduced Motion.** As in Glass: durations collapse (the global rule),
  `--tm-sheet-dur: 0ms`, no cascade, no page rise, `exitGhost` does not ghost,
  the view transition is skipped, and the nav glow appears instantly. Static
  decoration (wallpaper, sparks, hairline) is not motion and stays.
- **Static glow budget.** At most **four** lit glows on any screen:
  - the active nav item (desktop) or the Board disc while the Board is the page
    (phone);
  - the one primary button of the view;
  - the focused composer;
  - the brand mark's spark.

  Glows are `box-shadow` (`--tm-ember-glow`), never `filter: drop-shadow`,
  `text-shadow` on body text, `mix-blend-mode` or animated gradients. **Rows,
  cards and badges never glow.** A board of 50 lit rows is noise, and a
  shadow per row costs paint on every scroll.
- **The decoration layer is one paint.** The wallpaper is `body`'s background.
  The ember dot field is one `body::before` with `position: fixed; inset: 0;
  pointer-events: none; z-index: 0` (the body never scrolls; `.main` does). It
  is painted once and composited, so it never repaints on scroll and costs
  nothing at idle. It is not on `.main`, `.header` or `.app` (the containing-block
  rule, glass.md § Materials).
- **backdrop-filter.** Magma adds none of its own. It reuses exactly Glass's
  blurred surfaces (floating header capsules, the phone tab bar, sheets, the
  task panel, the question modal, popovers, toasts, the offline banner), with
  the same `--tm-blur` radii and the same four rules: no blur on `.main`,
  `.header` or `.app`, and cards never blur. The budget therefore equals
  Glass's: `docs/spa-performance.md` § Measurements targets idle ≈ 0 % and
  active GPU ≤ 10 % for the Glass board, and Magma is measured against the
  same numbers in phase 2. Over a near-black wallpaper the blur is barely
  visible. Its job is legibility over scrolled content, not looks, which is
  why it is kept rather than dropped.

## 9. xterm colours

xterm takes concrete colours, so `TerminalDrawer.tsx:278` and `ShellPane.tsx:49`
today hard-code `{ background: '#0a0c0e', foreground: '#d2f5ec', cursor: '#2dd4bf' }`
and leave xterm's default ANSI palette, whose blue `#2472c8` is 4.0:1 on
Classic's terminal background (`#0a0c0e`). Under Magma both components take this theme object (phase 2 moves the
three objects into one `terminalTheme(design)` helper beside the components):

| Key | Magma | Ratio on `#0a0605` |
|---|---|---:|
| `background` | `#0a0605` (= `--tm-terminal-bg`) | — |
| `foreground` | `#f3e6dc` (= `--tm-terminal-text`) | 16.5 |
| `cursor` / `cursorAccent` | `#ffc93d` / `#0a0605` | 13.1 |
| `selectionBackground` | `rgba(255,122,46,.32)` (blends to `#582b12`) | fg on it 9.7 |
| `black` / `brightBlack` | `#2a1c17` / `#8a6c5e` | TUI bg / 4.2 |
| `red` / `brightRed` | `#ff5468` / `#ff8590` | 6.5 / 8.7 |
| `green` / `brightGreen` | `#6fe39a` / `#9af0b6` | 12.6 / 14.9 |
| `yellow` / `brightYellow` | `#ffc93d` / `#ffe08a` | 13.1 / 15.6 |
| `blue` / `brightBlue` | `#7ab8ff` / `#a8d0ff` | 9.7 / 12.6 |
| `magenta` / `brightMagenta` | `#ff6fa8` / `#ff9cc4` | 7.8 / 10.4 |
| `cyan` / `brightCyan` | `#5fd8e0` / `#8ce8ee` | 11.9 / 14.3 |
| `white` / `brightWhite` | `#e8d8cc` / `#fff7f0` | 14.5 / 19.0 |

(Exact ratios for every key are in § 5's table.) The ANSI set is changed
deliberately: the claude CLI paints diffs, prompts and its own chrome in ANSI
red/green/blue, and the default blue is the one hue that fails on black.
Classic and Glass keep today's theme object; whether they adopt the corrected
ANSI set is outside this feature.

## 10. The Gor mark

A rounded tile, a single-stroke **G** in the ember gradient, and one spark
where the G opens. It is one stroke, one dot and one tile, so it survives
16 px.

### SVG master

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Gor">
  <defs>
    <linearGradient id="gor-ember" x1="14" y1="50" x2="50" y2="14" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff5a14"/>
      <stop offset=".6" stop-color="#ff7a2e"/>
      <stop offset="1" stop-color="#ffc93d"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#0a0605"/>
  <path d="M44.73 19.27A18 18 0 1 0 50 32H34" fill="none" stroke="url(#gor-ember)"
        stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="49" cy="14" r="4.5" fill="#ffc93d"/>
</svg>
```

Geometry: the G is a 315° arc of radius 18 around the centre (32,32), from
the top-right (−45°) counter-clockwise round to the right (0°), then the bar
back in to (34,32). The stroke is 8/64, so 2 px at 16 px. The spark sits in the
G's opening at (49,14).

**Template (monochrome) variant**, for the macOS menu bar: the same path and
circle in `#000`, with no tile and no gradient (macOS tints a template image
itself). The stroke is 9 and the spark is separated (see the small-size rule
below):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M44.73 19.27A18 18 0 1 0 50 32H34" fill="none" stroke="#000"
        stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="54" cy="10" r="5" fill="#000"/>
</svg>
```

**Small sizes (≤ 18 px).** In the master the spark overlaps the arc's end, on
purpose: from 32 px up it reads as a molten drop leaving the stroke (see
`gor-mark.html`). At 16 px (favicon) and 18 px (menu bar) the rendered sheet
shows the two merging into one blob. The G still reads, but the spark is
lost. The small exports therefore move the spark out to **(54,10), r = 5**.
That is 13 units from the stroke end's centre (44.73,19.27), so after the
stroke's 4-unit half-width and the spark's radius a 4-unit gap remains, which
is 1 px at 16 px. It is still inside the tile's rounded corner. The tile's
corner radius rounds to whole pixels at 16 and 32. The phase-2 icon export
renders 16/18/32 px both ways and keeps the variant only if it reads better.

### Icon sizes

| Asset | Size | Notes |
|---|---|---|
| `web/public/favicon.ico` | 16, 32, 48 | multi-size ICO; 16 uses the small-size spark |
| `favicon-16x16.png`, `favicon-32x32.png` | 16, 32 | |
| `apple-touch-icon.png` | 180×180 | **full-bleed square, no transparency, no rx.** iOS rounds the corners itself, and a pre-rounded tile shows a dark ring |
| `android-chrome-192x192.png`, `android-chrome-512x512.png` | 192, 512 | `purpose: any` |
| `android-chrome-maskable-512x512.png` (new) | 512 | `purpose: maskable`; the G inside the 80 % safe circle |
| `site.webmanifest` | — | `name`/`short_name` "Gor" (Q2), `background_color` `#0a0605`. `theme_color` is static per manifest and cannot follow the design: `#0a0605` |
| TM Bar menu-bar template | 18×18 pt: 18 px @1x, 36 px @2x | PDF or PNG pair, `isTemplate = true`. It replaces only the idle `checklist` symbol (`Store.swift:16-24`). The state symbols (stopped, paused, rebuilding, memory, unreachable, `bolt` while running) stay, because they carry meaning |
| TM Bar app icon | 1024 master → `.icns` with 16, 32, 64, 128, 256, 512, 1024 (16@1x … 512@2x) | the macOS grid: an 824×824 tile centred in 1024, corner radius ≈ 185. It replaces the drawn `checklist` icon (`WebWindow.swift:690-707`); `scripts/menubar.mjs` gains `CFBundleIconFile` |

### Wordmark (sidebar brand block, `Layout.tsx:1186-1190`)

```
┌──────────────────────────────┐
│ [G]  Gor                     │   mark 24 px · "Gor" display 700, text-lg
│      tasks · agents · terminals   sub-line: body, text-xs, --tm-text-muted
│ ─────────────────────────────│   Magma only: 1px --tm-lava-line, 60 % opacity
```

- The mark is inline SVG (one component, `GorMark`, used by the sidebar, the
  phone `.brand-mini` and the empty states), so it is never a network request
  and it takes `aria-hidden`. The brand block keeps one accessible name,
  "Gor".
- Classic: the wordmark in `--tm-font-mono` 600, with the mark in its
  gradient. Glass: display 700 in `--tm-text`. Magma: display 700 filled with
  `--tm-ember-text`, falling back to `--tm-text`.
- The phone `.brand-mini` shows the mark only (it is hidden under 430 px
  already).

## 11. Side-nav anatomy

The flat `NAV` (15 entries, `Layout.tsx:807-823`) becomes **three groups**, in
every design:

| Group (caption) | Entries | Counters |
|---|---|---|
| **Work** | Board · Inbox · Queue · Timeline · Dashboard | Board, Inbox, Queue |
| **Agents** | Features · Jobs · Office · Chat · Reports | Features (proposed extras: Jobs, Chat, Office) |
| **Setup** | Terminals · Shared · Repos · Config · Handbook | (proposed: Terminals) |

Order within a group is today's order, except that Terminals moves to the top
of Setup. On the phone the tab bar does not change (Dashboard · Inbox · Board ·
Queue · More). The More sheet shows the same three groups as captioned tile
sections.

```
 ┌───────────────────────────────┐
 │ [G] Gor                       │
 │     tasks · agents · terminals│
 │ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │  lava hairline (Magma only)
 │ WORK                          │  caption: text-xs, 600, faint→muted, +0.06em, uppercase
 │▌▣ Board              2 · 54   │  active: accent-subtle fill, 2px accent rail, glow (Magma)
 │ ✉ Inbox                  7    │  urgent → attention colour
 │ ≡ Queue                  3    │
 │ ◷ Timeline                    │  no counter defined → nothing drawn
 │ ▦ Dashboard                   │
 │ ───────────────────────────── │  separator: 1px --tm-border, space-3 above and below
 │ AGENTS                        │
 │ ◆ Features               1    │
 │ ⏲ Jobs                        │
 │ ⌂ Office                      │
 │ ◌ Chat                   •    │  (proposed) unread dot
 │ ▤ Reports                     │
 │ ───────────────────────────── │
 │ SETUP                         │
 │ ▭ Terminals                   │
 │ ⇄ Shared   ⎇ Repos  ⚙ Config  │  (one per row in the real nav)
 │ ▢ Handbook                    │
 └───────────────────────────────┘
```

- **Separator.** A 1px `--tm-border` line between groups (CSS `border-top` on
  the group, never an `<hr>`, so it is not a focus or reading stop) and a
  caption above each group: `--tm-text-xs`, weight 600, `letter-spacing: .06em`,
  uppercase, `--tm-text-muted`. Muted, not faint, because a caption is a
  label (§ 5).
- **Active state** (in every design: `aria-current="page"` from `NavLink`):
  - Classic: accent text + 2px accent left rail (today's look);
  - Glass: today's tint;
  - Magma: `--tm-accent-subtle` fill, a 2px `--tm-accent` left rail, label in
    `--tm-text`, icon in `--tm-accent`, and `--tm-ember-glow` (one of the four
    glows).
- **Counters.** Right-aligned in the row (`margin-left: auto`):
  - `font-variant-numeric: tabular-nums`, `--tm-text-xs`, weight 600,
    `--tm-text-muted`. Quiet: no pill and no fill;
  - **hidden at 0**: the element is not rendered, so no "0" and no empty
    pill;
  - capped at **"99+"** (n > 99);
  - Board shows **two** numbers, `live · drafts`. `live` is in
    `--tm-status-running`; the `·` and drafts are muted. Either side is
    omitted at 0, and with both at 0 the counter is absent;
  - the Inbox counter turns `--tm-status-attention` when an urgent item
    (question or attention) is among the decisions, which matches the phone
    tab's `.tab-count.urgent`;
  - the active row's counter is `--tm-accent` (6.25:1 on the active fill,
    § 5).
- **Keyboard and focus order.** The brand block (not focusable), then each
  group's links in visual order, top to bottom: Tab/Shift-Tab only, with no
  roving tabindex (15 links), and no tab stop on captions, separators or
  counters. The structure is `<nav aria-label="Main">` → per group
  `<div role="group" aria-labelledby="nav-cap-work">` with the caption as
  that id → links.
- **Accessible names.** The link's `aria-label` carries the counts and the
  counter spans are `aria-hidden`, so a screen reader hears one phrase:
  - "Board, 2 running, 54 drafts" (only the non-zero parts: "Board, 54 drafts");
  - "Inbox, 7 decisions, 1 urgent";
  - "Queue, 3 queued";
  - "Features, 1 in progress";
  - "Chat, unread" (proposed).

  Counters do **not** use `aria-live`: a count that moves every few seconds
  would read out over everything. Collapsed into a phone tile, the same
  label is used.
- **Collapsed sidebar** (none today): out of scope. Should one come, the
  counter becomes a dot on the icon's shoulder like `.tab-count`.

## 12. Counter definitions

All counters come from the **existing WS-fed store** (`state.tsx`, a tracked
store: a component re-renders only on the slices it reads). There is no new
endpoint and no polling. One hook, `useNavCounts()` in `Layout.tsx`, computes
them with `useMemo` over exactly the slices named below, and the sidebar, the
More sheet and the phone tab bar all read it. It reads neither `runs` nor
`activity`, so `run.activity` frames never re-render the nav.

**Workspace scope.** Every counter is computed for the **current workspace**
(`useWorkspace()`, the URL's `?ws=`), exactly as the page it links to.
`inScope(task)` is used for tasks and `inScopeRepo(repoId)` for everything
else; a repo-less item (`repoId == null`) is in every scope; All = no filter.
A counter never counts what its page would not show.

### Core set (proposed for phase 3; signed off with this doc)

| Counter | Predicate (store slice → filter) | Matches |
|---|---|---|
| **Board · live** | `tasks.filter(t => inScope(t) && !t.hiddenAt && (t.status === 'running' \|\| t.status === 'waiting'))` | the board's working rows (`useBoardTasks()` = `inScope && !hiddenAt`); `waiting` is a live session still holding its slot (CLAUDE.md § Waiting) |
| **Board · drafts** | `tasks.filter(t => inScope(t) && !t.hiddenAt && t.status === 'draft')` | the board's Drafts section, hidden drafts excluded |
| **Inbox** | `decisions(useInbox()).length` — `useInbox()` is already workspace-scoped (`buildInbox` `repoIds`) | the phone tab count, `InboxChip`, the Inbox page (`Inbox.tsx:101-103`); `stale-draft` excluded by `decisions()` |
| **Inbox · urgent** (colour only) | `decisions(…).some(i => i.kind === 'question' \|\| i.kind === 'attention')` | `TabBar`'s `urgent` (`Layout.tsx:1068`) |
| **Queue** | `tasks.filter(t => t.status === 'queued' && inScope(t))` | the Queue page's two lists together: `customQueueWaiting(tasks)` (`queued && customQueueAt`) + global (`queued && !customQueueAt`), both `.filter(inScope)` (`Queue.tsx:31-42`). Held (`queueHeldAt`) and hidden rows are included because the page lists them |
| **Features** | `features.filter(f => inScopeRepo(f.repoId) && !['draft','done','failed','cancelled'].includes(f.status))` | features in flight: `analyzing`, `proposed`, `approved`, `running`, `paused`, `review`. A `proposed` plan is also an Inbox item: Inbox means "waits on you", the nav means "exists and moving" |

Statuses are the shared unions: `TaskStatus` (`shared/src/types.ts:3-22`),
`FeatureStatus` (`:2269-2279`).

### Proposed extras (need the owner's sign-off; not built unless approved)

| Counter | Predicate | Note |
|---|---|---|
| **Jobs · running** | `jobs.filter(j => j.status === 'running' && inScopeRepo(j.repoId))` | `JobStatus` (`shared/src/jobs.ts:8`) |
| **Jobs · needs you** (colour) | `jobRuns.filter(r => inScopeRepo(jobOf(r).repoId))` — the store keeps only open runs (attention/error, unacknowledged) | duplicates the Inbox `job` kind; colour only, like Inbox urgent |
| **Inbox · urgent as its own number** | the `urgent` predicate above, counted | instead of colour only: "7 · 1!" |
| **Chat · unread** (dot) | `chats.filter(c => !c.officeId && !c.plannerWorkspaceId && inScopeRepo(c.repoId) && c.lastMessageAt && c.lastMessageAt > lastRead(c.id))` | per-device read model, § 13. Office chats are not in the store (fetched per office), so they cannot count here |
| **Office · pending proposals** | `officeProposals.filter(p => p.status === 'pending')` scoped by the office's workspace | duplicates Inbox `office-proposal` |
| **Terminals · live** | `shells.filter(s => s.status === 'running' && inScopeRepo(s.repoId))` | `ShellSessionStatus` |

## 13. Messenger chat anatomy

One messenger layout serves the repo **Chat** page (`pages/Chat.tsx`) and the
office **group chat** (`OfficeChat.tsx`). The office **Huddles** transcript
(`OfficeHuddles.tsx`) and the **Channel** (`OfficeChannel.tsx`) render their
entries as bubbles in the same thread, with the differences listed below. It
is specified for all three designs. Behaviour (who answers, taint,
read-only, Send to channel, Stop) does not change.

```
 desktop ── conversation list ──┬──────────── thread ─────────────────────────────┐
 │ Chats              [+ New]   │ ‹ Group chat   (BK)(QA)(UX)      ⋯             │
 │ ┌───────────────────────────┐│                                                │
 │ │(BK) Group chat      10:42 ││              ── Today ──                       │
 │ │     QA: Repro steps a… ●2 ││ (BK) Boss Kit · Director                       │
 │ └───────────────────────────┘│      ╭──────────────────────────╮              │
 │ (QA) Channel · 3 unrouted    │      │ Stand-up is in. Two red  │              │
 │      You: Can someone…  9:10 │      │ checks on nest.          │              │
 │ (UX)(QA) Huddle: sheet blur  │      ├──────────────────────────┤              │
 │      turn 2/4          08:55 │      │ ┌ task ────────────────┐ │              │
 │ (nest) Repo chat: nest       │      │ │ Fix flaky queue test │ │              │
 │      claude: Done. The…  Mon │      │ │ ● failed · nest      │ │              │
 │                              │      │ └──────────────────────┘ │ 10:41        │
 │                              │      ╰──────────────────────────╯              │
 │                              │                 ╭─────────────────────────╮    │
 │                              │                 │ @qa can you reproduce?  │    │
 │                              │                 ╰─────────────────────────╯    │
 │                              │                                10:42 ✓ seen    │
 │                              │ (QA) QA is answering…  ● ● ●                   │
 │                              │                        [ 2 new ↓ ]             │
 │                              │ ┌────────────────────────────────────┐ (➤)     │
 │                              │ │ Message… @mention a role           │         │
 │                              │ └────────────────────────────────────┘         │
 └──────────────────────────────┴────────────────────────────────────────────────┘
```

- **Conversation list row.** Avatar (a role's initials in its group hue, a
  stack of up to 3 for a group or a huddle, the repo's initial for a repo
  chat), title (one line, ellipsis), a preview of the last message (one line,
  "Sender: text", `--tm-text-muted`), the time (today hh:mm, else weekday, else
  `7 Nov`), and the unread mark: a count when the transcript is loaded, a dot
  when it is not. The active row takes the nav's active treatment. The list
  is sorted by `lastMessageAt` desc. The Channel shows "· N unrouted" in its
  preview line, and a huddle shows "turn n/max".
- **Thread bubbles.** **Own (stakeholder/human) messages on the right**,
  everyone else on the left: roles, claude and the server.
  - max-width 72 % (86 % on a phone);
  - padding `space-2`/`space-3`, radius `--tm-radius-lg`;
  - the corner on the sender's side tightens to `--tm-radius-sm` on joined
    bubbles;
  - the body is `Reply` (`Chat.tsx:24-43`): text and fenced code, never
    markdown, never `innerHTML`;
  - a role reply keeps its `tainted` chip (`.chip.office-taint`) in the
    bubble's meta line, and the bubble gets a 1px dashed `--tm-status-review`
    rim (the taint banner's colour);
  - a server line (huddle `server` entries, "waiting for the Director's routing
    pass…") is a centred, bubble-less muted line;
  - errors keep `⚠ error` in `.warn-text` under the bubble.
- **Sender grouping window.** Consecutive messages from the same sender
  (same `actor`, and for office chats the same `roleId`) **within 5 minutes**
  form one group. Name and avatar appear once at the top-left of the group
  (left side only), and the timestamp appears once, under the last bubble.
  Bubbles in a group are 2px apart; groups are `space-3` apart. A day
  separator always ends a group.
- **Day separators.** A centred pill (`--tm-text-xs`, muted, on
  `--tm-bg-overlay`) before the first message of each local day: "Today",
  "Yesterday", the weekday within the last 6 days, else "7 Nov 2026".
- **Timestamps.** `hh:mm`, local, `--tm-text-xs`, muted, under the group's
  last bubble. Turn cost and duration (`Ns · $x`, today's meta) follow it on
  role/claude groups. The full date-time is the `title` and part of the
  bubble's accessible text.
- **Composer.** Docked at the bottom of the thread:
  - an auto-growing textarea (1–6 lines) and a round send button; the button
    is `--tm-ember` under Magma and the accent fill in Glass/Classic;
  - Enter sends on desktop and Shift+Enter is a newline; on a phone Return
    is a newline and the button sends;
  - while a turn runs, the send button becomes Stop ("Stop this turn") as
    today;
  - the @mention listbox and the "answers: …" target hint (`OfficeChat.tsx`
    `Composer`) sit directly above the field;
  - the Channel's composer keeps To/Kind/Subject as a compact row of selects
    above the textarea instead of a form;
  - huddles have no composer: they are read-only.
- **Jump-to-latest pill.** It appears when the thread is scrolled more than
  one viewport above the bottom. It is centred above the composer and reads
  "↓" or "N new ↓" when messages arrived while away. A tap scrolls to the end,
  smoothly (instantly under Reduce Motion). **Auto-scroll happens only when the
  reader was already at the bottom.** Today `endRef` scrolls on every message,
  which yanks a reader who scrolled up.
- **Working indicator.** While `chat.status === 'thinking'`, a left-side row
  shows the answering role's avatar and "QA is answering…" (or "claude is
  thinking…") with **three static dots**. They are deliberately not animated
  (§ 8), and they are not in the calm lists because they never move.
- **Task-link card.** A compact card inside the bubble: title (one line),
  `StatusBadge`, repo chip and progress when live. Clicking it opens the task
  panel (`openTaskFromAnywhere`). It is built only from **server-known
  references**, never by parsing HTML:
  - a channel message's `routedTaskId`;
  - a route line's task;
  - a full task id or `?task=<uuid>` link in the text that resolves in the
    `tasks` store;
  - an 8-hex short id that resolves to exactly one task (no match or an
    ambiguous one stays plain text).

  A tainted message's card shows the task's own row data only, never text
  from the message.
- **Unread model (per device).** `localStorage['tm.chat.read']` =
  `{ [chatId]: ISO of the newest message seen }`, the same per-device pattern
  as `tm.design`.
  - A message is unread when its `createdAt` is later than that and its
    `actor` is not `human`.
  - "Seen" is written when the thread is mounted, the document is visible and
    the reader is at the bottom.
  - Cross-tab: the `storage` event updates the counts.
  - Nothing goes to the server, so the phone and the desktop keep separate
    read states. That is accepted, since unread is a nudge, not a record.
- **Phone: push navigation.** The list is the first screen. A tap **pushes**
  the thread with a back chevron "‹ Chats", the title and the avatars. The
  repo chat keeps its routes (`/chat` → `/chat/:id`, browser back works).
  Office chat lives inside its tall `<Sheet>`, so the push happens inside the
  sheet (a stacked view with its own back control and the sheet's scroller
  kept single). **The composer sits above the keyboard.** The thread height
  follows `visualViewport` (`--tm-chat-h`, already measured in
  `Chat.tsx:145-184`), the composer is the last flex child, not
  `position: fixed`, and it pays `env(safe-area-inset-bottom)` only while the
  keyboard is closed.

```
 phone (390)                     phone, keyboard open
 ┌──────────────────────────┐    ┌──────────────────────────┐
 │ ‹ Chats  Group chat (BK)(QA)  │ ‹ Chats  Group chat       │
 │        ── Today ──       │    │ (BK) ╭────────────────╮   │
 │ (BK) Boss Kit · Director │    │      │ Stand-up is in.│   │
 │  ╭──────────────────╮    │    │      ╰────────────────╯   │
 │  │ Stand-up is in.  │    │    │           ╭───────────╮   │
 │  ╰──────────────────╯    │    │           │ @qa repro?│   │
 │          ╭────────────╮  │    │           ╰───────────╯   │
 │          │ @qa repro? │  │    │ ┌──────────────────┐ (➤)  │
 │          ╰────────────╯  │    │ │ Message…         │      │
 │       [ 2 new ↓ ]        │    │ └──────────────────┘      │
 │ ┌───────────────────┐(➤) │    ├──────────────────────────┤
 │ │ Message…          │    │    │  q w e r t y u i o p     │
 │ └───────────────────┘    │    │   a s d f g h j k l      │
 │ ▔▔▔▔ home indicator ▔▔▔▔ │    │  ⇧ z x c v b n m ⌫       │
 └──────────────────────────┘    └──────────────────────────┘
```

### In each design

| Part | Classic | Glass | Magma |
|---|---|---|---|
| Own bubble | `--tm-accent-subtle` fill, 1px `--tm-accent` border, `--tm-radius-md` | accent tint fill, `--tm-text`, `--tm-radius-lg` | `--tm-accent-subtle` fill + 1px `rgba(255,122,46,.35)` rim, `--tm-text` |
| Role/claude bubble | `--tm-bg-raised` + 1px `--tm-border` | `--tm-glass-card` (no blur: cards never blur) | `--tm-bg-overlay`, no border; avatar ring in the role's group hue |
| Meta and timestamps | mono, `--tm-text-muted` | body face, muted | body face, muted |
| Day pill | `--tm-bg-overlay` square-ish | capsule on `--tm-glass-btn` | capsule on `--tm-bg-overlay` |
| Composer | `--tm-bg-inset` field, border-strong | capsule field on `--tm-glass-bar` with blur (it floats over the thread) | as Glass, with Magma materials; focused field gets the ember glow (one of the four) |
| Jump pill | accent text on raised | glass capsule | `--tm-glass-thick` capsule, accent text, rim |
| Task card | `--tm-bg-inset` + border | `--tm-glass-btn` | `--tm-bg-raised` + 1px `--tm-border` |
| Working dots | muted, static | muted, static | `--tm-accent`, static |

## 14. Screen-by-screen checklist

Every row is checked in Magma at **desktop 1440×900** and **phone 390×844**
(Home Screen standalone where noted), against the tokens of § 4 and the
pairs of § 5. Every row is also re-checked in Glass and Classic for "unchanged"
(the phase-2 computed-style snapshot covers the automatic half).

| Screen | Desktop | Phone |
|---|---|---|
| Shell | sidebar groups + counters + active glow; brand lockup + hairline; floating header capsules; `.edge-top` under scrolled content; wallpaper + sparks behind everything, never over text | tab bar lens + ember disc (solid + glow while on Board); `.tab-count` legible (urgent label); More sheet tiles grouped; top bar mark; safe areas |
| Board: Original (frozen) | sections, rows, badges (every status), group tints, progress bar, search Spotlight, bulk bar, drag ghost | rows full/essentials, search sheet, New-task sheet |
| Board: Stacks / Swimlanes / Relation map / Metro | section rails, lane headers, edge colours (dispatch, filed-by), metro lines on black, focus card | Stacks list, swimlane snap columns, relation list → sheet, metro timetable |
| Task panel (all five tabs) | floating pane, alerts, question block, Diff colours (§ 4), History steps, Terminal tab xterm theme | tall sheet, phone action bar + ⋯ |
| Sheets and overlays | QuestionModal alert, Palette (⌘K), popovers, toasts, offline banner, memory-fuse banner, push-health banner | every `<Sheet>` (content-height floats, tall cards), grabber, exit ghosts, Reduce Transparency solid |
| Office | place view in all four skins (skin tokens unchanged), list view, role editor, scorecard, metrics sparklines, Kill switch banner, autonomy chip, briefs viewer | phone bar of sheet buttons; each of the 12 sheets; group chat push nav inside the sheet; channel; huddles |
| Features | list, feature page phases, plan cards, TAINTED banner, two-press queue | stacked tables |
| Jobs | list, verdict chips (ok/attention/error/failed), report viewer, `BoardJobs` strip | stacked |
| Queue | custom + global lists, held rows, runs table, kind badges | `.stack-tbl` blocks |
| Inbox | every item kind, chips, Review deck card, Draft triage groups | `InboxSheet` stack |
| Config | Appearance (Design: Magma; scheme control disabled + hint), every settings version (Original, mix, A–E), save bar, switches, `.seg` | phone settings pages, sticky Save bar |
| Terminals | `ShellPane` tabs: Magma xterm theme, ANSI colours (`ls --color`, `git diff`, the claude CLI), selection, cursor; Agent shells view | drawer key row |
| Timeline | tracks, segment colours (`--tm-tl-checks`, `--tm-tl-fixing`), NOW line, ghosts, drag grip, scrub | phone stream, time cursor |
| Dashboard | tiles, charts (`--tm-chart-*`), MemoryCard, usage pill | stacked tiles |
| Chat | messenger (§ 13): list, thread, grouping, day pills, jump pill, task card, composer, mode note (write mode warning in `--tm-status-failed`) | push nav, composer above the keyboard, back gesture |
| Reports | list, document preview, language chips | stacked |
| Shared | spaces, ledger rows, request/note chips | stacked |
| Repos | table, Landing/Office cells, push-health colours, confirm dialogs | `.stack-tbl` |
| Handbook | prose, links (`--tm-link`), code blocks | prose width |
| Emulator (desktop only) | floating phone frame over the board | — |

## 15. Open questions for the owner

1. **Default design.** Does Magma become the default for an unset device
   (`tm.design` unset → today Glass)? Proposed: **no, not in this feature**.
   Magma ships as an opt-in. Making it the default is a one-line change in
   `resolve()` and the `index.html` twin, best taken after a week on the
   owner's phone.
2. **Rename scope.** Visible brand only (the sidebar wordmark, `<title>`, the
   manifest `name`/`short_name`, the Home Screen label, the Telegram/HTML
   report headers) or also the repo, the package names (`shared`/`server`/`web`
   workspaces), the CLI scripts and the internal `tm_` prefixes? Proposed:
   **visible brand only**. `tm_` table prefixes, `TM_*` env vars,
   `localStorage` `tm.*` keys and `--tm-*` tokens are interfaces, and renaming
   them breaks stored state and every worker prompt for no user-visible gain.
3. **Light Magma.** Ship one? Proposed: **no** (§ 2). A light warm design
   would be its own design with its own name.
4. **Phone menus under Magma.** Hide Features and Chat from the phone's More
   sheet like Glass (`GLASS_HIDDEN`)? Proposed: **show them** (§ 3). This
   feature makes Chat a messenger and Features gets a counter.
5. **TM Bar bundle.** Rename `TM Bar.app` / `CFBundleName` (`scripts/menubar.mjs`:
   `APP_NAME = 'TM Bar'`, bundle id `com.taskmanager.bar`) to "Gor Bar"?
   Proposed: rename the **display name** only and **keep the bundle id**. A
   new bundle id is a new app to macOS: login-item registration
   (`SMAppService.mainApp`), notification permission and the Keychain
   all start over.
6. **Dominant colour.** Orange (proposed, Direction A) or red (Direction B)?
   See § 1 and the mockups.
7. **Extra counters.** Which of § 12's proposed extras to build: Jobs running,
   Jobs needs-you, Inbox urgent as a number, Chat unread, Office proposals,
   Terminals live?
