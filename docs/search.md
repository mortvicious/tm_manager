# Board search

One search narrows the Board by anything a task carries: text, id, parent,
group, repo, status, live state, source, category, feature, model, dispatches
and dates. The Board's filter, sort and grouping controls live behind it, so the
top of the page is now the title, one field, and (on a desktop) the essentials
toggle.

Code: `web/src/boardSearch.ts` holds the rules and is pure (no React, no DOM).
`web/src/components/BoardSearch.tsx` holds the UI, and `BoardPage` in
`web/src/pages/Board.tsx` wires them together.

## Using it

- **Collapsed** it is a field-shaped button: Spotlight's bar at the right of the
  desktop title, beside **essentials**, and the iOS search field leading the
  phone toolbar, before **+ New**. It reads `Search tasks, ids, repos, dates…`
  when idle. While a search is on, it reads what the search narrows by
  (`“login” · status review`), with a count badge.
- **Open it** by clicking or tapping it. On a desktop `⌘K` / `Ctrl K` also opens
  it from anywhere on the Board, and so does `/` when the focus is not in a text
  field. A terminal keeps its keys.
- **Desktop**: a Spotlight panel near the top of the window, over a scrim. Its
  foot holds the view controls (`group:` and `sort:`), **Reset**, and the key
  hints.
- **Phone**: a tall sheet. The field is at the top, the suggestions under it,
  then a **View** section: group by, sort, `full | essentials`, and
  **Reset search & view**. **Done** is in the head.
- **Typing narrows the board live.** The text IS the board's query, not a draft.
  Every word must match the start of a word somewhere in the task: its title,
  description, summary, id, parent id, group id and name, repo name, status,
  source, category, feature title, model, error, and the local dates it was
  filed and last touched (`2026-10-03`). So `fail` finds "failed" but not
  "unfailing". `"quoted words"` match as one phrase. `#3f2a1b` works as well as
  `3f2a1b`.
