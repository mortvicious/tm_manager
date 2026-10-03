# Mobile

The board is usable from a phone: a mobile-first shell over the same routes and
the same components, plus an **opt-in** LAN bind so the phone can reach the
server at all. No behaviour changed — this is a second arrangement of the app,
not a second app.

## How to open it on a phone

Both halves of the app bind loopback by default. LAN mode is one switch.

**Production — the front door serves the page, the API sits behind it:**

```bash
npm run build       # REQUIRED: start:lan serves web/dist, it does not build it
npm run start:lan   # front door on :5176 (dual-stack) → API on :5175
```

**Development — and the phone wants the Vite port:**

```bash
npm run dev:lan     # front door + its API child (:5175) + vite (:5173)
```

Open **:5173** from the phone in dev, **:5176** in production — the front door,
not the API (`docs/host.md`). Stop any server already holding :5175 or :5176
first: a second one exits with `EADDRINUSE` and the old (loopback-only) process
stays up, which looks like the flag did nothing. The front door will *adopt* an
API that is already listening rather than fight it for the port, so a stale
loopback-only API is the case to watch for — it is the one that keeps refusing
the phone while the front door itself is perfectly reachable.

Both are `TM_LAN=1` in front of the normal script. The equivalent without the
environment variable is `"lan": { "enabled": true }` in `server/data/config.json`
— the env var can only turn LAN mode **on**, never off, so a config file that
asks for it wins.

LAN mode listens on `::`, not `0.0.0.0`. `0.0.0.0` is IPv4-only and `localhost`
resolves to `::1` first on macOS, so a browser that does not fall back would get
a refused connection on a server that is plainly running; `::` is dual-stack, and
where IPv6 is switched off entirely the bind throws and the code falls back to
`0.0.0.0`. Verified: `127.0.0.1`, `localhost`, `[::1]`, the LAN IPv4 and the
`.local` name all answer 200 on the same process.

On boot both processes print every private address they answer on — the front
door's is the one to type into the phone:

```
task-manager front door on http://127.0.0.1:5176  → API 127.0.0.1:5175
  LAN: http://192.168.0.8:5176  ⚠ anyone on this network can run commands here
task-manager listening on http://127.0.0.1:5175 (storage: sqlite)
  LAN: http://192.168.0.8:5175  ⚠ anyone on this network can run commands here
```

`http://<that address>:5176` from the phone, or the Bonjour name
(`http://faigs-macbook-air.local:5176`) which survives a DHCP lease change. In
dev the phone wants the **Vite** port (5173); in production it wants the front
door (5176), which serves the SPA and proxies the API. Add to Home Screen works —
`site.webmanifest` is already `display: standalone`. Push notifications need the
Home Screen app over HTTPS (the tailnet), not LAN http: `docs/push.md`.

### Why it is opt-in, and what it costs

The standing rule is that the server binds 127.0.0.1 only, because the terminal
WebSocket is a code-execution surface and `GET /api/session` hands the per-boot
token to anyone who can reach it. LAN mode does not weaken any check; it widens
exactly two allowlists, and only while it is on:

| | default | `TM_LAN=1` |
|---|---|---|
| bind host | `127.0.0.1` | `0.0.0.0` |
| `Host` header | loopback only | loopback **+ private** (`server/src/net.ts`) |
| `Origin` (non-GET, and every WS upgrade) | loopback only | loopback + private |
| WS token | required | required (unchanged) |

"Private" is RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local
(`169.254/16`), loopback, and `*.local`. A routable host or origin is refused in
both modes, so the DNS-rebinding guard still holds: a hostile page that
re-resolves to your LAN address arrives with its own `Origin` and gets a 403.

**On a shared or untrusted network, leave it off.** Anyone who can reach the
port gets a terminal in your repos.

`changeOrigin` on the Vite proxy is not enough on its own — it rewrites `Host`,
not `Origin`, so a phone's POSTs and WS upgrades still arrive with the LAN
origin. That is why the server needs `TM_LAN` too, not just Vite.

## The shell

`useIsMobile()` in `components/Layout.tsx` reads one media query,
`(max-width: 768px)`, and the tree is built once for one shape. The CSS keys off
the `.app.mobile` class that hook sets rather than repeating the query, so the
styles can never disagree with the tree they are styling. A header control
cannot be in two parents at once without being **mounted** twice — two emulator
windows, two usage pollers — which is why this is a JS branch and not a
display:none pair.

