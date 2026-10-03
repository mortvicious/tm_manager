import { REPORT_TASK_CAP, type ReportLanguage, type Repo, type Report, type Task } from '@tm/shared';
import {
  READ_ONLY_DISALLOWED,
  aux,
  extractJson,
  resultInstruction,
  withModelFallback,
  type AuxOutcome,
} from '../claude/aux.ts';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { reportStrings } from './language.ts';
import { dayKeyOf, endOfDay, formatDay, startOfDay } from './range.ts';

/**
 * Reports (docs/reports.md): one claude session turns the task rows that
 * FINISHED inside a window into the document you hand to whoever paid for the
 * work — Russian, grouped by completion date, one concise business-language
 * bullet per delivered change.
 *
 * The session is an aux terminal (kind `report`, subject = the report —
 * docs/design.md § PTY sessions): attachable from the runs list, and covered
 * by the restart guard and `/killall` like every other aux session. It never
 * takes a worker slot; MAX_CONCURRENT below is its own bound.
 */

/** A report is a rare, human-pressed button; one at a time is plenty and keeps
 *  a double-click from paying for the same document twice. */
const MAX_CONCURRENT = 1;

const CALL_TIMEOUT_MS = 10 * 60_000;

/** Per-task text budgets — the prompt must stay a prompt, not a dump. */
const TITLE_CHARS = 200;
const DESC_CHARS = 700;
const SUMMARY_CHARS = 1200;

/**
 * Transitions read to date the finished tasks. Generous: the query is already
 * bounded by the window, and truncation here drops the OLDEST events, which on
 * a wide report is precisely the part the document is about.
 */
const TRANSITION_LIMIT = 20_000;

/** `done` and `published` only. `failed`/`cancelled` are in
 *  TERMINAL_TASK_STATUSES but did not deliver anything, and a report of
 *  delivered work must not list them (same test as telegram/report.ts). */
const DELIVERED = new Set(['done', 'published']);

/**
 * reportId -> the abort handle of its session, so deleting a report can stop
 * paying for it. A signal rather than a run id: a delete that lands before the
 * session is spawned still stops it (the runner refuses an aborted signal).
 */
const inFlight = new Map<string, AbortController>();

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * The schema is rebuilt per language so the field descriptions are themselves
 * in the target language — the model is told what to write in twice, in the
 * prompt and in the shape it must fill.
 */
function jsonSchema(lang: ReportLanguage): string {
  const t = reportStrings(lang);
  return JSON.stringify({
    type: 'object',
    properties: {
      summary: { type: 'string', description: t.summaryDesc },
      days: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: t.dateDesc },
            bullets: { type: 'array', items: { type: 'string' }, description: t.bulletsDesc },
          },
          required: ['date', 'bullets'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'days'],
    additionalProperties: false,
  });
}

export interface GatheredTask {
  task: Task;
  repo: Repo | undefined;
  /** local calendar day the task was DELIVERED on */
  day: string;
}

/**
 * The finished tasks of the selected repos, dated by when they actually landed.
 *
 * The completion date is read from the audit log — the `task.transition` row
 * that moved the task to `done`/`published` — and NOT from `updated_at`, which
 * keeps moving: a title fix, a category label or a late dispatch note months
 * later would silently re-date delivered work into the wrong section (and into
 * the wrong report entirely). `updated_at` is only the fallback for rows old
 * enough to predate their own transition event.
 */