- **Suggestions**, in this order:
  - **Go to.** When the input is an id (full, or a unique prefix of 4+
    characters, the rules of Telegram's `/task`), the task is the first line and
    Enter opens it. An ambiguous prefix lists up to 6 candidates. Opening by id
    clears the text, because it was navigation, not a filter.
  - **Search for “…”** with its count. Enter keeps the text and closes.
  - **Smart filter.** The whole input read as facets: `review nest login`
    becomes status review, repo neko-nest and the text "login". `done yesterday`
    becomes status done and updated yesterday. A word becomes a chip only when it
    names exactly one thing outright: exact, a 3+ letter prefix, or, for a repo or
    category, the start of an inner word (`nest` → `neko-nest`). `neko` prefixes
    two repos, so it stays a word. A date beside only settled statuses
    (review/published/done/failed/cancelled) means *updated*; otherwise it means
    *created*. When the literal text finds nothing but the reading does, the
    reading moves above the plain search, so Enter takes it.
  - **Facets.** The values the input (whole, or its last word) names: Status,
    State, Source, Repos, Categories, Groups, Features, Dispatches, Models,
    Dates and Ids. Ids offer `id starts with` and `under #…`, the whole subtree
    below a task.
  - **Tasks.** Up to 6 tasks the query finds, best title match first. Picking
    one opens it.

  Every filter suggestion shows how many tasks it would leave, and a suggestion
  that would leave none is not offered. With nothing typed, the list is a menu of
  starting points: needs attention, asks you, in my queue, each status present,
  created/updated today, updated in the last 7 days, each repo, each source.
- **Keys**: `↑`/`↓` move through the suggestions and Enter takes the highlighted
  one. Once something is typed, the first line is preselected. With nothing
  typed, no line is preselected, so Enter (or a phone's Search key) only closes
  and never applies a filter nobody chose. Backspace in an empty field drops the
  last chip. Escape, a click on the scrim, the sheet's Done or a swipe closes the
  search, and the board stays filtered.
- **Chips.** A picked facet becomes a chip inside the field. Click the chip to
  remove it. Under the closed search the same chips stay on screen, with the
  text, a non-default `group:` and `n of N`, and tapping one clears it. The empty
  board state offers **Clear the search**.
- **While searching**, every section and group block shows open (a match folded
  away is a match not found). Folding is per search and forgotten afterwards; the
  saved folds return when the search is cleared. The drafts strip shows all
  matches, essentials keeps finished history, and the Recent strip hides, since
  the sections above are the lookup now.

## Typed syntax

Every chip has a typed form, `key:value`. It applies live while typed and becomes
a chip when the search closes. A key with no value yet (`status:`) is ignored, so
the board doesn't blink empty, and the suggestions list that facet's values.
A value that names nothing (`status:nonsense`) stays text and honestly matches
nothing.

| key (aliases)                         | value                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `repo` (`r`)                          | a repo name, prefix or inner word; `none`                                                         |
| `status` (`s`)                        | a status or a word for one (`todo`, `shipped`, `in progress`…)                                    |
| `is`                                  | a status, else a state                                                                            |
| `state`                               | `attention`, `asking`, `auto-review`, `fixing`, `flagged`, `in-queue`, `held`, `waking`, `auto-publish` |
| `source` (`src`, `from`, `by`)        | `human`, `agent`, `sentry`, `analyze`, `feature`                                                  |
| `cat` (`category`)                    | a category; `uncategorized`                                                                       |
| `group` (`g`)                         | a group's name, or its root id (4+ characters)                                                    |
| `feature` (`f`)                       | a feature's title, or its id                                                                      |
| `dispatch` (`dispatches`)             | `any`, `pending`                                                                                  |
| `model`                               | a model id; `default`                                                                             |
| `id` (`task`)                         | an id prefix                                                                                      |
| `parent` (`under`)                    | an id or unique prefix: the whole subtree below it                                                |
| `created` (`filed`), `updated` (`touched`, `date`) | a date phrase (below)                                                                |

**Date phrases**: `today`, `yesterday`, `7d` / `7 days` / `last 7 days`,
`2w`, `week` / `this week` (7 days), `month` (30 days), `year` (365 days), a
day (`2026-09-30`, `sep 30`, `30 sep`, `sep 30 2026`, a weekday meaning the
latest one), a month (`2026-09`, `september`, `sep 2026`), and
`since|from <day>`, `after <day>` (the day after), `before <day>`. Days are the
user's LOCAL days. A month or day with no year that is still ahead means last
year's.

## Rules

- **Same kind OR, different kinds AND.** `status review` + `status failed` shows
  both, and adding `repo neko-nest` narrows both. A date kind holds one value:
  picking another replaces it.
- **States are the badges, not statuses**: *needs attention* (a live run's
  permission prompt), *asks you* (a pending question), *auto-review*
  (`review` + review state pending/reviewing), *fixing*, *review flagged*, *in my
  queue* (`customQueueAt`), *held* (`queueHeldAt`), *auto wake-up* (`wakeAt`),
  *auto-publish*.
- **Persisted** in `localStorage['tm.board']` as `tokens` + `text`, beside sort,
  focus, folds and groupBy. The single-valued filters stored before
  (`repo/prov/cat/group/dispatch`, `'all'` when off) migrate into tokens on
  first load, so an upgrade keeps the board as it was narrowed. Stored tokens
  are validated (`isToken`). A token whose referent is gone reads as absent
  (`tokenLive`), as the old selects did: a deleted repo, a dissolved group, a
  deleted feature, or no dispatches left. The checks wait for data, because an
  empty list at boot means "not loaded yet".
- **A group header's name** still filters to that group. It replaces any other
  group chip.
- **Dates move with the clock.** The context carries the Board's minute clock,
  so `today` rolls over at midnight without a reload.

## Design

- **Classic**: the trigger is an inset field, and the panel is `--tm-bg-raised`
  with the strong border and the large shadow. The highlighted suggestion is the
  macOS selection: an accent fill with everything on it in `--tm-accent-contrast`.
- **Glass** (`glass.css`): the trigger is a glass capsule and the panel is thick
  glass (`--tm-glass-thick` + rim + specular, blur) that grows out of the top
  with the spring (`tm-pop-in`) and leaves through `exitGhost`
  (`.bs-root.tm-exit`). On a phone the sheet is Liquid Glass like every sheet,
  and the field in it is the iOS search field (`--tm-glass-lens`, no rim).
- The phone field is 16px (`--tm-text-input`), or iOS zooms on focus. The list
  lives in the sheet's own scroller, with no nested scroller
  (`docs/mobile.md` § Sheets). On a phone, task suggestions drop the repo name so
  the title keeps the line. The phone does not autofocus, because focusing
  mid-animation makes iOS scroll the page. A tap on the field brings up the
  keyboard.
- The panel is a combobox (`role="combobox"`, `aria-activedescendant`, a
  `listbox` of `option`s), and the closed button says what it is narrowing by in
  its accessible name.

## Verification

- `web/src/boardSearch.ts` was exercised with a tsx script over fixture tasks.
  It covered:
  - Date phrases and ranges (including last-year rollback, invalid days, and
    `after` = the day after).
  - Every typed key.
  - OR/AND combination, word-prefix matching, phrases and `#id`.
  - Absorbing typed words on commit and token liveness.
  - Suggestions: id → Go to first, the smart reading, ambiguous words left as
    text, and the reading leading when the literal text finds nothing.
- Playwright (Chromium) against the Vite dev server and the live API, desktop
  1440×900 and an iPhone-sized 393×852 context, in Classic and Glass, with no
  page errors:
  - Closed, `⌘K`, typing, ↓ + Enter to a chip, the smart filter, Escape back to
    the chips.
  - Phone: tap to open, type, Done.
- `npm run typecheck` and `npm run build` are clean.
