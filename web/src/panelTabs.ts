import type { Task } from '@tm/shared';

/**
 * The task panel's tabs (docs/mobile.md § Task panel tabs, docs/design.md
 * § Task URLs). Pure: which tab a panel opens on and what a click remembers.
 * The URL half (`?tab=` beside `?task=`) lives in App.tsx beside useOpenTask.
 */
export type PanelTab = 'overview' | 'diff' | 'review' | 'terminal' | 'history';

/** every tab the model knows, in strip order */
export const PANEL_TAB_ORDER: readonly PanelTab[] = ['overview', 'diff', 'review', 'terminal', 'history'];

export const PANEL_TAB_LABEL: Record<PanelTab, string> = {
  overview: 'Overview',
  diff: 'Diff',
  review: 'Review & checks',
  terminal: 'Terminal',
  history: 'History',
};

/**
 * The tabs this build draws. `diff` and `history` are known to the model
 * (URL, memory, defaults) but come with later tasks of the feature; until
 * they are listed here a `?tab=diff` is ignored like any unknown value.
 */
const SHIPPED: ReadonlySet<PanelTab> = new Set<PanelTab>(['overview', 'review', 'terminal']);

export function offeredTabs(): PanelTab[] {
  return PANEL_TAB_ORDER.filter((t) => SHIPPED.has(t));
}

/** The task's state as the tab defaults read it. */
export type PanelBucket = 'asking' | 'running' | 'review' | 'idle' | 'finished-ok' | 'finished-bad';

/** `asking` = the agent is waiting on a question of this task (it outranks the status). */
export function panelBucket(task: Pick<Task, 'status'>, asking: boolean): PanelBucket {
  if (asking) return 'asking';
  switch (task.status) {
    case 'running':
    case 'waiting':
      return 'running';
    case 'review':
      return 'review';
    case 'done':
    case 'published':
      return 'finished-ok';
    case 'failed':
    case 'cancelled':
      return 'finished-bad';
    default:
      // draft, queued, blocked — and any status a later build adds
      return 'idle';
  }
}

/** Where a bucket opens when nothing was picked: the tab that answers "what now?". */
export function defaultTab(bucket: PanelBucket, offered: readonly PanelTab[]): PanelTab {
  const want: PanelTab =
    bucket === 'running'
      ? 'terminal'
      : bucket === 'review' || bucket === 'finished-ok'
        ? 'review'
        : bucket === 'finished-bad'
          ? 'history'
          : 'overview';
  return offered.includes(want) ? want : 'overview';
}

export function isPanelTab(v: unknown): v is PanelTab {
  return typeof v === 'string' && (PANEL_TAB_ORDER as readonly string[]).includes(v);
}

/**
 * The tab to show, by precedence: the human's click in this open of the panel,
 * then `?tab=` from the URL, then the bucket's remembered pick, then the
 * bucket's default. Anything not offered (unknown, or a tab this build does
 * not draw) is skipped, never shown.
 */
export function pickTab(p: {
  clicked: string | null;
  url: string | null;
  remembered: string | null | undefined;
  bucket: PanelBucket;
  offered: readonly PanelTab[];
}): PanelTab {
  for (const t of [p.clicked, p.url, p.remembered]) {
    if (isPanelTab(t) && p.offered.includes(t)) return t;
  }
  return defaultTab(p.bucket, p.offered);
}

/** localStorage: the last tab a human picked, per bucket — never one global choice */
export const PANEL_TAB_KEY = 'tm.panelTab';

export type TabMemory = Partial<Record<PanelBucket, PanelTab>>;

/** localStorage is untrusted input: anything but `{bucket: knownTab}` is dropped. */
export function readTabMemory(): TabMemory {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PANEL_TAB_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: TabMemory = {};
    for (const [k, v] of Object.entries(raw)) if (isPanelTab(v)) out[k as PanelBucket] = v;
    return out;
  } catch {
    return {};
  }
}

export function rememberTab(bucket: PanelBucket, tab: PanelTab): void {
  try {
    localStorage.setItem(PANEL_TAB_KEY, JSON.stringify({ ...readTabMemory(), [bucket]: tab }));
  } catch {
    /* private mode / quota: the pick still holds for this open */
  }
}

/** Arrow-key movement along the strip (wraps), Home/End to the ends; null = not a strip key. */
export function tabByKey(key: string, current: PanelTab, offered: readonly PanelTab[]): PanelTab | null {
  const i = Math.max(0, offered.indexOf(current));
  if (key === 'ArrowRight') return offered[(i + 1) % offered.length];
  if (key === 'ArrowLeft') return offered[(i - 1 + offered.length) % offered.length];
  if (key === 'Home') return offered[0];
  if (key === 'End') return offered[offered.length - 1];
  return null;
}
