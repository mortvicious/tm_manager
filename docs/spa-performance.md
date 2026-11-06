# SPA idle cost

What an idle dashboard costs the Mac, why, and the rules that keep it cheap
(task 0d934db0, decisions.md 2026-11-06). The board was the case to fix: it
stays open all day, often in the background, with one or two agents running.

## Measurements

**Setup.** The measurements used an isolated Brave with its own profile, no
extensions and `--disable-backgrounding-occluded-windows`, at 1440×900. The
everyday browser shares its GPU process with every other window, and its
readings swung from 4 to 70 %. The SPA was a production build served by
`vite preview` against the live API: 985 tasks, ~1 700 runs, 38 board rows,
**2 running tasks**, about 15 WS events per 30 s. Each case was sampled for
20 s over CDP:
- CPU % per process type comes from `SystemInfo.getProcessInfo` deltas.
- Main-thread time and style recalcs come from `Performance.getMetrics`.
- React commits and fibers rendered come from a stub devtools hook.

There were three width/visibility cases:
- **desktop**: focused.
- **phone**: 390×844 @3×, touch.
- **hidden**: a second tab in front, so the board's tab is `visibilityState: hidden`.

`before` is HEAD `122f89e`. `after` is this change. `after-active` means
sampled 2 s after load, so within a minute of input. `after-idle` means
sampled after 65 s without input, i.e. calm (below). Every run had the
harness-only "new version is being served" toast hidden; its 40 px blur alone
was worth ~20 % GPU. Runs were back to back under the same load. The machine
was under pressure for the whole session (heavy lease report: macOS memory
warn, load average up to 418 on 8 cores; the final runs' lease: memory warn,
load ≤ 9), so compare rows with each other, not with another day.

Board, original version, 2 running tasks (renderer % / GPU % / main-thread
script ms per s):

| case | before | after, active | after, idle |
|---|---|---|---|
| Classic desktop | 7.9 / 9.0 / 11.9 | 3.7 / 4.2 / 2.2 | **0.2 / 0.1** / 1.0 |
| Classic phone | 8.0 / 9.3 / 14.2 | 2.8 / 2.9 / 2.8 | **0.3 / 0.0** / 1.7 |
| Glass desktop | 6.3 / **52.2** / 9.1 | 4.2 / 13.2 / 1.9 | **1.0 / 0.1** / 1.6 |
| Glass phone | 8.8 / 19.8 / 6.7 | 4.0 / 4.2 / 1.9 | **0.2 / 0.0** / 1.1 |
| hidden (Glass) | 3.1 / 0.0 / 13.9 | 1.8 / 0.1 / 3.1 | **0.7 / 0.1** / 2.7 |

The "active" column was measured with `steps(5)`. The final `steps(4)` was
re-measured later, under heavier load (5 running badges): Classic desktop
5.5 / 3.3, Classic phone 3.6 / 2.6, Glass desktop 5.2 / **9.4**, Glass phone
3.9 / 4.2. An A/B on Glass desktop with 3–5 running badges gave:
- `steps(5)`: 11.5–12.2 % GPU;
- `steps(4)`: 8.9 %;
- header capsules' blur off: 5.1 %.

React work on the same board, awake, with 1 running task at the time,
counted by a stub devtools hook over 30 s (commits/s, component renders/s):

| case | before | after |
|---|---|---|
| Classic desktop | 1.07 / 235 | 0.13 / 49 |
| Classic phone | 0.37 / 170 | 0.13 / 32 |
| Glass desktop | 0.30 / 205 | 0.27 / 73 |
| Glass phone | 0.87 / 373 | 0.23 / 49 |

A component render is a function component that did work in a commit; the
walk skips bailed-out subtrees, as React DevTools does.

Before the change, renderer cost was mostly React: the frozen `BoardPage`
re-rendered on every WS frame, every `run.activity` line and every clock tick,
and each pass rebuilt the search haystacks (10 ms/s) and ran a full scan of
the runs list per row (the hottest function in the profile). GPU cost was all
CSS animation. Turning every animation off took Glass from 55 % to 0.3 %.
A hidden tab still ran ~14 ms/s of script, because timers, polls and WS
frames kept rendering a page nobody could see.

The targets hold: an idle board is ≤ 5 % renderer (Classic 0.2–0.3 %, Glass
≤ 1 %), GPU ≤ 5 % Classic and ≤ 10 % Glass. A hidden tab is ≈ 0 % GPU and
0.5–0.7 % renderer (Classic hidden: 0.5 / 0.0), down from 3.1 % with 14 ms/s
of script.
While the human is active, Glass desktop is ~9 % GPU (§ Calm).

## Shared clock

`web/src/clock.ts` is the ONE clock. `useClock(ms, on?)` returns `Date.now()`
as of the period's last tick and re-renders on each tick. `onTick(ms, fn)` is
the same clock for effects and polls; it returns the unsubscribe.
- There is a single `setTimeout`, armed for the next wall-aligned boundary of
  the shortest live period. Every subscriber of a period is told in the same
  task, so a tick is one render pass, not one per row, and two components on
  one period always agree.
- While `document.visibilityState === 'hidden'` nothing is armed. On return,
  every period fires at once, so no age is shown stale.
- Users:
  - row ages (`TimeAgo` `useNow`, 30 s);
  - live elapsed timers (`Elapsed` 1 s only while a fine timer shows, `RunMeta`);
  - the history tab's open steps;
  - the timeline's NOW (`useTick`);
  - the usage pill (120 s) and the office page (60 s).

