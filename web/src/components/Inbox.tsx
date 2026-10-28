import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  APPROVAL_LABELS,
  DEFAULT_SETTINGS,
  buildInbox,
  publishCaution,
  type DiffStat,
  type InboxItem,
  type InboxKind,
  type Task,
} from '@tm/shared';
import { api } from '../api.ts';
import { confirmMarkPublished, confirmPublish, markPublishedOffered } from '../publish.ts';
import { useApp } from '../state.tsx';
import type { ReturnTo } from '../returnTo.ts';
import { toastError } from '../toast.ts';
import {
  IconAnalyze,
  IconCheck,
  IconEye,
  IconInbox,
  IconMore,
  IconPlay,
  IconPublish,
  IconRefresh,
  IconTerminal,
  IconX,
} from './Icons.tsx';
import { QuestionForm } from './QuestionModal.tsx';
import { reviewHeadline } from './ReviewPanel.tsx';
import { TaskAttemptsChip, TaskCostChip } from './RunMeta.tsx';
import { Sheet, SheetAction } from './Sheet.tsx';

/**
 * The Inbox (docs/inbox.md): everything waiting on the human, in the order of
 * the shared `buildInbox` — the same list Telegram's `/inbox` draws. Read off
 * the live store, so an answered question or a landed review leaves the list
 * on the WS event that changed it, with no polling and no route of its own.
 */
export function useInbox(): InboxItem[] {
  const { tasks, questions, approvals, runs, proposals, features, settings } = useApp();
  const staleDraftDays = staleDays(settings);
  return useMemo(
    () => buildInbox({ tasks, questions, approvals, runs, proposals, features, staleDraftDays }),
    [tasks, questions, approvals, runs, proposals, features, staleDraftDays],
  );
}

function staleDays(settings: ReturnType<typeof useApp>['settings']): number {
  return settings?.['inbox.staleDraftDays'] ?? DEFAULT_SETTINGS['inbox.staleDraftDays'];
}

/**
 * The decisions a count shows (header chip, phone tab, page title): every item
 * but a stale draft (docs/inbox.md § Stale drafts) — backlog hygiene sits at
 * the bottom of the list and must not keep the badge lit on its own.
 */
export function decisions(items: InboxItem[]): InboxItem[] {
  return items.filter((i) => i.kind !== 'stale-draft');
}

const CANCEL_STALE_REASON = 'stale draft triage';

export const KIND_LABEL: Record<InboxKind, string> = {
  question: 'asks you',
  approval: 'approve',
  attention: 'needs attention',
  review: 'review',
  failed: 'failed',
  blocked: 'blocked',
  proposal: 'proposal',
  feature: 'feature plan',
  'stale-draft': 'stale draft',
};

/** The task an item is about, when it is about one. */
export function itemTask(item: InboxItem): Task | null {
  if (item.kind === 'proposal' || item.kind === 'approval') return item.task;
  if (item.kind === 'feature') return null;
  return item.task;
}

export function itemTitle(item: InboxItem): string {
  if (item.kind === 'proposal')
    return item.proposal.payload.title ?? item.task?.title ?? item.proposal.payload.rationale;
  if (item.kind === 'feature') return item.feature.title;
  if (item.kind === 'approval') return `${APPROVAL_LABELS[item.approval.action]}${item.task ? ` · ${item.task.title}` : ''}`;
  return item.task.title;
}

/** "3 files +120 −8" from the newest review round that kept a stat. */
export function lastDiffStat(task: Task): DiffStat | null {
  return [...task.reviewRounds].reverse().find((r) => r.diffStat)?.diffStat ?? null;
}

function statText(s: DiffStat): string {
  return `${s.files} file${s.files === 1 ? '' : 's'} +${s.insertions} −${s.deletions}`;
}