- **Bottom tab bar** (`.tabbar`) — Dashboard · Board · Queue · Features · More.
  The active tab carries three cues, not one: accent colour, `stroke-width: 2.6`
  and a top rail, because colour alone is weak in peripheral vision. In the
  **Glass** design (`docs/glass.md`, picked per device in Config → Appearance)
  it is a floating capsule with a sliding lens instead of the rail, and it reads
  Dashboard · Board · Queue · More: Glass leaves Features and Chat out of every
  menu, and their routes stay reachable by link.
- **More sheet** (`.more-sheet`, drawn by the shared `<Sheet>` — § Sheets) — the
  **whole** nav (so the four slots are a shortcut, never the only route) plus the
  header controls the compact top bar could not hold: usage pill, server
  uptime/restart, repo commands, theme, and the address the page was served
  from. Escape and the overlay close it; it also closes on navigation and on
  crossing the breakpoint.
- **Top bar** — brand (hidden under 430px), queue switch, `running n/m`, and the
  `⋯` that toggles the sheet.
- **The emulator is not mounted on mobile.** A phone framing a phone is noise,
  and it was the one control that could not usefully shrink.

### Tokens

Three new entries in the `:root` app-layout block:

```css
--tm-tabbar-h: 56px;
--tm-tabbar-clear: 0px;   /* .app.mobile raises it to h + safe-area-inset-bottom */
--tm-tap: 44px;  --tm-tap-dense: 38px;
--tm-text-input: 1rem;    /* iOS zooms a focused field under 16px and never zooms back */
```

`--tm-tabbar-clear` is the whole mechanism: `.main`'s bottom padding and
`.term-drawer`'s `bottom` read it **unconditionally**, and it is `0px` on
desktop, so one token move relocates everything that has to sit above the bar.
`.app.mobile` also sets `--tm-sidebar-w: 0px`, which repairs `.term-drawer`'s
`left` and `.cmd-pop`'s `max-width` for free — they were already written against
that token.

The mobile type scale is a step down of the same tokens (`--tm-text-xl` and up),
not a new set of sizes.

### Patterns

- **Tables stack.** Queue, Features and Repos carry `.stack-tbl` and a
  `data-label` per cell; on mobile the rows become blocks and each cell prints
  its lost column header above itself. The alternative — a horizontal scroller —
  puts the actions column off-screen, which is where Remove and Analyze live.
  The Handbook's markdown tables **do** scroll, because they cannot be
  re-authored; `white-space: nowrap` is what makes that work (a `display: block`
  table without it squeezes its columns to one character).
- **Config is label-over-control.** Every control on that page is sized by an
  inline `width`, so the override is `!important` on `.app.mobile .cfg-row .field`
  rather than ~30 edited call sites on a page this work does not otherwise touch.
