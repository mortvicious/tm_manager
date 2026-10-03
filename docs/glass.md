# Glass: the iOS Liquid Glass design

The SPA has two designs. **Classic** is the original terminal look. **Glass**
re-skins the same components in the iOS 26 Liquid Glass language (translucent
materials, floating controls, springs) and follows Apple's HIG on a phone. The
app is used mostly as a Home Screen web app over the tailnet, so Glass aims to
read as a native iPhone app first and a desktop page second. It is a restyle,
not a rebuild: the tree, the routes and every behaviour are Classic's.

User request (2026-10-03): "redo UI to glassmorphism, imitate iOS effects, Apple
UI/UX rules, especially on mobile… hide features, chat… transitions, animations,
on-tap animations". Answers to the questions it raised: Liquid Glass (not the
older frosted iOS 15–18 look); keep the light/dark control and follow the
system initially; the Classic/Glass choice is per device; Features and Chat
are hidden in Glass only.

## Choosing it: per device

Config → **Appearance** (the first panel, and shown even while the API is down,
since it needs nothing from the server):

- **Design**: Glass | Classic. Stored as `localStorage['tm.design']`, default
  **glass**.
- **Light or dark**: System | Light | Dark. Stored as `localStorage['tm.theme']`,
  the key the old theme toggle already used. **Unset means follow the system**,
  live, via `prefers-color-scheme`. That is a change for Classic too: an unset
  device used to mean dark. The header's sun/moon button still flips what is on
  screen and pins it. "System" in Config is the way back.

Both are per device and never go to `tm_config`, so the phone can run Glass
while the desktop stays Classic. They apply as clicked, outside the page's Save,
the same way Notifications works. `src/appearance.ts` owns them and sets
`html[data-design]` and `html[data-theme]`. `index.html` carries an inline twin
that runs before the first paint, so a reload never flashes the other look.
Keep the keys, defaults and attribute names of the two in step. A design or
scheme change cross-fades the page through the View Transitions API (Safari
18+) whenever Glass is on either side of it, and is instant under Reduce
Motion. A Classic-only light/dark flip stays as it was. A pick that storage
refuses (blocked, full) still applies for the life of the tab.

## What Glass changes

**Tokens** (`web/src/theme.css`, the "design: Glass" blocks after the light
block; mirrored in `docs/tm-design-tokens.html`):

- The semantic layer is remapped for both schemes to Apple's system palette.
  Dark uses the plain dark variants. Light uses the **increased-contrast**
  variants wherever a hue is text, because plain systemGreen on white is about
  2.2:1.
- Accent is system blue. Running is mint (the closest system hue to Classic's
  teal).
- SF via `-apple-system` (`ui-monospace`/SF Mono for code), larger radii, and
  springs (`--tm-ease-spring`, `--tm-ease-smooth`). The springs are sampled
  from a damped spring into CSS `linear()`, with cubic fallbacks.
- New material tokens: `--tm-glass-card|bar|thick|btn|lens|rim|specular|shadow`,
  `--tm-wallpaper`, `--tm-scrim`, `--tm-edge-tint`, the switch and segment
  colours, blur radii, and press and duration values.

**Rules** (`web/src/glass.css`, imported after `theme.css`): every rule is
scoped to `[data-design='glass']`, so Classic renders exactly as before. The
exceptions are inert in Classic: the two "hidden unless Glass" rules
(`.edge-top`, `.glass-only`), the `.tm-exit` ghost rules (ghosts only exist in
Glass), and the `::view-transition` duration.
- It has no colours of its own. Component sizes are literals, as in
  `theme.css`.
- The phone type scale, the tab label size and the floating tab bar's geometry
  (`--tm-tabbar-float`/`--tm-tabbar-clear`) are tokens in theme.css's Glass
  section.
- Generic base rules use `:where([data-design='glass'])` to stay at Classic's
  own specificity. Classic's state and context rules then still win:
  - the picked states: `.preset-btn.on`, `.pick-btn.on`, `.task-row .quick.queued`
  - the terminal chrome's greys
  - the edge cases: `:last-child` separators, the dispatch-strip join, a
    group-tinted section count, and a drop target's fill under a sticky
    `:hover`