/** One line under the title — what the decision is about. */
export function itemSummary(item: InboxItem): string {
  switch (item.kind) {
    case 'question': {
      const first = item.questions[0]?.questions[0];
      const more = item.questions.reduce((n, q) => n + q.questions.length, 0) - 1;
      return first ? `“${first.question}”${more > 0 ? ` (+${more})` : ''}` : 'a question is waiting';
    }
    case 'approval':
      return item.approval.summary.split('\n')[0];
    case 'attention':
      return 'the agent is waiting at a prompt in its terminal';
    case 'review': {
      const t = item.task;
      const parts: string[] = [];
      if (item.ready) parts.push(`ready: ${item.ready}`);
      else {
        if (t.checkState === 'red') parts.push('checks red');
        else if (t.checkState === 'error') parts.push('checks gave no verdict');
        const h = reviewHeadline(t);
        if (h) parts.push(h.text);
      }
      const s = lastDiffStat(t);
      if (s) parts.push(statText(s));
      return parts.join(' · ') || 'in review';
    }
    case 'failed':
      return item.task.error ?? 'failed';
    case 'blocked': {
      const c = item.children;
      return `${c.total - c.open} of ${c.total} subtasks settled${c.failed ? `, ${c.failed} failed` : ''}`;
    }
    case 'proposal':
      return `${item.proposal.kind.replace('_', ' ')} — ${item.proposal.payload.rationale}`;
    case 'feature': {
      const phases = item.feature.analysis?.phases ?? [];
      const n = phases.reduce((a, ph) => a + ph.tasks.filter((c) => !c.excluded).length, 0);
      return `${phases.length} phase(s), ${n} task(s) planned`;
    }
    case 'stale-draft':
      return `filed by an agent ${item.ageDays} days ago, never started${item.task.brief ? ` — ${item.task.brief}` : ''}`;
  }
}

/**
 * A failed task the usage limit stopped, rather than its work: parked for the
 * wake-up (`wakeAt`), or an error that names the limit. Only decides whether
 * the Inbox offers Resume beside Retry — a wrong guess costs a button.
 */
export function limitStopped(t: Task): boolean {
  return !!t.wakeAt || /usage limit|rate[_ ]limit|\b5-hour limit\b|weekly limit/i.test(t.error ?? '');
}

/** A keyboard-reachable decision on an item: the key is its desktop shortcut. */
export interface InboxAct {
  key: 'a' | 'd' | 'f' | 'r' | 'p' | 'x' | 'o' | 't' | 'l' | 'h';
  label: string;
  hint?: string;
  tone?: 'primary' | 'danger';
  disabled?: boolean;
  /** the sheet's icon, when the key's default (`ACT_ICON`) is not this act's */
  icon?: ReactNode;
  /** asked before anything runs; false = the human backed out, nothing happens */
  confirm?: () => boolean;
  /** resolves when done; throws with the server's refusal */
  run: () => Promise<unknown> | void;
}

export interface InboxNav {
  onOpenTask: (id: string) => void;
  /** `from` = the item to reopen when the terminal closes (docs/mobile.md § Returning from a terminal) */
  onOpenTerminal: (runId: string, from?: ReturnTo) => void;
}