- **Board rows are their own layout** (§ Board). Anything else that reuses
  `.task-row` (the task panel's file list) still wraps, with `.task-main` at
  `flex: 1 1 60%`. Child indent halves to 12px per level, marker included, or
  the `└` hangs off its own child.
- **The slide-over is a sheet**: full width, `top: 0`, and it owns the
  status-bar inset the header used to. Its layout is § Task panel.
- **Safe areas.** `viewport-fit=cover` in `index.html` makes
  `env(safe-area-inset-*)` non-zero; the header, `.main`, the tab bar, the sheet
  and the slide-over each pay their own side back, so landscape on a notched
  phone does not lose content under the cutout.

## When it does not load

The server prints what is wrong; read its output before anything else.

| Symptom | Cause | Fix |
|---|---|---|
| The old, loopback-only server is still up and the flag seems ignored | a second server cannot take :5175/:5176 — it exits `EADDRINUSE`, and a front door started over a live API adopts it rather than replacing it | stop the first one, then `npm run start:lan` |
| Plain-text *"the UI has not been built"* (503) | `web/dist` is absent — `npm start` serves it, it never builds it | `npm run build`, restart |
| `{"error":"forbidden host"}` (403) | the address you typed is not loopback and not private — e.g. `0.0.0.0:5175`, or a hostname that is not `*.local` | use a printed address: `127.0.0.1`, the LAN IPv4, or the `.local` name |
| Page loads, everything reads "offline", no live updates | the events WebSocket was refused — LAN mode off on the server while the page is served from a LAN origin | `TM_LAN=1` on **both** halves (`dev:lan` does this) |
| Loads on the laptop, refused on the phone | the phone is on a different network / SSID, or macOS firewall is blocking the process | same Wi-Fi; allow incoming connections for `node` |

Before this pass, a missing `web/dist` registered **no** static route and **no**
log line: `/` answered Fastify's default 404 JSON on a server that was otherwise
healthy. It now says so on boot and answers `/` with the two commands that fix it.

## Sheets

`components/Sheet.tsx` is the one bottom sheet. The More menu, the board's
filters, a row's actions and the task panel's overflow all use it, so Escape,
the overlay, the grip and the body scroll lock behave the same everywhere.

- **Portalled into `.app`, not `document.body`.** Every mobile rule is keyed off
  `.app.mobile`: field sizes, tap targets, fonts. A sheet out on `body` would
  lose all of them. The portal also escapes whatever declared it, so no
  transformed or clipping ancestor can trap the `position: fixed` box.
  `.sheet-root` is `display: contents`, so the wrapper never becomes a grid item
  of `.app`.
- **Clicks stop at the sheet.** React bubbles synthetic events up the COMPONENT
  tree even through a portal. A row's sheet is declared inside that row, and a
  tap on "Run now" would otherwise also open the task panel.
- **`SheetAction` prints its reason.** Each action is a 44px row with a label and
  a hint line. The hint is what a desktop keeps in a hover tooltip, and a phone
  cannot hover. It matters most for a disabled action, whose "why not?" used to
  exist only in that tooltip. Disabled dims the label and icon, never the hint.
- **`FullSheet`** is the whole-screen variant, with a header, a close button and
  its own scroller, for a form too long for a bottom sheet (New task). It sits at
  z-index 33: above the task panel (31) and the phone terminal (32), under the
  bottom sheets (35) and the question modal (40).

## Board

**Toolbar.** One line replaces the page title, the seven filter selects and the
New button: `[Filters · n] [sort ▾] [+ New]`. That was about 340px of screen,
40% of a phone, before the first task.

- **Filters** opens a sheet holding the same `filterSelects` fragment the desktop
  bar renders: repo, source, category, dispatches, task group, group-by. Below
  them are a `full | essentials` view toggle and Reset/Done. One fragment feeds
  both layouts, so a new filter cannot be added to one and forgotten in the
  other.
- **Sort** stays a native select in the toolbar. The OS picker is the dropdown.
- **What the sheet narrows stays on screen.** Every active filter, plus a
  non-default group-by, prints as a chip under the toolbar. Tapping a chip clears
  it, and the Filters button shows the count.
- **Filters persist** in `localStorage['tm.board']` with sort, focus and the
  folded set. This applies to desktop too. A home-screen app reloads often, and
  filters that are lost on reload were a desktop default nobody chose. A
  persisted value can outlive what it names: a deleted repo, a dissolved group,
  the last dispatch pruned. Such a value reads as `all` at render time
  (`filterRepo`/`filterCat`/`filterGroup`/`filterDispatch` in `BoardPage`)
  rather than silently emptying the board behind a hidden or blank select. The
  checks wait for data, because an empty list at boot means "not loaded yet".
- **New task** is a `FullSheet` holding the unchanged form. It no longer pushes
  every list down by a screen and a half. Closing it keeps what was typed.

**Rows** (`TaskRow`, `.task-row.m`: its own JSX branch, because the actions
differ, not only their layout). A 3×3 grid:

```
[grip] [title, up to 2 lines      ] [primary] [⋯]
[grip] [status] [tag] [tag] [+n]              [age]
[grip] [row error, when there is one               ]
```

- **One primary action, chosen by status.** Review → Publish; a startable task
  (draft/queued/failed/cancelled, no live session) → Run now; otherwise the
  terminal, if there is a session. When nothing applies there is no button. A
  disabled primary is never shown: its reason would sit in a tooltip.
- **`⋯` opens the row's sheet** with every row action: terminal, Publish (review),
  Run now, Mark done / Mark as ready, Add to / Remove from queue, and Open
  details. They use the same guards and the same wording as the desktop icons.
- **Two tags, then `+n`.** `rowChips` builds one list in the desktop order.
  Phones rank it `repo, dispatch, group, category, feature, auto-publish, agent,
  source, preset, reviewer` and keep two. Only chips that actually render go in
  the list (PresetChip and ReviewerChip draw nothing on some rows), so `+n` never
  counts a ghost. With the board filtered to one repo, the repo tag is dropped:
  it would repeat the filter on every row.
- **The meta line never wraps.** Tags shrink to an ellipsis before the badge or
  the age does, and the second tag gives way first (`flex-shrink: 4`), so the
  repo stays readable. The status badge is drawn first (`order: -1`) because it
  is what the eye looks for there.
- **Nesting** moves `--tm-depth` onto the row, so the meta line indents with its
  title.

**Section heads stick** to the top of `.main` while their list scrolls. Each
head is sticky inside its own Section wrapper, so the next section's head pushes
it off. This applies only to the board (`.board .section-head`): the task panel
and other pages put several heads in one parent, where they would pile up.

**Group heads are one line.** The name gets an ellipsis (it needs
`display: block`; the head's buttons are inline-flex), and the counts, `n of m`
and the pencil keep their place. The fold and pencil buttons are 34px. Rename
mode still wraps, for the swatches.

## Task panel

The desktop panel draws its actions as one wrapping row of up to 17 buttons,
with Delete and Cancel beside the safe ones, after roughly 800px of form. On a
phone:

- **A pinned header**: status · title · close, with the chips on a second line
  that scrolls sideways. The chip line is dropped when it would only say
  "manual".
- **A pinned action bar** under it holds up to three actions, then `⋯`. They come
  from ONE `PanelAction[]` list that the desktop row renders too, in the same
  order and with the same classes, so what a status offers cannot drift between
  the two. The bar picks by `mobilePrimary(live)`:
  `publish, complete, release, unblock, run-now, enqueue, terminal`. With a live
  session the terminal moves ahead of run-now/enqueue, which the server would
  refuse anyway. Disabled actions never go in the bar.
- **The `⋯` sheet** lists the rest: available first, then the refused ones with
  their reason. Destructive actions (Cancel, Remove from the global queue, which
  is a cancel, Stop agent, Delete) sit apart at the bottom, in red.
- **The live-session guard is mirrored.** Enqueue, Add to queue, Release and Run
  now are disabled while the task's PTY is up, with the same words as the board
  row, because the server's `hasLiveSession()` would 409 them. This applies to
  the desktop row too, where they used to be clickable into an error.
- **Reading order**, by CSS `order` on the body's flex column, so the JSX is
  shared: breadcrumb, alerts (error, wake-up, held), the agent's question, run
  stats, review, the worker's summary, follow-up. Then the title and
  description, the settings, and the rest in desktop order. What happened comes
  first, then your answer to it, then the task itself.
- **Settings fold away.** The settings grid (repo, category, group, preset,
  review, auto-publish, model, effort, reviewer) sits behind a toggle that shows
  `repo · model · effort`. The toggle is open for a draft, which is still being
  written, and closed otherwise.
- **Save is a sticky bottom bar** while there is something to save. It is last
  in the order, so it rests below everything. It carries a negative `bottom`
  because sticky insets count from inside the body's padding.

## The terminal

On a phone the drawer is the **whole screen** (`.term-drawer.full`, z-index 32,
over the tab bar and the header), laid out top to bottom:

```
[name] [live] [A−] [A+] [⌄] [✕]
[ xterm ................................ ]
[Ctrl Esc ⏎ ↑ ↓ 1 2 3 Tab ⇧Tab ^C ← → ⤓]
[ Message…                        ] [➤]
```

- **It fits what the keyboard leaves.** iOS does not resize the layout viewport
  for the soft keyboard; it covers it. The drawer tracks `visualViewport`
  (`--tm-vv-h`/`--tm-vv-top`, written on its `resize`/`scroll` and on window
  resize). The prompt and the compose bar therefore stay above the keys, and
  every change schedules a refit, so the PTY learns its new row count.
- **Refits are debounced, one per burst** (`scheduleRefit`, 60ms). The keyboard
  animates through a dozen heights, and each resize message is a SIGWINCH and a
  full TUI redraw. A `ResizeObserver` on the body covers everything else that
  changes its box. It uses a timer, not rAF, because rAF never fires in a hidden
  tab and the size must be right when the tab is shown.
- **The compose bar** is a real `<textarea>`, so autocorrect, dictation and paste
  work. None of them do in xterm's hidden textarea. Send puts the text through
  **`term.paste()`**, xterm's own paste path, so it arrives bracketed
  (`\x1b[200~…\x1b[201~`) whenever the app enabled bracketed paste, exactly like
  a desktop paste. Enter follows as its **own frame, 120ms later**. Sent back to
  back, the two frames can reach the TUI in one read, and `text\r` would then be
  parsed as a paste with a newline in it rather than a submit. An empty Send is
  a bare Enter. Enter in the field sends; a hardware Shift+Enter still breaks the
  line. Sending disarms a sticky Ctrl first: a message is not "the next key".
- **The key row moved under the terminal**, next to the thumb and the keyboard,
  and gained **Enter, 1/2/3, Shift+Tab (`\x1b[Z`, the mode cycle) and ^C**. With
  Enter and the digits, claude's pickers (permission prompts, numbered choices)
  are answered without opening the keyboard at all. A key needs no focus: it
  goes straight down the socket, and `holdFocus` leaves the keyboard as it was.
  Keys no longer focus xterm, which popped the keyboard open over the picker you
  meant to answer with one tap. Sticky Ctrl still focuses xterm (the key it
  modifies comes from the keyboard) unless the compose box has focus. ⤓ jumps
  to the live end of the scrollback.
- **Terminal scrolling** (`components/termTouchScroll.ts`). xterm 6 replaced
  its native-overflow viewport with VS Code's scrollable element, which listens
  to `wheel` only, so a finger dragged over the terminal scrolled nothing. A
  one-finger vertical drag now scrolls: in the normal buffer (claude's inline
  TUI, a shell) through `term.scrollLines`, sub-line remainders carried; in the
  alternate buffer (less, vim) through a synthetic line-mode `wheel` on
  `.xterm-screen`, which xterm reports to the app or turns into arrow keys, as a
  desktop wheel would. Nothing is prevented until the finger moves 8px, so a
  tap still focuses xterm and raises the keyboard; a drag cancels the page's own
  scroll and the tap that would follow it. A flick coasts and decays; a finger
  that stopped before lifting does not. Two fingers are left to the browser.
- **Text size**: A−/A+ from 8 to 16px (default 11, about 56 columns at 390px
  instead of 45 at the desktop's 12.5), remembered in
  `localStorage['tm.term.mobileFont']`. Desktop stays at 12.5 with no control.
- **Tapping "outside" does nothing on a phone.** The only outside is a sheet or
  the question modal drawn over the terminal, and answering one must not fold it
  away. The ⌄ button still compacts it to the bar above the tab bar. That bar
  now hides the compose box too, and it keeps its own height:
  `.app.mobile .term-drawer.compact { height: auto }` fixes the 58svh drawer
  height that used to win on specificity.

The sticky Ctrl itself is unchanged, and so is the single input path it rides:
`withCtrl`, cleared after one keypress mapped or not, and cleared on
compact/breakpoint/run change. The reasoning is in `docs/decisions.md`,
2026-08-27.

## Known limits

- A phone in **landscape** is ≥768px wide and therefore gets the desktop layout.
  That is legible (the sidebar fits 390px of height) but it is not designed for;
  a short-viewport pass is filed separately.
- The key row covers Ctrl, Esc, Enter, the arrows, 1/2/3, Tab, Shift+Tab and ^C.
  Ctrl-with-a-symbol, function keys and Alt still have no key.
- Reordering on a phone is still the drag grip, which does work on touch
  (pointer events). There is no "move up/down" action in the row sheet.
- The compose bar's Enter delay (120ms) is a timing assumption about the TUI's
  read loop, not a protocol guarantee. A very long paste that the CLI takes
  longer to ingest could still see the Enter arrive early.

## Verification

**Board rework (2026-09-29)**, run in a real browser against the live API through
Vite, with the app in same-origin iframes at 360, 390 and 430 CSS px:

- `npm run typecheck`; the SPA built with `vite build` (to a scratch outDir, so
  the live `web/dist` was not replaced before review).
- There is no horizontal overflow: `scrollWidth` equals the width for the
  document and for `.main` at all three widths, on Board and Queue, and inside
  the New task sheet.
- Toolbar, filter sheet, the chips (set a repo, then tap to clear) and the
  persisted `tm.board` JSON were all checked. The row sheet on a `review` row
  listed its six actions, with Run now and Add to queue disabled and the live
  session named as the reason.
- Task panel on a review task: the bar was Publish · Mark done · Terminal, and
  the sheet showed the available actions first, then the refused ones, then
  Stop agent and Delete apart. The body order was measured with `order`
  computed. The save bar sits flush at the bottom edge (bottom 780 of 780).
- The terminal was checked with `WebSocket.prototype.send` stubbed for
  `/ws/terminal/` sockets in the test frame, so no byte reached a live PTY.
  - Frames decoded:
    - Esc ``, ⏎ `
`, `1`, ⇧Tab `[Z`, ^C ``, ↑ `[A`.
    - Compose `hello world⏎line two  ` became
      `[200~hello world
line two[201~`, then a separate `
`. An armed
      Ctrl was disarmed without being applied.
    - An empty Send became a bare `
`.
  - A+ resized to 52×39 and A− back to 57×44.
  - A 780 → 430px viewport (the keyboard) moved the drawer to 430 tall, compose
    bottom at 430, and sent ONE resize, 56×19; restoring it gave 56×44.
  - Compact gives a 47px bar above the tab bar.
- Desktop at 1440: board screenshot identical to the pre-change build on :5176.
  Task-panel action rows are identical in order and classes for review, running
  and draft tasks. The one difference is the mirrored live-session guard, which
  disables Enqueue, Add to queue and Run now on a review task whose session is
  up.
- Not verified on a physical iPhone. `visualViewport` was driven by resizing the
  frame, which is what the keyboard does to it. That is the thing to check first
  if the terminal misbehaves on a device.

**Mobile shell (2026-08-27):**

- `npm run typecheck`, `npm run build`.
- Every route rendered over CDP at 360, 390 and 430 CSS px:
  `document.documentElement.scrollWidth === innerWidth` on all of them (no
  horizontal overflow anywhere), tab bar spans the viewport, `.app.mobile` set.
- More sheet, task slide-over, terminal drawer and the commands popover opened
  and screenshotted at 390px. The terminal is full width at `bottom: 56px`,
  clearing the bar; with the key row it measures 390×391 and 22 rows.
- The key row exercised against a **real PTY** on an isolated server (port 5411,
  own database) running `cat -v` and a `os.get_terminal_size()` loop as repo
  commands, driven over CDP at 390px. Outgoing frames decoded off the socket:
  Esc `\x1b`, Tab `\x09`, arrows `\x1b[A`/`[B`/`[D`/`[C`; Ctrl+`c` `\x03`,
  Ctrl+`a` `\x01`, Ctrl+`D` `\x04`, Ctrl+`5` `\x35` (unmapped — and the Ctrl
  still spent). Ctrl alone sends nothing. Ctrl-C killed `cat -v`. At 320/360/390
  /430 every key is 38px tall with no page overflow; at 1440 `.term-keys` is not
  in the DOM. Going 1440 → 390 on a live drawer mounts the row and moves the PTY
  from 161×19 to 50×22, and back on the return — the refit fires both ways.
- Desktop at 1440px re-checked: `--tm-sidebar-w` still 212px, `.main`
  padding-bottom still 64px, no `.app.mobile`.
- Dual-stack bind verified on an isolated copy (port 5409): `127.0.0.1`,
  `localhost`, `[::1]`, `192.168.0.8` and `faigs-macbook-air.local` all 200,
  while a forged public `Host` and a foreign `Origin` still 403. With `web/dist`
  removed, boot warns and `/` answers 503 with the fix while `/api/*` keeps
  working.
- LAN mode exercised end to end against a real server booted on an isolated copy
  (own empty database, port 5407): `GET` and `POST` over `192.168.0.8` and
  `*.local` pass, a foreign `Origin` is 403, a forged public `Host` is 403, and
  on the events WebSocket a LAN origin stays open while a foreign origin, a
  missing origin and a bad token each close 4403. With `TM_LAN` unset the same
  server refuses the LAN `Host` and `Origin`, and Vite serves `localhost` only.