export async function gatherTasks(
  storage: Storage,
  repoIds: string[],
  since: string,
  until: string,
): Promise<{ items: GatheredTask[]; dropped: number }> {
  const repos = new Map((await storage.listRepos()).map((r) => [r.id, r]));
  const scoped = (await storage.listTasks({ repoIds })).filter((t) => DELIVERED.has(t.status));
  if (scoped.length === 0) return { items: [], dropped: 0 };

  // Earliest landing per task. A task republished later (review → published)
  // is dated by the first time it was delivered, which is when the work
  // happened; a re-run that lands twice must not appear on two days.
  const landedAt = new Map<string, string>();
  const transitions = await storage.listEvents({ kind: 'task.transition', since, limit: TRANSITION_LIMIT });
  for (const e of transitions) {
    const to = (e.data as { to?: string } | null)?.to;
    if (!to || !DELIVERED.has(to)) continue;
    if (!e.taskId) continue;
    const prev = landedAt.get(e.taskId);
    if (!prev || e.at < prev) landedAt.set(e.taskId, e.at);
  }

  const items: GatheredTask[] = [];
  for (const task of scoped) {
    const at = landedAt.get(task.id) ?? task.updatedAt;
    if (at < since || at > until) continue;
    items.push({ task, repo: task.repoId ? repos.get(task.repoId) : undefined, day: dayKeyOf(at) });
  }
  items.sort((a, b) => a.day.localeCompare(b.day) || a.task.title.localeCompare(b.task.title));

  // Over the cap the OLDEST go: a report is read from its recent end, and a
  // truncation the document does not admit to would be a lie about the period.
  let dropped = 0;
  if (items.length > REPORT_TASK_CAP) {
    dropped = items.length - REPORT_TASK_CAP;
    items.splice(0, dropped);
  }
  return { items, dropped };
}

function buildPrompt(report: Report, repos: Repo[], items: GatheredTask[], dropped: number): string {
  const byDay = new Map<string, GatheredTask[]>();
  for (const it of items) {
    const list = byDay.get(it.day);
    if (list) list.push(it);
    else byDay.set(it.day, [it]);
  }

  const t = reportStrings(report.language);
  const lines: string[] = [];
  for (const [day, group] of byDay) {
    lines.push(`\n## ${day}`);
    for (const { task, repo } of group) {
      lines.push(`\n- ${t.fTask}: ${truncate(task.title, TITLE_CHARS)}`);
      lines.push(`  ${t.fRepo}: ${repo?.name ?? t.fRepoUnknown}${repo?.role ? ` (${repo.role})` : ''}`);
      if (task.category) lines.push(`  ${t.fCategory}: ${task.category}`);
      if (task.description) lines.push(`  ${t.fAsked}: ${truncate(task.description, DESC_CHARS)}`);
      if (task.resultSummary) lines.push(`  ${t.fDone}: ${truncate(task.resultSummary, SUMMARY_CHARS)}`);
      // The reviewer's own words about the change: an independent read of the
      // same work, and often the more accurate of the two.
      const reviewed = task.reviewRounds.filter((r) => r.summary).slice(-1)[0];
      if (reviewed?.summary) lines.push(`  ${t.fReview}: ${truncate(reviewed.summary, SUMMARY_CHARS)}`);
      else if (task.reviewSummary) lines.push(`  ${t.fReview}: ${truncate(task.reviewSummary, SUMMARY_CHARS)}`);
    }
  }

  const repoLine = repos.map((r) => (r.role ? `${r.name} (${r.role})` : r.name)).join(', ');

  return `${t.role}

${t.reposLine}: ${repoLine}
${t.periodLine}: ${formatDay(report.fromDate)} — ${formatDay(report.toDate)}
${t.tasksLine(items.length, dropped)}

${t.intro}

${t.rules}

${t.entries}:
${lines.join('\n')}
`;
}

interface ModelOutput {
  summary: string;
  days: { date: string; bullets: string[] }[];
}

/**
 * The document shape is assembled HERE, from validated pieces — the model only
 * writes prose. A malformed heading, an invented date or a day outside the
 * window cannot reach the file, and the "Репозитории / Даты" preamble the
 * reader relies on is always present and always true.
 */
