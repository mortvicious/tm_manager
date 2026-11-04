import { formatDuration, isJobDue, roughDuration, jobHoldText, type Job, type JobRun, type OrchestratorStatus } from '@tm/shared';
import type { JobService } from '../jobs.ts';
import { escapeHtml } from './api.ts';
import { short } from './ids.ts';
import type { InlineKeyboardMarkup } from './types.ts';

// Scheduled jobs on the phone (docs/jobs.md § Telegram): `/jobs` lists them,
// `/jobs on|off` flips the queue switch, and a finished run that found
// something pings with run-again / pause / acknowledge buttons. `j:<uuid>:<op>`
// is its own namespace, parsed BEFORE the stateless action codec like `ap:` —
// a job can be deleted from either surface, so a stale button is refused with
// the reason rather than falling through.

export type JobOp = 'run' | 'pause' | 'resume' | 'ack';
const OP_CODE: Record<JobOp, string> = { run: 'r', pause: 'p', resume: 's', ack: 'a' };
const CODE_OP: Record<string, JobOp> = { r: 'run', p: 'pause', s: 'resume', a: 'ack' };

export interface JobButton {
  id: string;
  op: JobOp;
}

export function encodeJobButton(id: string, op: JobOp): string {
  return `j:${id}:${OP_CODE[op]}`;
}

export function parseJobData(data: string): JobButton | null {
  const m = /^j:([\w-]{1,48}):([rpsa])$/.exec(data);
  return m ? { id: m[1], op: CODE_OP[m[2]] } : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const VERDICT_ICON: Record<string, string> = { ok: '✅', attention: '⚠️', error: '❌', failed: '⏹' };

function when(iso: string | null, now: number): string {
  if (!iso) return '—';
  const d = Date.parse(iso) - now;
  const rel = d >= 0 ? `через ${roughDuration(d)}` : `просрочено на ${roughDuration(-d)}`;
  return `${rel} (${new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })})`;
}

/** /jobs: the switch line, then live jobs (due first), with run/pause buttons */
export function jobsListMessage(jobs: Job[], status: NonNullable<OrchestratorStatus['jobs']> | null, repoName: (id: string) => string): { html: string; keyboard?: InlineKeyboardMarkup } {
  const now = Date.now();
  const live = jobs.filter((j) => j.status === 'scheduled' || j.status === 'running' || j.status === 'paused');
  const order = (j: Job) => (j.status === 'running' ? 0 : isJobDue(j, now) ? 1 : j.status === 'scheduled' ? 2 : 3);
  live.sort((a, b) => order(a) - order(b) || (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''));
  const head = status
    ? `🗓 <b>Jobs</b> — очередь ${status.enabled ? 'включена' : '<b>выключена</b>'} · запуск при &lt; ${status.maxActiveTasks || '∞'} активных задач (сейчас ${status.activeTasks})` +
      (status.due ? `\n${status.due} к запуску${status.hold ? ` — ждёт: ${escapeHtml(jobHoldText(status.hold, status) ?? '')}` : ''}` : '') +
      (status.running ? `\n▶ выполняется: ${status.running}` : '')
    : '🗓 <b>Jobs</b>';
  if (!live.length) return { html: `${head}\n\nНет запланированных проверок. /jobs on|off — переключатель.` };
  const shown = live.slice(0, 12);
  const lines = shown.map((j) => {
    const state = j.status === 'running' ? '▶ выполняется' : j.status === 'paused' ? '⏸ пауза' : when(j.nextRunAt, now);
    const rep = j.repeatEveryMs ? ` · каждые ${formatDuration(j.repeatEveryMs)}` : '';
    const last = j.lastVerdict ? ` · ${VERDICT_ICON[j.lastVerdict] ?? ''} ${j.lastVerdict}` : '';
    return `• <b>${escapeHtml(clip(j.title, 70))}</b> <code>${short(j.id)}</code>\n  ${escapeHtml(repoName(j.repoId))} · ${state}${rep}${last}`;
  });
  const rows = shown
    .filter((j) => j.status !== 'running')
    .slice(0, 8)
    .map((j) => [
      { text: `▶ ${clip(j.title, 22)}`, callback_data: encodeJobButton(j.id, 'run') },
      j.status === 'paused'
        ? { text: '⏯ Продолжить', callback_data: encodeJobButton(j.id, 'resume') }
        : { text: '⏸ Пауза', callback_data: encodeJobButton(j.id, 'pause') },
    ]);
  const more = live.length > shown.length ? `\n…и ещё ${live.length - shown.length} — на странице /jobs` : '';
  return { html: `${head}\n\n${lines.join('\n')}${more}`, keyboard: rows.length ? { inline_keyboard: rows } : undefined };
}

/** the ping for a finished run (attention/error always; ok only with jobs.notifyOk) */
export function jobRunMessage(job: Job, run: JobRun, repoName: string): { html: string; keyboard: InlineKeyboardMarkup } {
  const v = run.verdict ?? 'error';
  const title =
    v === 'ok' ? 'всё в порядке' : v === 'attention' ? 'нужно внимание' : v === 'failed' ? 'остановлена' : 'ошибка запуска';
  const findings = run.findings
    .filter((f) => f.severity !== 'info')
    .slice(0, 5)
    .map((f) => `• ${f.severity === 'critical' ? '🔴' : '🟠'} ${escapeHtml(clip(f.text, 200))}`);
  const html = [
    `${VERDICT_ICON[v] ?? '🗓'} <b>Проверка: ${title}</b> — ${escapeHtml(clip(job.title, 80))} <code>${short(job.id)}</code>`,
    `${escapeHtml(repoName)} · запуск ${run.runNumber}`,
    '',
    escapeHtml(clip(run.summary ?? run.error ?? '', 900)),
    ...(findings.length ? ['', ...findings] : []),
    ...(run.followUpTaskIds.length ? ['', `📝 черновиков задач: ${run.followUpTaskIds.length}`] : []),
  ].join('\n');
  const actions = [
    { text: '🔁 Ещё раз', callback_data: encodeJobButton(job.id, 'run') },
    job.status === 'paused'
      ? { text: '⏯ Продолжить', callback_data: encodeJobButton(job.id, 'resume') }
      : { text: '⏸ Пауза', callback_data: encodeJobButton(job.id, 'pause') },
  ];
  const ack = v === 'attention' || v === 'error' ? [{ text: '👌 Принято', callback_data: encodeJobButton(job.id, 'ack') }] : [];
  return { html, keyboard: { inline_keyboard: [[...actions, ...ack]] } };
}

/** a button press → toast + reply line */
export async function runJobButton(jobs: JobService, b: JobButton, actor: string): Promise<{ ok: boolean; toast: string; html: string }> {
  const r =
    b.op === 'run'
      ? await jobs.runNow(b.id, actor)
      : b.op === 'pause'
        ? await jobs.pause(b.id, actor)
        : b.op === 'resume'
          ? await jobs.resume(b.id, actor)
          : await jobs.acknowledge(b.id, null);
  if (!r.ok) return { ok: false, toast: r.code === 404 ? 'Gone' : 'Refused', html: `⚠ ${escapeHtml(r.error)}` };
  const what = { run: '▶ запущена', pause: '⏸ на паузе', resume: '⏯ снова по расписанию', ack: '👌 принято' }[b.op];
  return { ok: true, toast: 'OK', html: `🗓 Проверка <code>${short(b.id)}</code> ${what}.` };
}