- **Shell.** A fixed soft-gradient wallpaper replaces the dot grid.
  - The top bar is transparent and floats over the page (header and `.main`
    share one grid cell). The page scrolls under it.
  - Under the bar sits `.edge-top`, iOS 26's scroll-edge effect: a masked blur
    that is invisible over the wallpaper and appears only once content slides
    beneath it.
  - Header controls are glass capsules.
  - On desktop the sidebar is an inset glass pane.
- **Tab bar (phone).** A floating capsule over the home-indicator inset, with a
  glass **lens** that slides under the active tab on a spring and swells while
  pressed.
  - `TabBar` writes `--tab-i`/`--tab-n`. Any page reached from the More sheet
    puts the lens on More, which gets the `here` class.
  - `--tm-tabbar-clear` grows to the floating geometry, so the page padding and
    the terminal drawer still clear it.
- **Lists.** Board sections are inset-grouped glass cards with hairline (0.5px)
  separators.
  - Section titles are bold, in the case given. The built-in labels are
    written "Active", "Drafts" and "Recent" (Classic uppercases them anyway);
    repo, category and group names are left as they are. On a phone the
    titles scroll away with their list, as iOS inset-grouped headers do; in
    Classic they stick.
  - Rows highlight under a finger. The highlight waits 60ms, as a scroll view
    does, so starting a scroll on a row doesn't flash it.
- **Controls.**
  - Buttons are capsules (prominent = filled tint, the rest translucent glass),
    with `:hover` twins so a phone never keeps a tapped button lit.
  - Badges and chips are tinted with their own `currentColor`, so tag chips
    keep their hue without a rule per hue.
  - The iOS switch is 51×31, and its knob stretches while held. `.seg` is a
    segmented control with a raised thumb.
  - Selects draw their chevron from two `currentColor` gradient triangles,
    because WebKit ignores radius on a native select.
- **Type.** On a phone the base is 15pt and titles are 34pt large titles. The
  phone Board gets a title (`.page-title.glass-only` in `Board.tsx`), which
  Classic hides.
- **Overlays.**
  - The More sheet floats inside the screen's corners, with a grabber and
    Control Center tiles for the nav.
  - The top bar lets clicks, the wheel and `.main`'s scrollbar through its
    gaps (`pointer-events`), because it spans the page's top edge.
  - The task panel is a floating pane on desktop and a card sheet on a phone
    (8px below the status bar, dimmed page behind).
  - The question modal is an alert that pops in from slightly too big.
    Popovers grow out of their button.
  - The terminal drawer rises like a sheet.
- **Header fit.** A phone bar holds four capsules at most. While the question
  chip is up, the orchestrator switch keeps its knob and moves its label off
  screen. The label stays its accessible name.

**Hidden in Glass**: Features and Chat leave the sidebar, the tab bar and the
More sheet (`GLASS_HIDDEN` in `Layout.tsx`), so the phone has Dashboard ·
Board · Queue · More. The **routes stay**: push deep links (`/features/:id`,
`/chat/:id`, built in `server/src/push/notifier.ts`) and the Queue's aux-run
links still open them. Classic keeps today's navigation.

## Motion

Pages rise into place, and list rows cascade in while a section is entering.
Layout sets `.main[data-entering]` for 900ms per section change, and the
cascade keys off it. It is not always on: a keyed reorder MOVES rows with
`insertBefore`, which restarts their CSS animations, so an always-on cascade
blinked the board on every "last touched" update. Under Reduce Motion nothing
rises or staggers at all; the global rule collapses durations but not
delays.
- A press shrinks a button on a fast ease-out, and the release springs back.
  CSS uses the destination state's transition, so `:active` carries the press
  curve and the base rule carries the spring.
- The tab lens, the switch knob and the section carets ride the spring.
- Sheets, the task panel and the question modal animate both in and out.

**Exit animations** are the one non-obvious part. Every overlay is mounted
conditionally by its parent (`{open && <Sheet/>}`), so it can't delay its own
unmount. `exitGhost` (`src/motion.ts`) is a module-level ref callback whose
React 19 cleanup runs before React removes the DOM:
- It clones the node inside the cleanup, before passive-effect cleanups can
  strip its DOM (an xterm dispose).
