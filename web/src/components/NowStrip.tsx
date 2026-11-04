import { useMemo } from 'react';
import type { Task } from '@tm/shared';
import { compileQuery, type SearchContext, type SearchToken } from '../boardSearch.ts';

/**
 * The phone board's Now strip (docs/mobile.md § Now strip): four counts —
 * working, needs you, ready to publish, failed — each of them a set of board
 * search chips (docs/search.md). A tap REPLACES the status/state chips with
 * its own and keeps every other chip and the typed text; a second tap clears
 * them. The count is the same query run over the same scoped tasks, so it is
 * always exactly the number of rows the tap leaves on the board.
 */
interface NowItem {
  id: string;
  label: string;
  tone: string;
  tokens: SearchToken[];
}

const ITEMS: NowItem[] = [
  { id: 'working', label: 'working', tone: 'run', tokens: [{ kind: 'status', value: 'running' }, { kind: 'status', value: 'waiting' }] },
  { id: 'you', label: 'needs you', tone: 'att', tokens: [{ kind: 'state', value: 'asking' }, { kind: 'state', value: 'attention' }] },
  { id: 'ready', label: 'to publish', tone: 'rev', tokens: [{ kind: 'state', value: 'ready' }] },
  { id: 'failed', label: 'failed', tone: 'fail', tokens: [{ kind: 'status', value: 'failed' }] },
];

/** the chips a strip item owns: any status/state chip (the one kind of filter it sets) */
const owned = (t: SearchToken) => t.kind === 'status' || t.kind === 'state';
const key = (ts: readonly SearchToken[]) =>
  ts
    .map((t) => `${t.kind}:${t.value}`)
    .sort()
    .join('|');

export function NowStrip({
  tasks,
  tokens,
  text,
  ctx,
  haystacks,
  onChange,
}: {
  /** the board's tasks in the current workspace scope, before the search */
  tasks: readonly Task[];
  tokens: readonly SearchToken[];
  text: string;
  ctx: SearchContext;
  haystacks: Map<string, string>;
  onChange: (next: { tokens: SearchToken[]; text: string }) => void;
}) {
  const rest = useMemo(() => tokens.filter((t) => !owned(t)), [tokens]);
  const on = key(tokens.filter(owned));
  const counts = useMemo(
    () =>
      ITEMS.map((it) => {
        const match = compileQuery([...rest, ...it.tokens], text, ctx, haystacks);
        return tasks.reduce((n, t) => n + (match(t) ? 1 : 0), 0);
      }),
    [rest, text, ctx, haystacks, tasks],
  );
  return (
    <nav className="now-strip" aria-label="Now">
      {ITEMS.map((it, i) => {
        const active = on === key(it.tokens);
        const n = counts[i];
        return (
          <button
            key={it.id}
            type="button"
            className={`now-cell t-${it.tone}${active ? ' on' : ''}${n === 0 ? ' zero' : ''}`}
            aria-pressed={active}
            // an empty filter is a dead end; the active one always clears
            disabled={n === 0 && !active}
            title={active ? `Showing ${it.label} — tap to clear` : `Show only ${it.label} (${n})`}
            onClick={() => onChange({ tokens: active ? [...rest] : [...rest, ...it.tokens], text })}
          >
            <span className="now-n">{n}</span>
            <span className="now-label">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