Rule: never add a `setInterval` for a clock or a poll. Subscribe a period.
Polls that are not clocks skip while hidden and catch up on return:
- `refreshHost`'s offline poll;
- the background-shells poll;
- the baseline poll in Commands.

`refreshHost` also keeps the old object when nothing changed, so a poll that
reads the same status re-renders nothing.

## Store

`web/src/state.tsx` keeps its `AppProvider` hooks, but consumers no longer
read a context value that changes on every event.
- The provider publishes the assembled state into an external store in
  `useLayoutEffect`, so consumers re-render before paint, exactly as before.
- **`useApp()` is a tracked view.** It returns an object whose getters record
  which slices the component read, and `useSyncExternalStore` re-renders the
  component only when one of THOSE changed. None of the ~60 call sites
  changed. The frozen `BoardPage` reads `tasks`, `runs` and so on, but not
  `activity`, so a `run.activity` line no longer renders the whole board.
- **`useAppSelector(sel)`** subscribes to one value. The selector must return a
  stable value: a slice, a row, a primitive, never a new array. `TaskRow`
  reads its run's activity line through it, so a line re-renders that row only.

## Batched events

WS frames are queued, not applied one by one. One `requestAnimationFrame`
applies the whole queue, so N frames are one store update and one render pass.
- A 250 ms timer is the fallback where rAF is throttled.
- While hidden, the queue is applied every 10 s (`HIDDEN_FLUSH_MS`), so the
  state stays current without rendering a page nobody sees.
- The queue is applied at once on return to visible and before a reconnect
  (`onclose`).
- `emitServerEvent` listeners run inside the same flush, in order.

## Row lookups

Per-row work over global lists is cached on the list's identity. Lists are
replaced, never mutated, so the array is the key:
- `web/src/runIndex.ts` builds `runsOfTask` / `liveReviewOf` once per `runs`
  array (WeakMap). That replaced a `runs.find`/`filter` per row per render in
  `liveReviewRun`, `elapsedSource` and `TaskRow`. Order is the list's, so
  every `find` picks the same run as before.
- `buildHaystacks` (`boardSearch.ts`) caches each task's haystack on the row
  object plus its group/repo/feature/role labels. A tick re-uses every
  haystack instead of rebuilding 985.

## Calm

Any running CSS animation keeps the compositor drawing at the display rate
(120 Hz on ProMotion). In Glass every one of those frames re-blurs the
header's capsules (8 × `backdrop-filter: blur(24px) saturate(1.8)`). That,
not React, was the GPU cost of an idle board. Two rules at the end of
`theme.css` handle it:
- **`html[data-calm]`** (`web/src/calm.ts`, started in `main.tsx`) stops every
  infinite "live" pulse. The dot stays, at full opacity, and the badge colour
  still says running. Calm holds while the window is unfocused or hidden,
  after 60 s without pointer/key/wheel/touch input, and whenever the system
  asks for reduced motion. The first input wakes it.
- **Awake, the opacity pulses STEP** (`steps(4, jump-none)`: four values per
  half-cycle). A smooth pulse makes a frame on every display refresh; a
  stepped one makes one only when its value changes. That took Glass from
  55 % to ~9 % GPU while active (`steps(5)` was 12 %).
- Left out on purpose:
  - an in-flight button spinner (the human just pressed it);
  - the offline dot (worth the motion);
  - the board versions' metro ring and marching dispatch edge, which keep
    smooth motion while awake and stop when calm.

Rule: **a new infinite animation goes in BOTH lists** at the end of
`theme.css`: the calm `animation: none` list and, if it is an opacity pulse,
the stepped list.

## Terminals

xterm 6 already stops rendering a pane that is not intersecting the viewport
(its RenderService watches an IntersectionObserver), and its cursor blinks
only while the terminal has focus. Hidden terminal tabs and the closed drawer
cost nothing, so no change was needed.

## The original board

`web/src/pages/Board.tsx` is untouched. Everything above lives in hooks and
shared components, so the board renders exactly as before:
- Its rows read the same values, from caches.
- Its pulses are the same keyframes, stepped while awake.
- Only the re-render count changed.

Screenshots of the original board before and after, Classic and Glass, are
in the task's artifacts.

## How to measure

The harness is in the task's artifacts (`profile.mjs`, `renders.mjs`,
`matrix.sh`).
1. Build into a scratch dir: `vite build --outDir node_modules/.perf/<name>`.
   Never build in place: `web/dist` is served.
2. Serve it with `vite preview` as a one-shot agent command on a free port
   (it proxies `/api` and `/ws` to the live API).
3. Start an isolated Brave or Chrome: `--user-data-dir=<scratch>
   --remote-debugging-port=9333 --disable-extensions
   --disable-backgrounding-occluded-windows`.
4. Run `node profile.mjs <origin> <classic|glass> <desktop|phone|hidden> 20`.
   It seeds `tm.design` / `tm.boardVersion`, loads `/board` and prints one
   JSON line.
   - `SETTLE=65000` samples the calm state.
   - `CSS=…` injects a stylesheet (hide the toast; A/B a rule).
   - `TOP=1` adds the busiest trace functions.
5. Take a heavy lease (`kind: browser`) for the whole session and read its
   release report. A noisy machine moves every absolute number.

## Known limits

- Low Power Mode is not visible to a page, so calm cannot key off it.
- While the human is active, the stepped pulses still cost Glass ~9 % GPU at
  desktop width. About half of that is the header capsules' blur, redrawn on
  every step (5 % with it off). It drops to ≈ 0 after a minute without input.
- The hidden-tab renderer floor (~0.5 %) is the WebSocket, the browser's
  own timers and the 10 s flush. Closing the socket while hidden was not tried:
  a reconnect refetches the whole state.
