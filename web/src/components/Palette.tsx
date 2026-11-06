import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoutesFromChildren, matchRoutes, useLocation, useNavigate } from 'react-router-dom';
import type { Task } from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { useBoardVersion } from '../boardVersions.ts';
import { useDialogFocus } from '../dialogFocus.ts';
import { exitGhost } from '../motion.ts';
import {
  BOARD_SEARCH_EVENT,
  PALETTE_OPEN_EVENT,
  SECTION_LABEL,
  buildEntries,
  flatEntries,
  globalActionEntries,
  id8,
  pushRecent,
  rankEntries,
  rankSubList,
  readRecent,
  taskActionEntries,
  type PaletteEntry,
  type RankedSection,
} from '../palette.ts';
import { useApp } from '../state.tsx';
import { buildTaskActions, type TaskAction } from '../taskActions.ts';
import { toastDone, toastError } from '../toast.ts';
import { useWorkspace } from '../workspace.ts';
import { IconSearch, IconX } from './Icons.tsx';
import { limitStopped } from './Inbox.tsx';
import { NAV, useIsMobile } from './Layout.tsx';
import { Sheet } from './Sheet.tsx';
import { StatusBadge } from './StatusBadge.tsx';

/**
 * The global ⌘K palette (docs/palette.md): jump to a task, a page, a repo, a
 * workspace, a feature or a chat from any page, run a task's actions (the open
 * panel's first; Tab/→ on a task line for any other) and the global commands
 * (New task…, Pause all / Continue, Switch workspace…, Open …). Mounted once
 * (App.tsx). A Spotlight panel on a desktop, a tall <Sheet> on a phone, opened
 * by ⌘K / Ctrl K, by the phone header's search button and by the More sheet
 * (`openPalette()`). The lists are palette.ts; this is keys, steps, focus and
 * markup.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Palette({
  routes,
  onOpenTask,
  onOpenTerminal,
}: {
  routes: ReactElement<{ children?: ReactNode }>;
  onOpenTask: (taskId: string) => void;
  /** a task action's "Open terminal": App decides what happens to an open panel */
  onOpenTerminal: (runId: string, taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { search } = useLocation();

  // every task opened anywhere (a board row, a push tap, the palette) is recent
  const openTask = new URLSearchParams(search).get('task');
  useEffect(() => {
    if (openTask) pushRecent(`task:${openTask}`);
  }, [openTask]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      const el = e.target instanceof Element ? e.target : null;
      // a terminal owns every key typed into it
      if (el?.closest('.xterm')) return;
      // the board's own search is open: its field has the keys; a question or a
      // lightbox above everything keeps them too
      if (document.querySelector('.bs-pop, .qmodal:not(.tm-exit), .yarl__root')) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  const close = useCallback(() => setOpen(false), []);
  if (!open) return null;
  return <PalettePanel routes={routes} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} onClose={close} />;
}

/**
 * Where the palette is (docs/palette.md § Steps). `search` is the go-to list;
 * every other step was pushed from it and Esc / ← / Backspace on an empty
 * field pops back. In `follow-up` and `new-title` the field is the text, not
 * a filter.
 */
type Mode =
  | { kind: 'search' }
  | { kind: 'actions'; taskId: string }
  | { kind: 'follow-up'; taskId: string }
  | { kind: 'new-title' }
  | { kind: 'new-repo'; title: string }
  | { kind: 'workspaces' };

interface Frame {
  mode: Mode;
  query: string;
  hi: number;
}

/** the New task form's repo memory (pages/Board.tsx, read-only there — same keys) */
const LAST_REPO_KEY = 'tm.newTask.repo';
const lastRepoKey = (workspaceId: string | null) => (workspaceId ? `${LAST_REPO_KEY}.${workspaceId}` : LAST_REPO_KEY);
function loadLastRepo(workspaceId: string | null): string {
  try {
    return localStorage.getItem(lastRepoKey(workspaceId)) ?? '';
  } catch {
    return '';
  }
}

