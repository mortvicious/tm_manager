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
 */
export const REPO_EXCLUSIVE_GATE = repoHasRoom(
  'x',
  `(x.status IN ('running', 'waiting')
           OR x.paused_turn IS NOT NULL
           OR (x.status = 'review' AND (x.review_state IN ('pending', 'reviewing', 'fixing')
                                         OR x.check_state IN ('pending', 'running'))))`,
);