export function useInboxActs(nav: InboxNav) {
  const navigate = useNavigate();
  const { refresh, settings } = useApp();
  const keepDays = staleDays(settings);
  return useCallback(
    (item: InboxItem): InboxAct[] => {
      const open = (t: Task | null): InboxAct[] =>
        t ? [{ key: 'o', label: 'Open', hint: 'the task panel', run: () => nav.onOpenTask(t.id) }] : [];
      const then = (p: Promise<unknown>) => p.then(() => refresh());
      switch (item.kind) {
        case 'question':
          return open(item.task);
        case 'approval': {
          // the server runs exactly what the card says (docs/approvals.md)
          const a = item.approval;
          const push = a.action === 'push-ref';
          return [
            {
              key: 'a',
              label: 'Approve',
              hint: push ? 'the server pushes exactly these refs' : 'the server runs it now',
              tone: 'primary',
              icon: <IconCheck />,
              confirm: push ? () => window.confirm(`Approve this push?\n\n${a.summary}`) : undefined,
              run: () => api.decideApproval(a.id, true),
            },
            { key: 'x', label: 'Reject', tone: 'danger', run: () => api.decideApproval(a.id, false) },
            ...open(item.task),
          ];
        }
        case 'attention':
          return [
            {
              key: 't',
              label: 'Open terminal',
              hint: 'answer the prompt there',
              tone: 'primary',
              run: () => nav.onOpenTerminal(item.run.id, { kind: 'inbox', key: item.key, sheet: false }),
            },
            ...open(item.task),
          ];
        case 'review': {
          // Publish ships; Mark done closes WITHOUT pushing (docs/inbox.md §
          // Acting). Publish leads only over a clean verdict (`ready`); over a
          // flagged review the lead is sending the findings back, over red
          // checks it is Open — never Mark done, which would bury the work.
          const t = item.task;
          const caution = publishCaution(t);
          const flagged = t.reviewState === 'flagged';
          // already pushed by the agent → record it (docs/publish.md § Observed publish)
          const shipped = markPublishedOffered(t);
          const publish: InboxAct = shipped
            ? {
                key: 'p',
                label: caution ? 'Mark published anyway' : 'Mark published',
                hint: caution ? `${caution} — asks first` : 'already pushed by the agent',
                tone: item.ready ? 'primary' : undefined,
                icon: <IconPublish />,
                confirm: () => confirmMarkPublished(t),
                run: () => then(api.taskAction(t.id, 'mark-published')),
              }
            : {
                key: 'p',
                label: caution ? 'Publish anyway' : 'Publish',
                hint: caution ? `${caution} — asks first` : 'commit and push',
                tone: item.ready ? 'primary' : undefined,
                disabled: !t.repoId,
                icon: <IconPublish />,
                confirm: () => confirmPublish(t),
                run: () => then(api.taskAction(t.id, 'publish')),
              };
          const done: InboxAct = {
            key: 'd',
            label: 'Mark done',
            hint: 'closes without pushing',
            run: () => then(api.taskAction(t.id, 'complete')),
          };
          const fixes: InboxAct[] = flagged
            ? [
                {
                  key: 'f',
                  label: 'Send findings back',
                  hint: 'the same session applies the blocker/major fixes',
                  tone: 'primary',
                  icon: <IconAnalyze />,
                  run: () => then(api.applyReview(t.id)),
                },
              ]
            : [];
          const opener = open(t).map((a): InboxAct => (item.ready || flagged ? a : { ...a, tone: 'primary' }));
          return [...fixes, publish, done, ...opener];
        }
        case 'failed': {
          // Retry = a fresh agent; Resume = the same session. A turn the
          // ACCOUNT stopped (docs/wake.md) is the one Resume exists for, so it
          // is offered — and leads — only then.
          const limit = limitStopped(item.task);
          const retry: InboxAct = {
            key: 'r',
            label: 'Retry',
            hint: 'a fresh agent, told what the last attempt hit',
            tone: limit ? undefined : 'primary',
            run: () => then(api.taskAction(item.task.id, 'retry')),
          };
          const resume: InboxAct = {
            key: 'p',
            label: 'Resume',
            hint: 'the same session, where the usage limit stopped it',
            tone: 'primary',
            run: () => then(api.proceed(item.task.id)),
          };
          return [...(limit ? [resume, retry] : [retry]), ...open(item.task)];
        }
        case 'blocked':
          return [
            {
              key: 'a',
              label: 'Unblock',
              hint: 'move the parent to review as it stands',
              tone: 'primary',
              run: () => then(api.taskAction(item.task.id, 'unblock')),
            },
            ...open(item.task),
          ];
        case 'proposal': {
          const options = item.proposal.payload.options?.length ?? 0;
          return [
            {
              key: 'a',
              label: 'Accept',
              hint: options ? 'pick one of the options below' : undefined,
              tone: 'primary',
              disabled: options > 0,
              run: () => then(api.acceptProposal(item.proposal.id)),
            },
            { key: 'x', label: 'Reject', tone: 'danger', run: () => then(api.rejectProposal(item.proposal.id)) },
            ...open(item.task),
          ];
        }
        case 'feature':
          return [
            {
              key: 'a',
              label: 'Approve plan',
              hint: 'creates its tasks',
              tone: 'primary',
              run: () => then(api.approveFeature(item.feature.id)),
            },
            { key: 'o', label: 'Open', hint: 'the plan', run: () => navigate(`/features/${item.feature.id}`) },
          ];
        case 'stale-draft': {
          // Keep / Hide / Cancel (docs/inbox.md § Stale drafts) — a surface,
          // never a sweep: nothing here happens without the human's press.
          const t = item.task;
          return [
            {
              key: 'l',
              label: 'Keep',
              hint: `off this list for ${keepDays} days, still on the board`,
              tone: 'primary',
              icon: <IconCheck />,
              run: () => then(api.keepDraft(t.id)),
            },
            {
              key: 'h',
              label: 'Hide',
              hint: "off the board's sections and this list (Board › Hidden brings it back)",
              icon: <IconEye />,
              run: () => then(api.taskAction(t.id, 'hide')),
            },
            {
              key: 'x',
              label: 'Cancel',
              hint: 'close it as cancelled — stale draft triage',
              tone: 'danger',
              confirm: () => window.confirm(`Cancel “${t.title}”? It is closed as cancelled (stale draft triage).`),
              run: () => then(api.cancelTask(t.id, CANCEL_STALE_REASON)),
            },
            ...open(t),
          ];
        }
      }
    },
    [nav, navigate, refresh, keepDays],
  );
}

