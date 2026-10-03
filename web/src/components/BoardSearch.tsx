import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@tm/shared';
import {
  addTokens,
  suggest,
  tokenLabel,
  type SearchContext,
  type SearchToken,
  type Suggestion,
} from '../boardSearch.ts';
import { exitGhost } from '../motion.ts';
import { IconSearch, IconX } from './Icons.tsx';
import { Sheet } from './Sheet.tsx';

/**
 * The Board's one search (docs/search.md). Collapsed it is a single field-like
 * button — Spotlight's bar on a desktop, the iOS search field on a phone — and
 * every filter, sort and grouping control lives behind it. Open, it is a
 * Spotlight panel on a desktop and a tall sheet on a phone: tokens as chips
 * inside the field, live suggestions under it, the view controls at the foot.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** `⌘K` / `Ctrl K` anywhere on the board, or `/` when not typing, opens the search. */
export function useSearchHotkey(onOpen: () => void, enabled: boolean) {
  const ref = useRef(onOpen);
  ref.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const el = e.target instanceof Element ? e.target : null;
      // a terminal owns every key typed into it
      if (el?.closest('.xterm')) return;
      const typing = !!el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      const cmdK = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
      const slash = e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (!cmdK && !slash) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** One line of what the collapsed search is narrowing by. */
export function searchSummary(tokens: readonly SearchToken[], text: string, ctx: SearchContext): string {
  const parts = tokens.map((t) => {
    const l = tokenLabel(t, ctx);
    return `${l.facet} ${l.value}`;
  });
  if (text.trim()) parts.unshift(`“${text.trim()}”`);
  return parts.join(' · ');
}

export function SearchTrigger({
  tokens,
  text,
  ctx,
  mobile,
  expanded,
  onOpen,
}: {
  tokens: readonly SearchToken[];
  text: string;
  ctx: SearchContext;
  mobile: boolean;
  expanded: boolean;
  onOpen: () => void;
}) {
  const summary = searchSummary(tokens, text, ctx);
  const count = tokens.length + (text.trim() ? 1 : 0);
  return (
    <button
      type="button"
      className={`bs-trigger ${count > 0 ? 'on' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={summary ? `Search the board: ${summary}` : 'Search the board'}
      title={summary || undefined}
      onClick={onOpen}
    >
      <IconSearch />
      <span className={`bs-trigger-text ${summary ? '' : 'placeholder'}`}>
        {summary || (mobile ? 'Search' : 'Search tasks, ids, repos, dates…')}
      </span>
      {count > 0 && <span className="bs-count">{count}</span>}
      {!mobile && <kbd className="bs-kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>}
    </button>
  );
}

/** One token as a chip: the facet muted, its value in full. */
function TokenText({ tok, ctx }: { tok: SearchToken; ctx: SearchContext }) {
  const l = tokenLabel(tok, ctx);
  return (
    <>
      <span className="bs-facet">{l.facet}</span>
      <span className="bs-value">{l.value}</span>
    </>
  );
}

/**
 * What the collapsed search narrows by stays on screen under it: one chip per
 * token (tap to drop it), the text, and whatever else the board passes
 * (a non-default grouping).
 */
export function SearchChips({
  tokens,
  text,
  ctx,
  extra,
  shown,
  total,
  onChange,
}: {
  tokens: readonly SearchToken[];
  text: string;
  ctx: SearchContext;
  extra: { id: string; label: string; clear: () => void }[];
  shown: number;
  total: number;
  onChange: (next: { tokens: SearchToken[]; text: string }) => void;
}) {
  const q = text.trim();
  const n = tokens.length + (q ? 1 : 0) + extra.length;
  if (n === 0) return null;
  const searching = tokens.length > 0 || q !== '';
  return (
    <div className="filter-chips bs-chips">
      {q && (
        <button className="chip filter-chip" title="Clear the search text" onClick={() => onChange({ tokens: [...tokens], text: '' })}>
          <span className="bs-value">“{q}”</span>
          <IconX />
        </button>
      )}
      {tokens.map((tok, i) => (
        <button
          key={`${tok.kind}:${tok.value}`}
          className="chip filter-chip"
          title="Remove this filter"
          onClick={() => onChange({ tokens: tokens.filter((_, j) => j !== i), text })}
        >
          <TokenText tok={tok} ctx={ctx} />
          <IconX />
        </button>
      ))}
      {extra.map((f) => (
        <button key={f.id} className="chip filter-chip" title="Back to the default" onClick={f.clear}>
          <span className="bs-value">{f.label}</span>
          <IconX />
        </button>
      ))}
      {searching && (
        <span className="bs-chips-count" aria-live="polite">
          {shown} of {total}
        </span>
      )}
    </div>
  );
}

const shortId = (t: Task) => t.id.slice(0, 8);

function OptionBody({ s, ctx, text }: { s: Suggestion; ctx: SearchContext; text: string }) {
  const repo = (t: Task) => (t.repoId ? ctx.repos.find((r) => r.id === t.repoId)?.name : undefined);
  switch (s.type) {
    case 'open':
    case 'task':
      return (
        <>
          <span className="bs-opt-id mono">#{shortId(s.task)}</span>
          <span className="bs-opt-label">{s.task.title}</span>
          <span className="bs-opt-hint">
            {repo(s.task) && <span className="bs-opt-repo">{repo(s.task)}</span>}
            <span className={`bs-opt-status st-${s.task.status}`}>{s.task.status}</span>
          </span>
        </>
      );
    case 'commit':
      return (
        <>
          <span className="bs-opt-icon" aria-hidden="true">
            <IconSearch />
          </span>
          <span className="bs-opt-label">
            Search for <b>“{s.text}”</b>
          </span>
          <span className="bs-opt-hint">{s.count === 1 ? '1 task' : `${s.count} tasks`}</span>
        </>
      );
    case 'tokens':
      return (
        <>
          <span className="bs-opt-label bs-opt-tokens">
            {s.tokens.map((tok) => (
              <span key={`${tok.kind}:${tok.value}`} className="bs-tok-prev">
                <TokenText tok={tok} ctx={ctx} />
              </span>
            ))}
            {s.nextText && s.nextText !== text.trim() && <span className="bs-opt-rest">“{s.nextText}”</span>}
          </span>
          <span className="bs-opt-hint">{s.count}</span>
        </>
      );
  }
}

/**
 * The open search. Typing narrows the board LIVE (it is the board's query, not
 * a draft); the suggestions turn words into chips, open a task, or keep the
 * text. ↑/↓ move, Enter takes the highlighted line (the first, by default),
 * Backspace on an empty field drops the last chip, Escape closes.
 */
export function SearchPanel({
  tokens,
  text,
  ctx,
  hay,
  mobile,
  shown,
  total,
  view,
  canReset,
  onReset,
  onChange,
  onClose,
  onOpenTask,
}: {
  tokens: readonly SearchToken[];
  text: string;
  ctx: SearchContext;
  hay: ReadonlyMap<string, string>;
  mobile: boolean;
  shown: number;
  total: number;
  /** the board's view controls (group by, sort, essentials) */
  view: ReactNode;
  canReset: boolean;
  onReset: () => void;
  onChange: (next: { tokens: SearchToken[]; text: string }) => void;
  /** closes; the board folds typed `key:value` words into chips on the way */
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // With nothing typed the list is a menu, not an answer: nothing is
  // preselected, so Enter (a phone's Search key) never applies a filter
  // nobody chose. Once there is text, its best line is preselected.
  const [hi, setHi] = useState(text.trim() ? 0 : -1);
  const suggestions = useMemo(() => suggest(text, tokens, ctx, hay), [text, tokens, ctx, hay]);
  const sel = suggestions.length === 0 || hi < 0 ? -1 : Math.min(hi, suggestions.length - 1);
  const optId = (i: number) => `${uid}-opt-${i}`;

  // a new query starts at its best line (keyed by value: the board hands a
  // fresh tokens array whenever its clock ticks)
  const tokenKey = tokens.map((t) => `${t.kind}:${t.value}`).join('|');
  useEffect(() => setHi(text.trim() ? 0 : -1), [text, tokenKey]);
  useEffect(() => {
    if (sel >= 0) document.getElementById(`${uid}-opt-${sel}`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, uid]);

  // focus in on a desktop, back to whatever opened it on the way out. A phone
  // waits for a tap: focusing mid-sheet-animation makes iOS scroll the page.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (!mobile) inputRef.current?.focus();
    return () => {
      if (!mobile && before?.isConnected) before.focus();
    };
  }, [mobile]);

  const apply = (s: Suggestion) => {
    switch (s.type) {
      case 'open':
        // an id typed to go somewhere is navigation, not a filter to keep
        onChange({ tokens: [...tokens], text: '' });
        onClose();
        onOpenTask(s.task.id);
        return;
      case 'task':
        onClose();
        onOpenTask(s.task.id);
        return;
      case 'commit':
        onClose();
        return;
      case 'tokens':
        onChange({ tokens: addTokens(tokens, s.tokens), text: s.nextText });
        inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = suggestions.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n > 0) setHi(sel < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (sel >= 0) apply(suggestions[sel]);
      else onClose();
    } else if (e.key === 'Backspace' && tokens.length > 0) {
      const el = e.currentTarget;
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault();
        onChange({ tokens: tokens.slice(0, -1), text });
      }
    }
  };

  const field = (
    <div className="bs-field" onClick={() => inputRef.current?.focus()}>
      <IconSearch />
      {tokens.map((tok, i) => (
        <button
          key={`${tok.kind}:${tok.value}`}
          type="button"
          className="bs-token"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onChange({ tokens: tokens.filter((_, j) => j !== i), text });
            inputRef.current?.focus();
          }}
        >
          <TokenText tok={tok} ctx={ctx} />
          <IconX />
        </button>
      ))}
      <input
        ref={inputRef}
        className="bs-input"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        role="combobox"
        aria-label="Search the board"
        aria-expanded={suggestions.length > 0}
        aria-controls={`${uid}-list`}
        aria-autocomplete="list"
        aria-activedescendant={sel >= 0 ? optId(sel) : undefined}
        placeholder={tokens.length ? 'Add more…' : 'Title, id, repo, status, group, date…'}
        value={text}
        onChange={(e) => onChange({ tokens: [...tokens], text: e.target.value })}
        onKeyDown={onKeyDown}
      />
      {(text || tokens.length > 0) && (
        <button
          type="button"
          className="bs-clear"
          aria-label="Clear the search"
          onClick={(e) => {
            e.stopPropagation();
            onChange({ tokens: [], text: '' });
            inputRef.current?.focus();
          }}
        >
          <IconX />
        </button>
      )}
    </div>
  );

  const list = (
    <div className="bs-list" id={`${uid}-list`} role="listbox" aria-label="Suggestions">
      {suggestions.length === 0 && (
        <div className="bs-empty">
          {total === 0 ? 'No tasks yet.' : 'Type a title, an id, a repo, a status, a group or a date — or key:value, e.g. status:review created:today.'}
        </div>
      )}
      {suggestions.map((s, i) => (
        <div key={s.key} role="presentation">
          {(i === 0 || suggestions[i - 1].section !== s.section) && (
            <div className="bs-section" role="presentation">
              {s.section}
            </div>
          )}
          <div
            id={optId(i)}
            role="option"
            aria-selected={i === sel}
            className={`bs-opt bs-opt-${s.type}`}
            // keep the field focused (and a phone's keyboard up) through a pick
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== sel && setHi(i)}
            onClick={() => apply(s)}
          >
            <OptionBody s={s} ctx={ctx} text={text} />
            {!mobile && i === sel && (
              <span className="bs-enter" aria-hidden="true">
                ↵
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  if (mobile) {
    return (
      <Sheet
        label="Search the board"
        tall
        className="bs-sheet"
        bodyClassName="bs-sheet-body"
        onClose={onClose}
        head={(close) => (
          <div className="bs-sheet-head">
            <span className="bs-sheet-title">Search</span>
            <span className="bs-sheet-count">
              {shown} of {total}
            </span>
            <button className="btn ghost bs-done" onClick={close}>
              Done
            </button>
          </div>
        )}
      >
        {field}
        {list}
        <div className="bs-view">
          <div className="bs-section">View</div>
          {view}
          <button className="btn bs-reset" disabled={!canReset} onClick={onReset}>
            Reset search & view
          </button>
        </div>
      </Sheet>
    );
  }

  const host = document.querySelector('.app') ?? document.body;
  return createPortal(
    <div
      className="bs-root"
      ref={exitGhost}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // ours alone: a task panel or sheet under the search keeps its Escape
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="overlay bs-overlay" onMouseDown={onClose} />
      <div className="bs-pop" role="dialog" aria-modal="true" aria-label="Search the board">
        {field}
        {list}
        <div className="bs-foot">
          <div className="bs-foot-view">{view}</div>
          <button className="btn ghost bs-reset" disabled={!canReset} onClick={onReset}>
            Reset
          </button>
          <span className="bs-keys" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>↵</kbd> pick <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    host,
  );
}
