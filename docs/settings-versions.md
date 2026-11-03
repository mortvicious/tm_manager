# Settings versions

The Config page (`/config`) grew into one hand-written scroll of 13 sections and about 70 controls. On the phone each label sits above its control, so the page is very long. This task does not pick a new design. It builds five alternative layouts as **switchable versions**, using the same pattern as the Board versions (`docs/board-versions.md` § Versions control), so the user can try them live on desktop and phone and then choose one.

## Registry

- **`web/src/settingsVersions.ts`** is the twin of `boardVersions.ts`. It holds `SETTINGS_VERSIONS: { id, label, component }[]` in menu order. `original` has `component: null`, and every other version is a `lazy()` page.
- **Storage.** The device's pick is in localStorage under `tm.settingsVersion`, and this tab's pick survives blocked storage. Other tabs follow the `storage` event.
- **Fallback.** An unknown or unlisted value reads as `original`, so a version that a later build removes falls back without a migration.
- **`web/src/pages/ConfigRoute.tsx`** is what `/config` mounts. For `original` it mounts the frozen `ConfigPage` and passes the Versions control through two optional props:
  - `headSlot`: the desktop menu in the page head
  - `topSlot`: the phone row at the top of the page

  For any other version it mounts the device's pick.
- **The Versions control** is in `components/SettingsKit.tsx`:
  - `SettingsVersionsControl` is the desktop select, rendered only on desktop.
  - `SettingsVersionsSetting` is the phone row, rendered only on a phone.

  Both hide when only `original` is listed.

## Shared behaviour

- **One save path: `useSettingsForm()`** (`web/src/settingsForm.ts`). Every version uses it, the original included. It holds:
  - the loaded settings and the snapshot the diff is taken against
  - `dirty`: the keys edited since the last load or save
  - `save()`: sends exactly the dirty keys. `NEVER_SAVED` (`orchestrator.enabled` and `orchestrator.paused`, the machine-owned switches) is never sent. `orchestrator.concurrency` and `orchestrator.model` are ordinary settings and are sent when edited, as before.
  - `discard()`
  - `reset(key)`: sets the key back to `DEFAULT_SETTINGS`. It is an edit, so it still needs Save.
  - the Sentry token draft and the Sentry sync (which saves first)
  - `recent`: keys saved from this device, kept in `tm.settings.recent`

  `Config.tsx`'s own state and save logic moved into this hook. Its JSX did not change.
- **The descriptor registry** (`web/src/settingsRegistry.tsx`) lists sections and controls.
  - Each section is `{ id, title, intent, intro?, device?, keywords?, summary }`.
  - Each control is `{ key, section, label, help, advanced?, intent?, wide?, note?, render }`.
  - Labels and help are the original page's text.
  - `x:` keys are rows that are not settings: the queue read-out, the Repos links, the Sentry token, the sync button, the storage driver.
  - The per-device blocks, Appearance (`AppearanceSettings`) and Notifications (`PushSettings`), are sections with `device` set. They render as their existing components, apply as clicked, and are never part of Save.
- **Section changes compared with the original.**
  - The original "Agent" section (18 controls) is split into **Agent**, **Review & checks** and **Sessions**.
  - The original "Landing" pointer became a **Per-repo settings** section. It has one row per per-repo setting (Landing, Push policy, Parallel worktrees, Question autopilot · auto-approve, Preview URL), and each row links to the Repos page carrying `?ws`. Search finds them, and nothing on the Repos page is duplicated.
  - The header's queue switch shows as a read-only **Queue** row. It has its own two-press route and is never saved from here.
- **Search** is in every version (`SettingsSearch`, `queryWords`, `matchesSetting`). Every word of the query must appear in the label, the key, the help or the section title, ignoring case. Device blocks match on their title and `keywords`. Results are grouped by section and show the key under the label. Escape clears the box.
- **Changed from default.** `SettingRow` shows a dot, `changed · default X` and **Reset** for every key that differs from `DEFAULT_SETTINGS`. A key edited but not saved also gets an amber dot. Sections, cards and tabs show a count of changed keys.
- **Save bar.** `SaveBar` is a sticky bar with "N unsaved changes · Discard · Save". It shows while anything is edited and sits above the phone's tab bar, so Save is never a scroll away. The head's Save shows `Save (n)`.
- **Tokens only.** All styling uses `--tm-*` tokens, in the "settings versions" block of `theme.css` plus two `.app.mobile` rules. Glass needs only one rule of its own: the sticky rail and the scroll targets sit below the floating header. The remapped tokens and the existing `.cfg-*` Glass rules cover the rest. Where a section renders inside a card or a sheet, its own panel chrome is removed (`.app :is(.cfg-sheet-body, .cfg-card-body) > .panel.cfg-group`).