/** Runs one act at a time per surface; a refusal goes to the shared toast. */
export function useActRunner() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (itemKey: string, act: InboxAct, onDone?: () => void) => {
      if (act.disabled || busy) return;
      if (act.confirm && !act.confirm()) return;
      setBusy(itemKey);
      try {
        await act.run();
        onDone?.();
      } catch (e) {
        toastError(e, act.label);
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );
  return { busy, run };
}

/** One row: kind tag, title, repo, the one-line summary. */
export function InboxRowHead({ item, bare = false }: { item: InboxItem; bare?: boolean }) {
  const { repos } = useApp();
  const t = itemTask(item);
  const repoId =
    item.kind === 'proposal'
      ? item.proposal.repoId
      : item.kind === 'feature'
        ? item.feature.repoId
        : item.kind === 'approval'
          ? item.approval.repoId
          : item.task.repoId;
  const repo = repos.find((r) => r.id === repoId);
  return (
    <>
      <span className="inbox-line">
        <span className={`inbox-kind k-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        {!bare && <span className="inbox-title">{itemTitle(item)}</span>}
        {repo && <span className="inbox-repo">{repo.name}</span>}
        {item.unblocks > 0 && (
          <span className="inbox-frees" title="open tasks waiting on this one (later feature phases, blocked parents)">
            frees {item.unblocks}
          </span>
        )}
        {t && t.costUsd > 0 && <TaskCostChip costUsd={t.costUsd} />}
        {t && <TaskAttemptsChip attempts={t.attempts} quiet />}
      </span>
      {!bare && <span className="inbox-summary">{itemSummary(item)}</span>}
    </>
  );
}

/** Everything the decision needs, inline: checks, verdict, findings, the error, the options. */
export function InboxDetail({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'question':
      return (
        <div className="inbox-detail">
          {item.questions.map((q) => (
            <QuestionForm key={q.id} question={q} />
          ))}
        </div>
      );
    case 'approval':
      return (
        <div className="inbox-detail">
          <pre className="inbox-pre">{item.approval.summary}</pre>
          <Block label="Why">{item.approval.reason}</Block>
        </div>
      );
    case 'review':
      return <ReviewDetail task={item.task} ready={item.ready} />;
    case 'failed':
    case 'blocked':
      return (
        <div className="inbox-detail">
          {item.task.error ? (
            <pre className="inbox-pre">{item.task.error}</pre>
          ) : (
            <div className="hint">No error recorded.</div>
          )}
          {item.task.resultSummary && <Block label="Last words">{item.task.resultSummary}</Block>}
        </div>
      );
    case 'attention':
      return (
        <div className="inbox-detail hint">
          A hidden terminal is showing a dialog (a permission prompt, most likely). Open its terminal and answer it
          there.
        </div>
      );
    case 'proposal':
      return <ProposalDetail item={item} />;
    case 'stale-draft':
      return (
        <div className="inbox-detail">
          {item.task.brief && <Block label="Brief">{item.task.brief}</Block>}
          {item.task.description ? (
            <Block label="Description">
              {item.task.description.length > 1200 ? `${item.task.description.slice(0, 1200)}…` : item.task.description}
            </Block>
          ) : (
            <div className="hint">No description.</div>
          )}
        </div>
      );
    case 'feature':
      return (
        <div className="inbox-detail">
          {(item.feature.analysis?.phases ?? []).map((ph, i) => (
            <div key={i} className="inbox-phase">
              <span className="label">Phase {i + 1}</span>
              <ul className="inbox-list">
                {ph.tasks
                  .filter((c) => !c.excluded)
                  .map((c, j) => (
                    <li key={j}>{c.title}</li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      );
  }
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inbox-block">
      <span className="label">{label}</span>
      <div className="inbox-text">{children}</div>
    </div>
  );
}

function ReviewDetail({ task, ready }: { task: Task; ready: string | null }) {
  const last = task.reviewRounds[task.reviewRounds.length - 1] ?? null;
  const headline = reviewHeadline(task);
  const stat = lastDiffStat(task);
  return (
    <div className="inbox-detail">
      <div className="inbox-facts">
        {ready && <span className="chip verdict v-clean">✓ {ready}</span>}
        {stat && (
          <span className="chip mono" title="files touched, lines added and removed — the diff the reviewer read">
            {statText(stat)}
          </span>
        )}
        {headline && <span className={`chip verdict ${headline.cls}`}>{headline.text}</span>}
      </div>
      {task.checkResults.length > 0 && (
        <div className="inbox-checks">
          {task.checkResults.map((c) => (
            <span key={c.name} className={`inbox-check c-${c.outcome}`} title={c.error ?? c.command}>
              {c.outcome === 'green' ? '✓' : c.outcome === 'red' ? '✗' : '⚠'} {c.name}
              {c.outcome === 'red' && c.exit != null ? ` (exit ${c.exit})` : ''}
              {c.retried ? ' · re-run' : ''}
            </span>
          ))}
        </div>
      )}
      {last?.summary && <Block label="Reviewer">{last.summary}</Block>}
      {last && last.findings.length > 0 && (
        <ul className="inbox-findings">
          {last.findings.map((f, i) => (
            <li key={i} className={`sev-${f.severity}`}>
              <span className="inbox-sev">{f.severity}</span> {f.summary}
            </li>
          ))}
        </ul>
      )}
      {!last?.summary && task.resultSummary && <Block label="Agent">{task.resultSummary}</Block>}
    </div>
  );
}

function ProposalDetail({ item }: { item: Extract<InboxItem, { kind: 'proposal' }> }) {
  const { refresh } = useApp();
  const p = item.proposal.payload;
  const [busy, setBusy] = useState(false);
  const choose = async (i: number) => {
    setBusy(true);
    try {
      await api.acceptProposal(item.proposal.id, i);
      await refresh();
    } catch (e) {
      toastError(e, 'Accept');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-detail">
      {p.description && <Block label="Description">{p.description}</Block>}
      <Block label="Why">{p.rationale}</Block>
      {p.subtasks && p.subtasks.length > 0 && (
        <ul className="inbox-list">
          {p.subtasks.map((s, i) => (
            <li key={i}>{s.title}</li>
          ))}
        </ul>
      )}
      {p.options && p.options.length > 0 && (
        <div className="inbox-options">
          {p.options.map((o, i) => (
            <button key={i} type="button" className="btn inbox-option" disabled={busy} onClick={() => choose(i)}>
              <b>{o.label}</b>
              <span className="hint">{o.approach}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Header chip: how many decisions wait (docs/inbox.md). Hidden at zero.
 * `urgentOnly` (the phone, whose Inbox tab carries the full count): only the
 * questions and needs-attention items, hidden while there are none.
 */
export function InboxChip({
  onClick,
  compact = false,
  urgentOnly = false,
}: {
  onClick: () => void;
  compact?: boolean;
  urgentOnly?: boolean;
}) {
  const all = decisions(useInbox());
  const urgentItems = all.filter((i) => i.kind === 'question' || i.kind === 'attention');
  const items = urgentOnly ? urgentItems : all;
  const n = items.length;
  if (n === 0) return null;
  const urgent = urgentItems.length > 0;
  return (
    <button
      type="button"
      className={`btn ghost ichip${urgent ? ' urgent' : ''}`}
      title={`${n} item${n === 1 ? '' : 's'} waiting on you — the Inbox`}
      aria-label={urgentOnly ? `${n} urgent in the Inbox` : `Inbox, ${n} waiting`}
      onClick={onClick}
    >
      <IconInbox /> {n}
      {!compact && <span className="ichip-word">{n === 1 ? ' decision' : ' decisions'}</span>}
    </button>
  );
}

/**
 * The phone's Inbox (docs/mobile.md § Sheets): a sheet of rows; a row opens
 * its own sheet ON TOP with the detail and the actions, so the list is where
 * you return to after each decision.
 */
export function InboxSheet({
  onClose,
  nav,
  initialKey = null,
}: {
  onClose: () => void;
  nav: InboxNav;
  /** the item to reopen on top — the one a terminal was opened from */
  initialKey?: string | null;
}) {
  const items = useInbox();
  const [openKey, setOpenKey] = useState<string | null>(initialKey);
  const open = items.find((i) => i.key === openKey) ?? null;
  // opening a task or terminal leaves the inbox: both stacks would fight for the screen
  const leave = useMemo<InboxNav>(
    () => ({
      onOpenTask: (id) => {
        onClose();
        nav.onOpenTask(id);
      },
      // …and closing the terminal comes back to THIS sheet, on the same item
      onOpenTerminal: (runId, from) => {
        onClose();
        nav.onOpenTerminal(runId, from?.kind === 'inbox' ? { ...from, sheet: true } : from);
      },
    }),
    [nav, onClose],
  );
  return (
    <>
      <Sheet label="Inbox" title={`Inbox · ${decisions(items).length}`} onClose={onClose} tall>
        <InboxRows items={items} onPick={(i) => setOpenKey(i.key)} />
      </Sheet>
      {open && <InboxItemSheet item={open} nav={leave} onClose={() => setOpenKey(null)} />}
    </>
  );
}

export function InboxRows({ items, onPick }: { items: InboxItem[]; onPick: (i: InboxItem) => void }) {
  if (!items.length) return <div className="inbox-empty">Nothing is waiting on you.</div>;
  return (
    <div className="inbox-rows">
      {items.map((i) => (
        <button key={i.key} type="button" className="inbox-row" onClick={() => onPick(i)}>
          <InboxRowHead item={i} />
        </button>
      ))}
      <StaleDraftsFooter items={items} />
    </div>
  );
}

/**
 * Under the stale drafts (docs/inbox.md § Stale drafts): how many are listed
 * of how many there are, and Keep/Hide for every one LISTED in one bulk call
 * (`POST /api/tasks/bulk`). No bulk Cancel — closing work stays one press per
 * task. Nothing when there are no stale drafts.
 */
export function StaleDraftsFooter({ items }: { items: InboxItem[] }) {
  const { refresh, settings } = useApp();
  const [busy, setBusy] = useState(false);
  const stale = items.filter((i): i is Extract<InboxItem, { kind: 'stale-draft' }> => i.kind === 'stale-draft');
  if (!stale.length) return null;
  const total = stale[0].total;
  const more = total - stale.length;
  const ids = stale.map((i) => i.task.id);
  const bulk = async (action: 'keep' | 'hide') => {
    if (action === 'hide' && !window.confirm(`Hide the ${ids.length} stale draft(s) listed? Board › Hidden brings them back.`))
      return;
    setBusy(true);
    try {
      const r = await api.bulkTasks({ action, ids });
      if (r.failed) toastError(new Error(`${r.failed} of ${ids.length} refused`), action === 'keep' ? 'Keep all' : 'Hide all');
      await refresh();
    } catch (e) {
      toastError(e, action === 'keep' ? 'Keep all' : 'Hide all');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-stale-foot">
      <span className="hint">
        {more > 0
          ? `${stale.length} of ${total} stale drafts — ${more} more come up as these are triaged`
          : `${total} stale draft${total === 1 ? '' : 's'}`}{' '}
        · older than {staleDays(settings)} days
      </span>
      <span className="inbox-stale-acts">
        <button type="button" className="btn" disabled={busy} onClick={() => void bulk('keep')}>
          Keep all {stale.length}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void bulk('hide')}>
          Hide all {stale.length}
        </button>
      </span>
    </div>
  );
}

const ACT_ICON: Record<InboxAct['key'], ReactNode> = {
  a: <IconCheck />,
  d: <IconCheck />,
  f: <IconAnalyze />,
  r: <IconRefresh />,
  p: <IconPlay />,
  x: <IconX />,
  t: <IconTerminal />,
  o: <IconMore />,
  l: <IconCheck />,
  h: <IconEye />,
};

/** One item's sheet, stacked above the list: detail, then the actions. */
export function InboxItemSheet({ item, nav, onClose }: { item: InboxItem; nav: InboxNav; onClose: () => void }) {
  const actsFor = useInboxActs(nav);
  const { busy, run } = useActRunner();
  return (
    <Sheet label={itemTitle(item)} title={itemTitle(item)} onClose={onClose} zIndex={36}>
      <div className="inbox-sheet-meta">
        <InboxRowHead item={item} bare />
      </div>
      <InboxDetail item={item} />
      <div className="inbox-sheet-acts">
        {actsFor(item).map((a) => (
          <SheetAction
            key={a.key}
            icon={a.icon ?? ACT_ICON[a.key]}
            label={a.label}
            hint={a.hint}
            tone={a.tone}
            disabled={a.disabled || busy !== null}
            // the sheet goes once the decision is made — and before a task panel
            // or terminal opens, so two stacks never share the screen
            onClick={() => run(item.key, a, onClose)}
          />
        ))}
      </div>
    </Sheet>
  );
}
