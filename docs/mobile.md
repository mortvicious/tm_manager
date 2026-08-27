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
`site.webmanifest` is already `display: standalone`.

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
  and a top rail, because colour alone is weak in peripheral vision.
- **More sheet** (`.more-sheet`) — the **whole** nav (so the four slots are a
  shortcut, never the only route) plus the header controls the compact top bar
  could not hold: usage pill, server uptime/restart, repo commands, theme, and
  the address the page was served from. Escape and the overlay close it; it also
  closes on navigation and on crossing the breakpoint.
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
- **Rows wrap, titles do not shrink to nothing.** `.task-row` wraps with
  `.task-main` at `flex: 1 1 60%`, so chips move to a second line instead of
  squeezing the title. Child indent halves to 12px per level — marker included,
  or the `└` hangs off its own child.
- **The slide-over is a sheet**: full width, `top: 0`, and it owns the
  status-bar inset the header used to.
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

## The terminal key row

A phone soft keyboard has no Esc, no Tab, no Ctrl and no arrow keys, which is
most of how you steer an interactive `claude`: Esc interrupts, Tab accepts the
completion, the arrows walk history, Ctrl-C kills. So `.app.mobile` — and only
`.app.mobile` — renders a `.term-keys` row inside the drawer, directly above
`.term-body`:

```
[ Ctrl ][ Esc ][ Tab ][ ↑ ][ ↓ ][ ← ][ → ]
```

Every key goes out over the **same** `{type:'input'}` WebSocket frame the
keyboard already uses — the drawer's xterm effect publishes its send function
through a ref, and `term.onData` is wired to that same function, so there is one
input path and not two. Esc sends `\x1b`, Tab `\t`, and the arrows `\x1b[A`,
`\x1b[B`, `\x1b[D`, `\x1b[C`.

**Ctrl is sticky and lasts exactly one keypress.** It has to be: Ctrl-C needs a
`c`, and the `c` comes from the soft keyboard, not from the row. So the modifier
is applied where the bytes are sent rather than on the buttons — the next single
character is mapped with `c & 0x1f` (`c` → `\x03`, `a` → `\x01`, case-
insensitive; `?` → DEL), and anything that is not a single mappable character
passes through untouched. Armed, the key is teal and `aria-pressed`; tap it
again to disarm. It clears after one keypress **whether or not that key mapped**,
and it clears when the drawer compacts, when the viewport leaves mobile, or when
the run changes — an armed modifier on a terminal you cannot see would fire into
the next one you open.

The row scrolls horizontally rather than clipping (it fits without scrolling at
320px, but nothing about the key list is pinned to seven items), keys are
`--tm-tap-dense` (38px), and tapping one does not move focus — `preventDefault`
on mousedown keeps the soft keyboard up, otherwise every keypress would cost a
re-tap on the terminal. Because the row is a sibling of `.term-body` inside the
drawer, it takes its height from the terminal and not from the tab-bar
clearance; mounting or unmounting it refits xterm and resizes the PTY.

## Known limits

- A phone in **landscape** is ≥768px wide and therefore gets the desktop layout.
  That is legible (the sidebar fits 390px of height) but it is not designed for;
  a short-viewport pass is filed separately.
- The key row covers Esc, Tab, Ctrl and the four arrows. Anything else a
  session wants — Ctrl-with-a-symbol, function keys, Alt — still has no key.

## Verification

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
