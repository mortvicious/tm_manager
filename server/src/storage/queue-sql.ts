// Custom-queue SQL fragments shared VERBATIM by both drivers (docs/queue.md),
// the same arrangement as feature-sql.ts: dialect-neutral, no `?` placeholders,
// fixed `tm_` prefix. Both drivers must agree on what "the head of the custom
// queue" and "the custom queue is busy" mean, or SQLite and Postgres would
// serialize differently.

import { PARALLEL_MAX } from '@tm/shared';

/**
 * How many tasks may hold a repo at once (docs/parallel.md § The gate), for
 * the candidate's repo: `parallel` only for a `delivery = 'pr'` repo — each
 * of its tasks works in its own worktree — else 1. Out-of-range reads as 1,
 * like `rowToRepo`. JS twin: `repoParallelCap` in shared — edit together.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
const repoCapSql = (t: string) =>
  `COALESCE((SELECT CASE WHEN rp.delivery = 'pr' AND rp.parallel BETWEEN 2 AND ${PARALLEL_MAX} THEN rp.parallel ELSE 1 END
     FROM tm_repos rp WHERE rp.id = ${t}.repo_id), 1)`;

/**
 * "The candidate `t`'s repo has room for one more holder", where a holder is
 * another task of the repo matching `holder` (over alias `h`): no holder
 * works in the MAIN CHECKOUT (`workdir IS NULL` — that tree is one agent's),
 * and fewer holders than the cap. With cap 1 — every `direct` repo — this is
 * exactly the old `NOT EXISTS (holder)`. JS twin: `repoHasRoom` in shared.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
const repoHasRoom = (h: string, holder: string) =>
  `(NOT EXISTS (SELECT 1 FROM tm_tasks ${h}
      WHERE ${h}.repo_id = t.repo_id AND ${h}.id <> t.id AND ${h}.workdir IS NULL AND ${holder})
    AND (SELECT COUNT(*) FROM tm_tasks ${h}
      WHERE ${h}.repo_id = t.repo_id AND ${h}.id <> t.id AND ${holder}) < ${repoCapSql('t')})`;

/**
 * "This task still holds its repo's place" (docs/queue.md § When the next
 * member starts), over a row aliased `a`: it is working (`running`/`waiting`,
 * which also covers a turn inside the resume gate with no live PTY yet),
 * `blocked` on its split children, or in `review` with an automatic review
 * round still open (review_state pending/reviewing/fixing — its findings are
 * about to be typed back into a session in this checkout) or its repo checks
 * still due or running (check_state pending/running, docs/checks.md — they
 * read this checkout), or owed a turn by Pause all (`paused_turn`,
 * docs/pause.md — Continue resumes it in this checkout).
 *
 * Finished work that merely sits in `review` for the human does NOT hold it
 * (decisions.md 2026-09-28, "Review no longer holds the custom queue"): the
 * task stays in `review`, keeps its mark, and the next member starts on top of
 * its tree. That is a deliberate trade — the next agent works in a checkout
 * with the previous change still in it (committed or not), and a Publish of the
 * first task while the next one is running will not find a clean tree.
 * JS twin: `customQueueHoldsRepo` in shared/src/types.ts — edit together.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
const heldBy = (a: string) =>
  `(${a}.status IN ('running', 'waiting', 'blocked')
      OR ${a}.paused_turn IS NOT NULL
      OR (${a}.status = 'review' AND (${a}.review_state IN ('pending', 'reviewing', 'fixing')
                                       OR ${a}.check_state IN ('pending', 'running'))))`;

/**
 * Per-repo cap (docs/parallel.md § The gate): every "no other task holds the
 * repo" clause below is `repoHasRoom` — a `pr` repo with `parallel` N admits
 * up to N holders, each in its own worktree; the paused-turn and member
 * clauses count together as one holder set.
 *
 * Selects the head of the custom queue: the oldest-added queued task that is
 * a member (`custom_queue_at` set), has a repo, is not held by an Undo start
 * (`queue_held_at`, docs/queue.md § Undo start), passes the feature phase
 * gate, AND whose repo has no other member still holding it (`heldBy`), while
 * members of OTHER repos may go ahead. Priority is deliberately NOT consulted
 * — the custom queue is a FIFO of what the human added.
 *
 * A member an AGENT created (`created_by_run` set — a request filed through
 * the shared ledger, docs/shared-spaces.md § Filing) waits for more:
 *  - for its FILER (the task behind `created_by_run`, same repo) to stop
 *    holding the repo — or to be `failed`: a filer that crashed after filing
 *    may have left its edits behind, and a retry or cancel resolves it.
 *  - for ANY task in the repo, member or not, that holds it by the same
 *    `heldBy` test (a global-queue filer's open review round included).
 * And for any task in its repo, member or not, that Pause all owes a turn
 * (`paused_turn`, docs/pause.md): Continue resumes it in this checkout.
 * The caller interpolates the gate; expects the candidate row aliased `t`.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export const CUSTOM_QUEUE_HEAD_WHERE = `t.status = 'queued' AND t.repo_id IS NOT NULL AND t.custom_queue_at IS NOT NULL
  AND t.queue_held_at IS NULL
  AND ${repoHasRoom('o', `(o.paused_turn IS NOT NULL OR (o.custom_queue_at IS NOT NULL AND ${heldBy('o')}))`)}
  AND (t.created_by_run IS NULL OR (
    NOT EXISTS (
      SELECT 1 FROM tm_runs r JOIN tm_tasks f ON f.id = r.task_id
      WHERE r.id = t.created_by_run AND f.id <> t.id AND f.repo_id = t.repo_id
        AND (f.status = 'failed' OR ${heldBy('f')})
    )
    AND ${repoHasRoom('a', heldBy('a'))}
  ))`;

// The custom queue's ONE order. A reorder (`POST /api/tasks/:id/queue-move`,
// planQueueReorder below) rewrites `custom_queue_at` itself, so this clause
// and its JS twin `customQueueWaiting` need no change for it.
// JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
export const CUSTOM_QUEUE_HEAD_ORDER = `ORDER BY t.custom_queue_at, t.created_at LIMIT 1`;

/**
 * The claim's "same repo as the row being claimed" clause, over the candidate
 * aliased `t`; binds ONE `?` (the claimed id). With CUSTOM_QUEUE_HEAD_ORDER it
 * makes the by-id claim succeed only for the head of that repo, so it can
 * never jump an older same-repo member.
 */