- It inserts the clone in place, tags it `tm-exit`, and copies scroll offsets
  (cloneNode keeps field values but not scroll).
- It removes the clone when its animations finish. A 900ms backstop is armed
  before anything that could throw.
- The clone is inert, `aria-hidden`, has every `id` stripped (so
  `getElementById` never finds a ghost), and takes no taps.
- A microtask checks that the node really left, so StrictMode's dev
  double-invoke never ghosts.
- `.tm-exit *` switches off every other animation, so nothing replays inside a
  ghost.
- Used by `Sheet`, `FullSheet`, `TaskSlideOver` and `QuestionModal`. The
  terminal drawer has no exit, since its canvas would come out blank.

Reduce Motion: the global rule in `theme.css` already collapses every duration,
and `exitGhost` doesn't ghost at all. Reduce Transparency (where the browser
reports it) turns every material solid and every blur off, and so does a
browser with no `backdrop-filter`. Both are token overrides in `theme.css`.
Small fills (buttons, the tab lens) and the dimming scrim stay translucent; on
a solid surface they read as tints.

## Materials: where a blur may go

`backdrop-filter`, like `filter` and `transform`, makes an element the
containing block of its `position: fixed` children. That gives four rules:

- **No blur, filter or transform on `.main`.** It holds the slide-over, the
  terminal drawer, the question modal and the drag ghost. The page-enter
  animation is on `.main > :first-child` with `animation-fill-mode: backwards`,
  never `both`, so no transform outlives it.
- **Nor on `.header`** (it holds the desktop emulator) **or `.app`** (the sheet
  portal host). The header paints over the page using grid-item z-index (26,
  above the drawer's 25, as the emulator was before), which creates no
  containing block.
- **`.more-sheet` is blurred only while it holds no `.cmd-pop`**
  (`:not(:has(.cmd-pop))`). The phone's commands popover is fixed inside it.
- **Cards don't blur.** Nothing is behind them but the wallpaper, and a blur of
  a soft gradient is that gradient. Only things that float over content get one
  (bars, the tab bar, sheets, the panel, the modal, popovers, the phone's sticky
  Save bar), which keeps scrolling cheap on a phone.

## Limits

- **Status bar.** `index.html` sets no `apple-mobile-web-app-status-bar-style`,
  so the Home Screen app starts below an opaque system status bar, which
  follows the system appearance. A translucent bar would put white status text
  over light Glass, so it was left alone. Every top surface already pays
  `env(safe-area-inset-top)`, in case it changes.
- **Terminals stay dark** in both schemes. xterm needs concrete colours.
- **Headless WebKit does not paint `backdrop-filter`.** In Playwright's WebKit
  the materials look like their bare tint, and only Chromium at 1× scale shows
  the blur. Judge blur on the phone itself.

## Verification (2026-10-03)

- `npm run typecheck` and a scratch `vite build` (outDir outside `web/dist`,
  which the live front door serves).
- Playwright **WebKit** at 393×852 and 375 (iPhone UA, touch) for SF type and
  layout, and Chromium at 1280×800 for the blur.
- Checked in both schemes:
  - Board, Dashboard, Queue and Config.
  - The More sheet (no Features/Chat entries in Glass), the task panel on phone
    and desktop, and the header with a question chip at 375px (no overflow).
- **Classic** was compared against screenshots taken before the change (same
  layout, and Features is back in the tabs).
- **Exit ghosts:** present with their exit animation right after a close, gone
  within 900ms, for both the More sheet and the task panel.
- Terminal WebSocket frames were dropped in the harness, so no live PTY was
  resized or typed into.
- An adversarial review round (static, against react-dom 19.2.8) found 1 major
  and 8 minor issues, all fixed.
  - The major one: Glass light gave the terminal chrome's ghost buttons dark
    labels on dark (1.4:1). It was fixed by the `:where()` base rules plus a
    terminal-chrome rule.
  - The minor ones: the reorder blink, picks lost when storage fails, the
    header covering the scrollbar, separators overriding Classic's removals,
    lost state cues, radio roles, phone segments, and select padding.
