import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoutesFromChildren, matchRoutes, useLocation, useNavigate } from 'react-router-dom';
import { useBoardVersion } from '../boardVersions.ts';
import { useDialogFocus } from '../dialogFocus.ts';
import { exitGhost } from '../motion.ts';
import {
  BOARD_SEARCH_EVENT,
  PALETTE_OPEN_EVENT,
  SECTION_LABEL,
  buildEntries,
  flatEntries,
  pushRecent,
  rankEntries,
  readRecent,
  type PaletteEntry,
} from '../palette.ts';
import { useApp } from '../state.tsx';
import { useWorkspace } from '../workspace.ts';
import { IconSearch, IconX } from './Icons.tsx';
import { NAV, useIsMobile } from './Layout.tsx';
import { Sheet } from './Sheet.tsx';
import { StatusBadge } from './StatusBadge.tsx';

/**
 * The global ⌘K palette (docs/palette.md): jump to a task, a page, a repo, a
 * workspace, a feature or a chat from any page. Mounted once (App.tsx). A
 * Spotlight panel on a desktop, a tall <Sheet> on a phone, opened by ⌘K /
 * Ctrl K, by the phone header's search button and by the More sheet
 * (`openPalette()`). The list is palette.ts; this is keys, focus and markup.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Palette({ routes, onOpenTask }: { routes: ReactElement<{ children?: ReactNode }>; onOpenTask: (taskId: string) => void }) {
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
  return <PalettePanel routes={routes} onOpenTask={onOpenTask} onClose={close} />;
}

function PalettePanel({
  routes,
  onOpenTask,
  onClose,
}: {
  routes: ReactElement<{ children?: ReactNode }>;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  const mobile = useIsMobile();
  const { tasks, repos, features, chats, workspaces } = useApp();
  const { workspace, inScopeRepo, setWorkspace, wsHref } = useWorkspace();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // only the original board has the board search (the other versions have none)
  const boardVersion = useBoardVersion();
  const boardSearch = pathname === '/board' && boardVersion.id === 'original';
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // read once per open: what is picked now ranks from the next open on
  const [recent] = useState(readRecent);

  // the router's own table, so a page that has not shipped is never offered
  const routeTable = useMemo(() => createRoutesFromChildren(routes.props.children), [routes]);
  const hasRoute = useCallback((path: string) => (matchRoutes(routeTable, path)?.length ?? 0) > 0, [routeTable]);

  const entries = useMemo(
    () =>
      buildEntries(
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
          query,
          onBoard: boardSearch,
        },
        {
          openTask: onOpenTask,
          go: (path) => navigate(wsHref(path)),
          setWorkspace,
          searchBoard: () => window.dispatchEvent(new Event(BOARD_SEARCH_EVENT)),
        },
      ),
    [tasks, repos, features, chats, workspaces, workspace, inScopeRepo, hasRoute, query, boardSearch, onOpenTask, navigate, wsHref, setWorkspace],
  );
  const sections = useMemo(() => rankEntries(entries, query, recent), [entries, query, recent]);
  const flat = useMemo(() => flatEntries(sections), [sections]);
  const sel = flat.length === 0 ? -1 : Math.min(hi, flat.length - 1);
  const optId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => setHi(0), [query]);
  useEffect(() => {
    if (sel >= 0) document.getElementById(optId(sel))?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  useDialogFocus(popRef, !mobile);

  const pick = (e: PaletteEntry) => {
    pushRecent(e.id);
    onClose();
    e.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = flat.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n > 0) setHi(sel < 0 ? 0 : (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (sel >= 0) pick(flat[sel]);
    }
  };

  const field = (
    <div className="bs-field" onClick={() => inputRef.current?.focus()}>
      <IconSearch />
      <input
        ref={inputRef}
        className="bs-input"
        type="search"
        enterKeyHint="go"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        role="combobox"
        aria-label="Go to"
        aria-expanded={flat.length > 0}
        aria-controls={`${uid}-list`}
        aria-autocomplete="list"
        aria-activedescendant={sel >= 0 ? optId(sel) : undefined}
        placeholder="Task, id, page, repo, workspace, feature, chat…"
        data-autofocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
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
            inputRef.current?.focus();
          }}
        >
          <IconX />
        </button>
      )}
    </div>
  );

  let i = -1;
  const list = (
    <div className="bs-list pal-list" id={`${uid}-list`} role="listbox" aria-label="Results">
      {flat.length === 0 && <div className="bs-empty">Nothing matches “{query.trim()}”.</div>}
      {sections.map((s) => (
        <div key={s.section} role="group" aria-label={SECTION_LABEL[s.section]}>
          <div className="bs-section" role="presentation">
            {!query.trim() && s.section === 'task' ? 'Recent tasks' : SECTION_LABEL[s.section]}
          </div>
          {s.entries.map((e) => {
            const at = ++i;
            return (
              <div
                key={e.id}
                id={optId(at)}
                role="option"
                aria-selected={at === sel}
                className={`bs-opt pal-opt pal-opt-${e.section}`}
                // keep the field focused (and a phone's keyboard up) through a pick
                onMouseDown={(ev) => ev.preventDefault()}
                onMouseMove={() => at !== sel && setHi(at)}
                onClick={() => pick(e)}
              >
                <EntryBody e={e} />
                {!mobile && at === sel && (
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
        label="Go to"
        tall
        className="pal-sheet"
        bodyClassName="bs-sheet-body"
        onClose={onClose}
        head={(close) => (
          <div className="bs-sheet-head">
            <span className="bs-sheet-title">Go to</span>
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
        onClose();
      }}
    >
      <div className="overlay pal-overlay" onMouseDown={onClose} />
      <div className="pal-pop" ref={popRef} role="dialog" aria-modal="true" aria-label="Go to" tabIndex={-1}>
        {field}
        {list}
        <div className="bs-foot">
          <span className="pal-foot-hint">{isMac ? '⌘K' : 'Ctrl K'} anywhere</span>
          <span className="bs-keys" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    host,
  );
}

function EntryBody({ e }: { e: PaletteEntry }) {
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
        {e.title}
        {e.subtitle && <span className="pal-sub"> {e.subtitle}</span>}
      </span>
      {e.hint && <span className="bs-opt-hint">{e.hint}</span>}
    </>
  );
}