export const CUSTOM_QUEUE_SAME_REPO = `t.repo_id = (SELECT c.repo_id FROM tm_tasks c WHERE c.id = ?)`;

/**
 * The custom queue is serial PER REPO, never across repos (decisions.md
 * 2026-10-22, "The custom queue is one task per repo"): `heldBy('o')` in
 * CUSTOM_QUEUE_HEAD_WHERE is the whole per-repo test — a same-repo member that
 * is `running` (claimed, run-now'd, mid fix round or publish turn) holds the
 * repo — and members of other repos go ahead in parallel, up to
 * `orchestrator.concurrency`. There is deliberately no "no member is running
 * anywhere" clause any more; that was the old strictly-serial queue, under
 * which a nest member waited for a next member in another repo.
 *
 * `skipRepos(n)` excludes repos the orchestrator already knows are taken this
 * pass (an in-process follow-on hold, a busy repo, a repo just claimed): `n`
 * `?` placeholders, the caller binds the ids. Empty → no clause at all (`NOT
 * IN ()` is invalid on Postgres).
 */
export const skipRepos = (n: number) =>
  n > 0 ? ` AND t.repo_id NOT IN (${Array.from({ length: n }, () => '?').join(', ')})` : '';

/**
 * Same-repo exclusivity for the GLOBAL claim and the overflow claim
 * (docs/queue.md § Same-repo exclusivity), over the candidate aliased `t`: no
 * other task in its repo may be working (`running`/`waiting` — which also
 * covers a turn inside the resume gate with no PTY yet) or in `review` with an
 * automatic review round open (the reviewer is reading that checkout, and its
 * findings are about to be typed back into a session there) or its repo checks
 * due/running (docs/checks.md — they read that checkout too), or owed a turn
 * by Pause all (`paused_turn`, docs/pause.md). `blocked` is
 * deliberately absent, unlike `heldBy`: a split parent waits on children in
 * its own repo, and holding the repo for it would deadlock them.
 * JS twin: `holdsRepoForClaim` in shared/src/types.ts — edit together.
 * Per-repo cap (docs/parallel.md § The gate): "no other" is `repoHasRoom` —
 * fewer holders than the repo's cap, and none in the main checkout.
 * JS twin: predictSchedule (shared/src/schedule.ts) — the schedule simulator; edit together.
 */
export const REPO_EXCLUSIVE_GATE = repoHasRoom(
  'x',
  `(x.status IN ('running', 'waiting')
           OR x.paused_turn IS NOT NULL
           OR (x.status = 'review' AND (x.review_state IN ('pending', 'reviewing', 'fixing')
                                         OR x.check_state IN ('pending', 'running'))))`,
);

/**
 * Custom-queue reorder (docs/queue.md § Reordering). The order IS
 * `custom_queue_at` (then `created_at`) — CUSTOM_QUEUE_HEAD_ORDER above and
 * `customQueueWaiting` in shared both sort on it — so a reorder only rewrites
 * that column on WAITING members (`queued` + marked) and no claim SQL or JS
 * twin changes. A member that is running/review/blocked keeps its mark as is.
 *
 * The waiting set, in claim order. Both drivers read it inside the reorder's
 * transaction (Postgres appends FOR UPDATE).
 */