function PalettePanel({
  routes,
  onOpenTask,
  onOpenTerminal,
  onClose,
}: {
  routes: ReactElement<{ children?: ReactNode }>;
  onOpenTask: (taskId: string) => void;
  onOpenTerminal: (runId: string, taskId: string) => void;
  onClose: () => void;
}) {
  const mobile = useIsMobile();
  const { tasks, repos, features, chats, workspaces, runs, orch, setOrch, refresh } = useApp();
  const { workspace, inScopeRepo, setWorkspace, wsHref } = useWorkspace();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  // only the original board has the board search (the other versions have none)
  const boardVersion = useBoardVersion();
  const boardSearch = pathname === '/board' && boardVersion.id === 'original';
  const [mode, setMode] = useState<Mode>({ kind: 'search' });
  const [stack, setStack] = useState<Frame[]>([]);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  // the line whose call is in flight: the palette waits for the answer, and
  // stays on the line if it is a refusal
  const [busy, setBusy] = useState<string | null>(null);
  const arm = useArm();
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // read once per open: what is picked now ranks from the next open on
  const [recent] = useState(readRecent);

  // the router's own table, so a page that has not shipped is never offered
  const routeTable = useMemo(() => createRoutesFromChildren(routes.props.children), [routes]);
  const hasRoute = useCallback((path: string) => (matchRoutes(routeTable, path)?.length ?? 0) > 0, [routeTable]);

  const push = (next: Mode) => {
    setStack((s) => [...s, { mode, query, hi }]);
    setMode(next);
    setQuery('');
    setHi(0);
    arm.disarm();
  };
  /** false when there is nothing to go back to */
  const back = (): boolean => {
    const top = stack[stack.length - 1];
    if (!top) return false;
    setStack((s) => s.slice(0, -1));
    setMode(top.mode);
    setQuery(top.query);
    setHi(top.hi);
    arm.disarm();
    return true;
  };

  // ── the task whose actions are listed: the drilled one, else the open panel's
  const panelTaskId = new URLSearchParams(search).get('task');
  const focusId = mode.kind === 'actions' || mode.kind === 'follow-up' ? mode.taskId : mode.kind === 'search' ? panelTaskId : null;
  const focusTask = focusId ? (tasks.find((t) => t.id === focusId) ?? null) : null;
  const focusRuns = useMemo(() => (focusId ? runs.filter((r) => r.taskId === focusId) : []), [runs, focusId]);
  // the session Publish/Follow-up would reopen — wording only, as on the panel
  const [resumable, setResumable] = useState<{ taskId: string; sessionId: string | null } | null>(null);
  const runSig = focusRuns.map((r) => `${r.id}:${r.sessionId ?? ''}:${r.status}`).join('|');
  useEffect(() => {
    if (!focusId) return;
    let live = true;
    api
      .resumable(focusId)
      .then((r) => live && setResumable({ taskId: focusId, sessionId: r.sessionId }))
      .catch(() => live && setResumable({ taskId: focusId, sessionId: null }));
    return () => {
      live = false;
    };
  }, [focusId, runSig]);
  const resumeSession = resumable && resumable.taskId === focusId ? resumable.sessionId : null;

  // a refusal from a builder action is toasted inside it, never thrown: this
  // flag is how the palette learns of it and stays on the line
  const refused = useRef(false);
  const actionsFor = (task: Task): PaletteEntry[] => {
    const built = buildTaskActions(task, {
      taskRuns: focusRuns,
      shellWaits: orch.shellWaits,
      resumeSession,
      mobile,
      refresh,
      toastError: (e, title) => {
        refused.current = true;
        toastError(e, title);
      },
      onOpenTerminal: (runId) => onOpenTerminal(runId, task.id),
      // not offered in the palette (PALETTE_TASK_ACTION_IDS)
      analyze: () => {},
      delete: () => {},
    });
    const limit = task.status === 'failed' && limitStopped(task);
    return taskActionEntries(task, built, {
      run: async (a: TaskAction) => {
        refused.current = false;
        const r = a.onClick();
        if (r instanceof Promise) {
          await r;
          return !refused.current;
        }
        // Publish / Mark published answered "no" at their window confirm: stay on the line
        return !(a.id === 'publish' || a.id === 'mark-published');
      },
      // the panel offers its follow-up box once there is a turn to follow up
      followUp: task.status !== 'draft' || focusRuns.length > 0 ? () => push({ kind: 'follow-up', taskId: task.id }) : null,
      followUpHint: followUpHint(task, limit, resumeSession),
      again: mobile ? undefined : 'press ↵ again',
    });
  };

  // ── global commands
  const pauseOrContinue = async (): Promise<boolean> => {
    const paused = !!orch.paused;
    try {
      // PauseButton's own calls (Layout.tsx)
      await api.orchestratorAction(paused ? 'continue' : 'pause');
      setOrch(await api.orchestrator());
      return true;
    } catch (e) {
      toastError(e, paused ? 'Continue' : 'Pause all');
      return false;
    }
  };
  const globals = globalActionEntries(
    { paused: !!orch.paused, pausedTasks: orch.pausedTasks ?? 0, mobile, workspaceName: workspace?.name ?? null, hasRoute },
    {
      newTask: () => push({ kind: 'new-title' }),
      pauseOrContinue,
      switchWorkspace: () => push({ kind: 'workspaces' }),
      go: (path) => navigate(wsHref(path)),
    },
  );

  const navEntries = buildEntries(
    {
      tasks,
      repos,
      features,
      chats,
      workspaces,
      pages: NAV,
      currentWorkspace: workspace?.slug ?? null,
      inScopeRepo,
      hasRoute,
      query: mode.kind === 'search' ? query : '',
      onBoard: boardSearch,
      actions: [...(focusTask && mode.kind === 'search' ? actionsFor(focusTask) : []), ...globals],
    },
    {
      openTask: onOpenTask,
      go: (path) => navigate(wsHref(path)),
      setWorkspace,
      searchBoard: () => window.dispatchEvent(new Event(BOARD_SEARCH_EVENT)),
    },
  );

  // ── New task: title, then the repo (the form's default first)
  const createIn = async (title: string, repoId: string | null): Promise<boolean> => {
    try {
      const t = await api.createTask({ title, repoId });
      if (repoId) {
        try {
          localStorage.setItem(lastRepoKey(workspace?.id ?? null), repoId);
        } catch {
          /* private mode: the default just stays the workspace's */
        }
      }
      onOpenTask(t.id);
      return true;
    } catch (e) {
      toastError(e, 'New task');
      return false;
    }
  };
  const repoChoices = (title: string): PaletteEntry[] => {
    const known = (id: string | null) => !!id && repos.some((r) => r.id === id);
    const last = loadLastRepo(workspace?.id ?? null);
    const fallback = workspace?.repoIds.find((id) => known(id)) ?? '';
    const def = known(last) && inScopeRepo(last) ? last : fallback;
    const inScope = repos.filter((r) => inScopeRepo(r.id));
    const ordered = [...inScope.filter((r) => r.id === def), ...inScope.filter((r) => r.id !== def)];
    const out: PaletteEntry[] = ordered.map((r) => ({
      id: `newtask:${r.id}`,
      section: 'repo',
      title: r.name,
      subtitle: r.id === def ? `default · ${r.path}` : r.path,
      run: () => createIn(title, r.id),
    }));
    // a draft may go without a repo (the form allows it) — not inside a workspace, though
    if (!workspace) out.push({ id: 'newtask:none', section: 'repo', title: 'No repo', subtitle: 'assign one later', run: () => createIn(title, null) });
    return out;
  };

  // ── Follow-up: the panel's send / resume, the same routes
  const sendFollowUp = async (task: Task): Promise<boolean> => {
    const msg = query.trim();
    const limit = task.status === 'failed' && limitStopped(task);
    try {
      if (limit) await api.proceed(task.id, msg || undefined);
      else await api.followUp(task.id, msg);
      toastDone(`task:${task.id}`, limit ? 'Resuming its session' : 'Follow-up sent');
      void refresh().catch(() => {});
      return true;
    } catch (e) {
      toastError(e, limit ? 'Resume' : 'Follow-up');
      return false;
    }
  };

  // ── the lines of the current step
  const modeTask = mode.kind === 'actions' || mode.kind === 'follow-up' ? focusTask : null;
  let sections: RankedSection[];
  let heading: string | null = null;
  if (mode.kind === 'search') {
    sections = rankEntries(navEntries, query, recent);
  } else if (mode.kind === 'actions') {
    heading = modeTask ? taskName(modeTask) : 'Task not found';
    sections = modeTask ? rankSubList(actionsFor(modeTask), query) : [];
  } else if (mode.kind === 'follow-up') {
    heading = modeTask ? `Follow-up · ${taskName(modeTask)}` : 'Task not found';
    const limit = !!modeTask && modeTask.status === 'failed' && limitStopped(modeTask);
    sections = modeTask
      ? [
          {
            section: 'context',
            entries: [
              {
                id: 'followup:send',
                section: 'context',
                title: limit ? 'Resume its session' : 'Send follow-up',
                subtitle: !limit && !query.trim() ? 'type the instruction first' : followUpHint(modeTask, limit, resumeSession),
                disabled: !limit && !query.trim(),
                run: () => sendFollowUp(modeTask),
              },
            ],
          },
        ]
      : [];
  } else if (mode.kind === 'new-title') {
    heading = workspace ? `New task in ${workspace.name}` : 'New task';
    const title = query.trim();
    sections = [
      {
        section: 'action',
        entries: [
          {
            id: 'newtask:title',
            section: 'action',
            title: title ? `Next: pick a repo for “${title}”` : 'Type the title',
            subtitle: 'filed as a draft, then its panel opens',
            disabled: !title,
            keepOpen: true,
            run: () => push({ kind: 'new-repo', title }),
          },
        ],
      },
    ];
  } else if (mode.kind === 'new-repo') {
    heading = `Repo for “${mode.title}”`;
    sections = rankSubList(repoChoices(mode.title), query);
  } else {
    heading = 'Switch workspace';
    sections = rankSubList(
      navEntries.filter((e) => e.section === 'workspace'),
      query,
    );
  }
  const flat = flatEntries(sections);
  const sel = flat.length === 0 ? -1 : Math.min(hi, flat.length - 1);
  const optId = (i: number) => `${uid}-opt-${i}`;
  const textStep = mode.kind === 'follow-up' || mode.kind === 'new-title';

  useEffect(() => {
    if (sel >= 0) document.getElementById(optId(sel))?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  // a step change puts the caret back in the one field (the first render's
  // focus is useDialogFocus's on a desktop, the sheet's on a phone)
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    inputRef.current?.focus();
  }, [mode]);

  useDialogFocus(popRef, !mobile);

  const pick = async (e: PaletteEntry) => {
    if (busy || e.disabled) return;
    // a line that kills or spends asks for a second ↵ (src/arm.ts)
    if (e.confirm && !arm.press(e.armKey ?? e.id)) return;
    // the MRU is for where you go: navigation lines and the global commands
    if (mode.kind === 'search' && e.section !== 'context') pushRecent(e.id);
    const r = e.run();
    if (e.keepOpen) return;
    if (r instanceof Promise) {
      setBusy(e.id);
      let ok: boolean | void;
      try {
        ok = await r;
      } finally {
        if (alive.current) setBusy(null);
      }
      if (ok === false || !alive.current) return;
    }
    onClose();
  };

  const drill = (e: PaletteEntry | undefined) => {
    if (mode.kind !== 'search' || !e || e.section !== 'task' || !e.task) return false;
    push({ kind: 'actions', taskId: e.task.id });
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = flat.length;
    const caretAtEnd = (e.currentTarget.selectionStart ?? query.length) >= query.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n > 0) setHi(sel < 0 ? 0 : (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (sel >= 0) void pick(flat[sel]);
    } else if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'ArrowRight' && caretAtEnd)) {
      // a task line: its actions (anything else keeps Tab's focus wrap)
      if (sel >= 0 && drill(flat[sel])) e.preventDefault();
    } else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && !query && stack.length) {
      e.preventDefault();
      back();
    }
  };

  const placeholder =
    mode.kind === 'search'
      ? 'Task, id, page, repo, workspace, action…'
      : mode.kind === 'follow-up'
        ? 'The instruction for its session…'
        : mode.kind === 'new-title'
          ? 'Title of the new task'
          : mode.kind === 'new-repo'
            ? 'Filter repos…'
            : mode.kind === 'workspaces'
              ? 'Filter workspaces…'
              : 'Filter actions…';

  const field = (
    <div className="bs-field" onClick={() => inputRef.current?.focus()}>
      {stack.length > 0 ? (
        <button
          type="button"
          className="pal-back"
          aria-label="Back"
          title="Back (Esc)"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={(ev) => {
            ev.stopPropagation();
            back();
          }}
        >
          ‹
        </button>
      ) : (
        <IconSearch />
      )}
      <input
        ref={inputRef}
        className="bs-input"
        type={textStep ? 'text' : 'search'}
        enterKeyHint={textStep ? (mode.kind === 'follow-up' ? 'send' : 'next') : 'go'}
        autoComplete="off"
        autoCorrect={textStep ? 'on' : 'off'}
        autoCapitalize={textStep ? 'sentences' : 'off'}
        spellCheck={textStep}
        role="combobox"
        aria-label={heading ?? 'Go to'}
        aria-expanded={flat.length > 0}
        aria-controls={`${uid}-list`}
        aria-autocomplete="list"
        aria-activedescendant={sel >= 0 ? optId(sel) : undefined}
        placeholder={placeholder}
        data-autofocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHi(0);
          arm.disarm();
        }}
        onKeyDown={onKeyDown}
      />
      {query && (
        <button
          type="button"
          className="bs-clear"
          aria-label="Clear"
          onClick={(e) => {
            e.stopPropagation();
            setQuery('');
            setHi(0);
            arm.disarm();
            inputRef.current?.focus();
          }}
        >
          <IconX />
        </button>
      )}
    </div>
  );

  const sectionLabel = (s: RankedSection, idx: number) => {
    if (heading && idx === 0) return heading;
    if (s.section === 'context') return focusTask ? `This task · ${taskName(focusTask)}` : SECTION_LABEL.context;
    if (!query.trim() && s.section === 'task') return 'Recent tasks';
    return SECTION_LABEL[s.section];
  };

  let i = -1;
  const list = (
    <div className="bs-list pal-list" id={`${uid}-list`} role="listbox" aria-label="Results">
      {flat.length === 0 && (
        <div className="bs-empty">
          {mode.kind === 'actions' && !modeTask
            ? 'That task is gone.'
            : query.trim()
              ? `Nothing matches “${query.trim()}”.`
              : 'Nothing to offer here.'}
        </div>
      )}
      {sections.map((s, idx) => (
        <div key={`${s.section}-${idx}`} role="group" aria-label={sectionLabel(s, idx)}>
          <div className="bs-section" role="presentation">
            {sectionLabel(s, idx)}
          </div>
          {s.entries.map((e) => {
            const at = ++i;
            const armed = !!e.confirm && arm.armed === (e.armKey ?? e.id);
            const drillable = mode.kind === 'search' && e.section === 'task' && !!e.task;
            return (
              <div
                key={e.id}
                id={optId(at)}
                role="option"
                aria-selected={at === sel}
                aria-disabled={e.disabled || undefined}
                aria-busy={busy === e.id || undefined}
                className={`bs-opt pal-opt pal-opt-${e.section}${e.disabled ? ' pal-off' : ''}${armed ? ' pal-armed' : ''}`}
                // keep the field focused (and a phone's keyboard up) through a pick
                onMouseDown={(ev) => ev.preventDefault()}
                onMouseMove={() => at !== sel && setHi(at)}
                onClick={() => void pick(e)}
              >
                <EntryBody e={e} title={busy === e.id ? `${e.title}…` : armed ? e.confirm! : undefined} />
                {drillable && (
                  <button
                    type="button"
                    className="pal-drill"
                    aria-label={`Actions for ${e.title}`}
                    title="Actions (Tab)"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      drill(e);
                    }}
                  >
                    ›
                  </button>
                )}
                {!mobile && at === sel && !drillable && (
                  <span className="bs-enter" aria-hidden="true">
                    ↵
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  if (mobile) {
    return (
      <Sheet
        label={heading ?? 'Go to'}
        tall
        className="pal-sheet"
        bodyClassName="bs-sheet-body"
        onClose={onClose}
        head={(close) => (
          <div className="bs-sheet-head">
            <span className="bs-sheet-title">{heading ?? 'Go to'}</span>
            <span className="bs-sheet-count" />
            <button className="btn ghost bs-done" onClick={close}>
              Done
            </button>
          </div>
        )}
      >
        {field}
        {list}
      </Sheet>
    );
  }

  const host = document.querySelector('.app') ?? document.body;
  return createPortal(
    <div
      className="pal-root"
      ref={exitGhost}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        // a step goes back to the one it came from; the list itself closes
        if (!back()) onClose();
      }}
    >
      <div className="overlay pal-overlay" onMouseDown={onClose} />
      <div className="pal-pop" ref={popRef} role="dialog" aria-modal="true" aria-label={heading ?? 'Go to'} tabIndex={-1}>
        {field}
        {list}
        <div className="bs-foot">
          <span className="pal-foot-hint">{isMac ? '⌘K' : 'Ctrl K'} anywhere</span>
          <span className="bs-keys" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>↵</kbd> {textStep ? (mode.kind === 'follow-up' ? 'send' : 'next') : 'run'}{' '}
            {mode.kind === 'search' && (
              <>
                <kbd>⇥</kbd> task actions{' '}
              </>
            )}
            <kbd>esc</kbd> {stack.length ? 'back' : 'close'}
          </span>
        </div>
      </div>
    </div>,
    host,
  );
}

const taskName = (t: Task) => `${t.title || '(untitled)'} · ${id8(t.id)}`;

/** what ↵ on Follow-up… will do — the panel's two buttons, read off the row */
function followUpHint(task: Task, limit: boolean, resumeSession: string | null): string {
  if (limit) return 'reopens its own session where the usage limit stopped it (the text, if any, is the instruction)';
  if (resumeSession) return `continues session ${resumeSession.slice(0, 8)}, which remembers everything`;
  return task.status === 'draft' ? 'a new instruction to its agent' : 're-runs the task with the previous summary as context';
}

function EntryBody({ e, title }: { e: PaletteEntry; title?: string }) {
  return (
    <>
      {e.task && (
        <StatusBadge
          status={e.task.status}
          reviewState={e.task.reviewState}
          checkState={e.task.checkState}
          loopState={e.task.loopState}
          explain={false}
        />
      )}
      <span className="bs-opt-label pal-opt-label">
        {title ?? e.title}
        {e.subtitle && <span className="pal-sub"> {e.subtitle}</span>}
      </span>
      {e.hint && <span className="bs-opt-hint">{e.hint}</span>}
    </>
  );
}