export function renderMarkdown(report: Report, repos: Repo[], out: ModelOutput, validDays: Set<string>): string {
  const t = reportStrings(report.language);
  const repoLine = repos.map((r) => (r.role ? `${r.name} (${r.role})` : r.name)).join(', ');
  const lines: string[] = [
    `# ${report.title} — ${t.docSuffix}`,
    '',
    `${t.reposLabel}: ${repoLine}. ${t.datesNote}`,
    `${t.periodLabel}: ${formatDay(report.fromDate)} — ${formatDay(report.toDate)}.`,
  ];
  if (out.summary.trim()) {
    lines.push('', out.summary.trim());
  }

  const days = out.days
    .filter((d) => validDays.has(d.date))
    .map((d) => ({ date: d.date, bullets: d.bullets.map((b) => b.trim()).filter(Boolean) }))
    .filter((d) => d.bullets.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const d of days) {
    lines.push('', `### ${formatDay(d.date)}`);
    for (const b of d.bullets) lines.push(`- ${b.replace(/^[-*•]\s*/, '')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function runReport(opts: {
  report: Report;
  repoId: string;
  cwd: string;
  model: string;
  effort: string | null;
  prompt: string;
  schema: string;
  label: string;
  signal: AbortSignal;
}): Promise<AuxOutcome<unknown>> {
  return aux().run<unknown>({
    kind: 'report',
    subjectId: opts.report.id,
    repoId: opts.repoId,
    label: opts.label,
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    prompt: opts.prompt + '\n' + resultInstruction(opts.schema),
    // A report is a pure text transformation over rows this process already
    // read: it has no business touching a repo at all, so it is given NO
    // built-in tool (`--tools=`), and the denials stay as belt and braces.
    tools: [],
    disallowedTools: READ_ONLY_DISALLOWED,
    permission: 'dontAsk',
    lean: true,
    timeoutMs: CALL_TIMEOUT_MS,
    accept: (text) => {
      const parsed = parseOutput(text);
      return parsed ? { ok: true, value: parsed } : { ok: false, error: 'expected {"summary", "days": [{"date", "bullets"}]}' };
    },
    signal: opts.signal,
  });
}

/**
 * Writes the row, never throws. Returns false when the report is gone — a
 * human deleted it mid-run, and nothing more should be said about it.
 */
async function settle(storage: Storage, id: string, patch: Parameters<Storage['updateReport']>[1]): Promise<boolean> {
  const row = await storage.updateReport(id, patch);
  if (!row) return false;
  broadcast({ type: 'report.updated', report: row });
  return true;
}

/**
 * Generate (or re-generate) a report. Resolves when the document has landed or
 * failed; the route does not await it, because a claude turn outlives any HTTP
 * timeout and the SPA follows the row over `/ws/events` instead.
 */
export async function generateReport(storage: Storage, id: string): Promise<void> {
  if (inFlight.has(id)) return;
  if (inFlight.size >= MAX_CONCURRENT) {
    await settle(storage, id, { status: 'failed', error: 'another report is still being written — try again in a moment' });
    return;
  }
  const ctl = new AbortController();
  inFlight.set(id, ctl);
  try {
    const report = await storage.getReport(id);
    if (!report) return;
    if (!(await settle(storage, id, { status: 'running', error: null }))) return;

    const allRepos = await storage.listRepos();
    const repos = report.repoIds
      .map((rid) => allRepos.find((r) => r.id === rid))
      .filter((r): r is Repo => r !== undefined);
    if (repos.length === 0) {
      await settle(storage, id, { status: 'failed', error: 'none of the selected repos exist any more' });
      return;
    }

    const since = startOfDay(report.fromDate).toISOString();
    const until = endOfDay(report.toDate).toISOString();
    const { items, dropped } = await gatherTasks(storage, report.repoIds, since, until);

    // Nothing delivered in the window is a legitimate ANSWER, not a failure —
    // and it costs nothing, so no agent is spawned for it.
    if (items.length === 0) {
      const nothing = reportStrings(report.language).nothing;
      await settle(storage, id, {
        status: 'ready',
        markdown: renderMarkdown(report, repos, { summary: nothing, days: [] }, new Set()),
        summary: nothing,
        taskCount: 0,
        error: null,
      });
      return;
    }

    const settings = await storage.getSettings();
    const requested = report.model || settings['analysis.model'];
    const prompt = buildPrompt(report, repos, items, dropped);
    const schema = jsonSchema(report.language);
    const label = `report: ${report.title}`;
    // cwd only has to exist and be readable: the session has no tools, so the
    // agent never looks at it. The first selected repo keeps it meaningful
    // (and is a folder the CLI already trusts, so no trust dialog blocks it).
    const cwd = repos[0].path;
    // Fable → Opus 5.5 xhigh on `model_not_found` only — the shared
    // `withModelFallback` (aux.ts); no second run for a report deleted mid-run.
    const { res, model } = await withModelFallback(
      { model: requested, effort: null },
      'xhigh',
      (m, effort) =>
        runReport({ report, repoId: repos[0].id, cwd, model: m, effort, prompt, schema, label, signal: ctl.signal }),
      () => inFlight.has(id),
    );

    // Deleted while the session ran.
    if (!inFlight.has(id)) return;
    if (res.status === 'aborted') {
      // Killed from the runs list, or by /killall or a shutdown.
      await settle(storage, id, { status: 'failed', error: 'the report session was stopped', model });
      return;
    }
    if (res.status !== 'ok' || !res.value) {
      await settle(storage, id, {
        status: 'failed',
        error: `report agent failed: ${truncate(res.error ?? 'no output', 400)}`,
        model,
      });
      return;
    }
    const parsed = res.value as ModelOutput;

    const validDays = new Set(items.map((i) => i.day));
    const markdown = renderMarkdown(report, repos, parsed, validDays);
    // Every day the model wrote was outside the window (or it wrote none):
    // the document would be a heading with no work under it, which is worse
    // than an honest failure the human can re-run.
    if (!/^### /m.test(markdown)) {
      await settle(storage, id, {
        status: 'failed',
        error: 'report agent produced no dated entries for this period',
        model,
      });
      return;
    }
    await settle(storage, id, {
      status: 'ready',
      markdown,
      summary: truncate(parsed.summary, 600),
      taskCount: items.length,
      model,
      error: null,
    });
  } catch (e) {
    await settle(storage, id, { status: 'failed', error: truncate(String((e as Error)?.message ?? e), 400) });
  } finally {
    inFlight.delete(id);
  }
}

/** The `{summary, days}` block at the end of the session's final message. */
function parseOutput(text: string): ModelOutput | null {
  const raw = extractJson(text) as any;
  if (!raw || typeof raw !== 'object') return null;
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  if (!Array.isArray(raw.days)) return null;
  const days: ModelOutput['days'] = [];
  for (const d of raw.days) {
    if (!d || typeof d.date !== 'string' || !Array.isArray(d.bullets)) continue;
    days.push({ date: d.date, bullets: d.bullets.filter((b: unknown): b is string => typeof b === 'string') });
  }
  return { summary, days };
}

/** A human deleted the report: stop the session that is writing it. */
export function abortReport(id: string): void {
  const ctl = inFlight.get(id);
  inFlight.delete(id);
  ctl?.abort();
}

/**
 * A report's row is not a run row, so a crash mid-write would leave it
 * `running` for ever with no child in existence to settle it — the same hole
 * `chat.recoverOnBoot` closes for a stranded chat lock.
 */
export async function recoverReportsOnBoot(storage: Storage): Promise<number> {
  const stuck = (await storage.listReports()).filter((r) => r.status === 'running' || r.status === 'pending');
  for (const r of stuck) {
    await storage.updateReport(r.id, {
      status: 'failed',
      error: 'the server restarted while this report was being written',
    });
  }
  return stuck.length;
}