export const CUSTOM_QUEUE_WAITING_SQL = `SELECT id, custom_queue_at, created_at FROM tm_tasks
  WHERE status = 'queued' AND custom_queue_at IS NOT NULL
  ORDER BY custom_queue_at, created_at`;

export type QueueMoveAnchor = { side: 'before' | 'after'; targetId: string } | 'first' | 'last';

export interface QueueOrderRow {
  id: string;
  custom_queue_at: string;
  created_at: string;
}

export type QueueReorderPlan =
  | { refused: string }
  | { writes: { id: string; at: string }[]; renumbered: boolean; before: string; after: string };

/**
 * Where the moved member's new mark goes — pure, so both drivers run the same
 * decision. `task` is the moved row (null = not found is the caller's), and
 * `waiting` is CUSTOM_QUEUE_WAITING_SQL's result.
 *
 * - A millisecond midpoint strictly between the new neighbours when their gap
 *   is ≥ 2 ms: one row written.
 * - Otherwise (tie, gap < 2 ms, or no neighbour on one side — 'first'/'last'
 *   and the ends) the whole waiting set is renumbered evenly WITHIN its
 *   current [min, max] span in the new order, ties having been broken by the
 *   current order. Only when that span is narrower than one ms per member
 *   (marks stamped in the same millisecond) does it reach back before `min`,
 *   by the fewest ms that keep every mark distinct — never forward, where a
 *   later "Add to queue" click must still land behind.
 *
 * JS twin: planQueueDrop (shared/src/queue-drop.ts) predicts these marks for a
 * timeline drag before the server answers; edit together.
 */
export function planQueueReorder(
  task: { id: string; status: string; custom_queue_at: string | null },
  waiting: QueueOrderRow[],
  anchor: QueueMoveAnchor,
): QueueReorderPlan {
  if (!task.custom_queue_at) return { refused: 'task is not in the custom queue' };
  if (task.status !== 'queued') return { refused: `only a waiting member can move (task is ${task.status})` };
  // Same tie-break as customQueueWaiting, whatever order the driver returned.
  const rows = [...waiting].sort(
    (a, b) => cmp(a.custom_queue_at, b.custom_queue_at) || cmp(a.created_at, b.created_at),
  );
  const self = rows.find((r) => r.id === task.id);
  if (!self) return { refused: 'task is not waiting in the custom queue' };
  const others = rows.filter((r) => r.id !== task.id);
  let at: number;
  if (anchor === 'first') at = 0;
  else if (anchor === 'last') at = others.length;
  else {
    if (anchor.targetId === task.id) return { refused: 'a task cannot be moved relative to itself' };
    const i = others.findIndex((r) => r.id === anchor.targetId);
    if (i === -1) return { refused: 'target is not waiting in the custom queue' };
    at = anchor.side === 'before' ? i : i + 1;
  }
  const order = [...others.slice(0, at), self, ...others.slice(at)];
  const unchanged = order.every((r, i) => r.id === rows[i].id);
  if (unchanged) return { writes: [], renumbered: false, before: self.custom_queue_at, after: self.custom_queue_at };
  const ms = rows.map((r) => Date.parse(r.custom_queue_at));
  if (ms.some((v) => Number.isNaN(v))) return { refused: 'a custom-queue mark is not a timestamp' };
  const lo = others[at - 1];
  const hi = others[at];
  if (lo && hi) {
    const a = Date.parse(lo.custom_queue_at);
    const b = Date.parse(hi.custom_queue_at);
    if (b - a >= 2) {
      const iso = new Date(a + Math.floor((b - a) / 2)).toISOString();
      return { writes: [{ id: self.id, at: iso }], renumbered: false, before: self.custom_queue_at, after: iso };
    }
  }
  const n = order.length;
  const min = ms[0];
  const max = ms[n - 1];
  const span = max - min;
  const start = span >= n - 1 ? min : max - (n - 1);
  const width = Math.max(span, n - 1);
  const writes: { id: string; at: string }[] = [];
  let after = self.custom_queue_at;
  order.forEach((r, i) => {
    const iso = new Date(start + Math.floor((i * width) / (n - 1))).toISOString();
    if (r.id === self.id) after = iso;
    if (iso !== r.custom_queue_at) writes.push({ id: r.id, at: iso });
  });
  return { writes, renumbered: true, before: self.custom_queue_at, after };
}

/** The `task.queue` audit row's data for a reorder that moved something. */
export function reorderAudit(
  anchor: QueueMoveAnchor,
  plan: Extract<QueueReorderPlan, { writes: unknown }>,
): Record<string, unknown> {
  return {
    queue: 'custom',
    action: 'reorder',
    place: typeof anchor === 'string' ? anchor : anchor.side,
    targetId: typeof anchor === 'string' ? undefined : anchor.targetId,
    before: plan.before,
    after: plan.after,
    renumbered: plan.renumbered ? plan.writes.length : undefined,
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
