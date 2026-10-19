/**
 * Worker StopFailure (docs/design.md § Transient API errors): what a turn that
 * the API ended — rather than the agent — should become.
 *
 * The codes are the CLI's own `error` field on the StopFailure payload, never
 * free text (the same rule `modelUnavailable` follows for aux sessions).
 * Measured against claude 2.1.280: the hook's matcher list is
 * `rate_limit, overloaded, authentication_failed, oauth_org_not_allowed,
 * account_on_hold, verification_required, billing_error, invalid_request,
 * model_not_found, server_error, max_output_tokens, cloud_credential_error,
 * unknown`. The CLI folds every 5xx, "API at capacity", a dropped connection
 * (ECONNRESET & co.), a response that never arrived and a mid-stream server
 * error into `server_error`; 529 is `overloaded`. Those two are exactly the
 * set the CLI itself treats as transient (`isTransient`), so they are ours.
 *
 * `rate_limit` is deliberately NOT transient here: it is how the 5h/weekly
 * usage window reports itself, which the wake path (claude/limit.ts,
 * docs/wake.md) owns — it reads the banner and the account's own window and
 * parks the task until the reset. Resuming against an exhausted window would
 * race that parker for nothing.
 */

export type StopFailureClass = 'transient' | 'usage-limit' | 'fatal';

export const TRANSIENT_STOP_CODES: ReadonlySet<string> = new Set(['overloaded', 'server_error']);

export function classifyStopFailure(code: string): StopFailureClass {
  if (TRANSIENT_STOP_CODES.has(code)) return 'transient';
  if (code === 'rate_limit') return 'usage-limit';
  return 'fatal';
}

/** Back-off before automatic resume n (0-based). Its length is the per-turn cap. */
export const TRANSIENT_BACKOFF_MS: readonly number[] = [30_000, 120_000];

/** Text first, Enter after a beat — the aux runner's measured way of typing into a live prompt (aux.ts). */
export const TYPE_ENTER_DELAY_MS = 400;

/** How long after typing `continue` the transcript must have grown, or the resume falls back to `--resume`. */
export const TRANSIENT_SUBMIT_CHECK_MS = 20_000;

/**
 * What the agent is told — one line, because it is TYPED into the live
 * terminal (newlines would submit early) and is also the `--resume` follow-up.
 */
export const TRANSIENT_CONTINUE =
  'continue — your previous request ended on a transient API error, not on anything you did; pick up exactly where you left off.';

/** The `error` a task lands with when its turn cannot be resumed automatically. */
export function stopFailureError(code: string, details: string | null, why: 'fatal' | 'exhausted', resumes: number): string {
  const what = details ? `${code}: ${details}` : code;
  return why === 'exhausted'
    ? `API error (${what}) persisted after ${resumes} automatic resume${resumes === 1 ? '' : 's'} — Proceed resumes this session, Retry starts a fresh one with what it left behind`
    : `the API ended the turn (${what}) — not a transient error, so it was not resumed automatically; Proceed resumes this session once the cause is fixed`;
}