## The versions

| id | label | Desktop | Phone |
|---|---|---|---|
| `original` | Original | the current page, frozen | the same |
| `mix` | Picked · cards + rail + intents | **the user's pick** (§ Decision). A's sticky rail, its headers C's five intents, each listing its sections (a row follows its own intent, as in C). One intent is shown at a time as E's summary cards, collapsed, with **Expand all**. A rail click opens the intent, expands the card and scrolls to it, and scroll-spy follows. The intent is remembered in `tm.settingsMixTab`. | A's phone list (`PhoneList`), each section in a sheet |
| `sidebar` | A · Sidebar sections | a sticky left rail of sections grouped by intent, with changed counts. Scroll-spy (IntersectionObserver) highlights the section in view, and a click jumps to it. | an iOS-Settings list of sections grouped by intent, each row showing its one-line summary. A row opens the section in a tall `<Sheet>` whose head carries Save. |
| `basic` | B · Basic / Advanced | only the controls without `advanced` (14 rows: queue, concurrency, worker model, effort, permission mode, review on/off, review model, review rounds, task and day budget, routing on/off, chat model, group colours, landing) plus Appearance and Notifications. Each section has **Show advanced (n)**, which also says how many hidden keys are changed. | the same |
| `tabs` | C · Tabs by intent | Running agents · Notifications & alerts · Look & feel · Content · Integrations. A row follows its own `intent` (the anomaly alerts sit under Notifications & alerts). The tab is remembered in `tm.settingsTab`. | the tabs scroll sideways |
| `palette` | D · Search first | a big search box and one chip per section. When empty, the page lists *Edited, not saved*, *Recently changed* (this device) and *Changed from default*, each control inline. | the same, with no autofocus (it would pop the keyboard) |
| `cards` | E · Summary cards | one collapsed card per section. Its line is the current value ("Opus 5.5 high · auto", "$40/task · off/day · alert past 60 min"). A card expands in place, and several can be open at once. | the same |

## Screenshots

Each image shows **Classic | Glass** side by side, dark scheme, at desktop width (1440) and phone width (390). They are at the top level of the task's artifacts:

- `settings-<id>-desktop.png`
- `settings-<id>-phone.png`

`original` and `mix` (built after the answer) are included too. They were captured with Playwright (chromium-1243) against the live API's GETs, serving a scratch build. Every non-GET was intercepted, and the agent-question and approval lists were stubbed empty.

## Verification

- `npm run typecheck`, plus a `vite build` to a scratch outDir.
- **Payload.** In every version, at desktop and phone widths, editing one control and pressing Save sent exactly `{"orchestrator.concurrency": 3}` (the PUT was intercepted).
- **Search.** `review.maxRounds` found exactly that row. "fix rounds" found the review, check and feature-plan round rows. "autopilot" found the Per-repo link.
- **`original` is unchanged.** `.main`'s HTML from HEAD's build and from this build is byte-identical once the Versions control is removed, at both widths and in both designs.

## Decision

2026-11-03. The AskUserQuestion offered A, B, C, D, E and a mix. The user chose **a mix: A on the phone, and E + A + C combined on desktop**. That combination was built as the `mix` version (`pages/settings/Mixed.tsx`; on the phone it reuses A's `PhoneList`), verified the same way as the others (payload, search, screenshots `settings-mix-*.png`), and listed first after `original`.

As the brief says, nothing was removed in this task. Draft **86c520a4** makes `mix` the Config page and deletes `original`'s JSX, the Versions control and the other five versions, together with their CSS and localStorage keys. Logged in `docs/decisions.md` (2026-11-03).
