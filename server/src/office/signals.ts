// External signals (docs/office.md § Signals, decisions.md 2026-11-05 — open
// decision 6): an office role subscribed to an outside source
// (`{kind:'signal', source}` in `OfficeRole.triggers`) is woken when that
// source has something NEW — a Sentry issue or a GitHub issue.
//
// - **Polling** rides the scheduler's minute tick (`OfficeScheduler` calls
//   `onTick` per office): each ENABLED office with a role subscribed to a
//   polled source is polled at most every `OFFICE_SIGNAL_POLL_MS` (10 min),
//   DETACHED from the tick (a slow `gh` never delays a cron wake). Sentry goes
//   through the existing integration (`fetchUnresolvedSentryIssues`, the
//   Config page's org/project, the token read from data/config.json into the
//   `Authorization` header and nowhere else); GitHub is `gh issue list --json`
//   per workspace repo (argv only, `gitNetEnv`, no prompt). One fetch per
//   source (and repo) is shared by every office for the poll window.
// - **Rows**: an issue first seen / opened within `OFFICE_SIGNAL_MAX_AGE_MS`
//   (72 h — never the whole backlog) is upserted into `tm_office_signals`
//   through the idempotent `appendSignal`, so a re-polled issue is ONE row.
// - **Wake**: a role is woken when the poll created rows for a source it
//   subscribes to (or, at most hourly, while unconsumed recent ones wait):
//   debounced per role (`OFFICE_SIGNAL_DEBOUNCE_MS`), through `officeGate`
//   WITH the guards, refusals handled like event triggers (a `skipped` row or
//   a deferral). A shift takes ≤ `OFFICE_SIGNALS_PER_SHIFT` signals and
//   CONSUMES them (`consumeSignal`) — one signal, one shift.
// - **Trust**: the text is outside text. It reaches the prompt only inside
//   `officeSignalsBlock`'s fence; the shift is tainted (`shiftTaint` on a
//   `signal` trigger), so what it files is a draft with `tainted_at` and its
//   notes go under `untrusted/`; it gets no web tools and runs no saved
//   command (`shiftGrantedTools`, `SIGNAL_SHIFT_COMMANDS_REASON`). Audit rows
//   carry ids and a ≤ 120-char single-line title only (`clipUntrusted`).
import { execFile } from 'node:child_process';
import {
  OFFICE_POLLED_SIGNAL_SOURCES,
  OFFICE_SIGNALS_PER_SHIFT,
  OFFICE_SIGNAL_DEBOUNCE_MS,
  OFFICE_SIGNAL_MAX_AGE_MS,
  OFFICE_SIGNAL_POLL_MS,
  OFFICE_SIGNAL_TEXT_MAX,
  OFFICE_SIGNAL_TITLE_MAX,
  clipUntrusted,
  officeSignalTriggerRef,
  roleSignalSources,
  type AppSettings,
  type Office,
  type OfficeRole,
  type OfficeSignal,
  type OfficeSignalSource,
  type Repo,
} from '@tm/shared';
import { readSentryAuthToken } from '../config.ts';
import { cleanEnv } from '../git.ts';
import { gitNetEnv } from '../push-health.ts';
import { fetchUnresolvedSentryIssues, sentryProject, type SentryIssue } from '../sentry.ts';
import type { Storage } from '../storage/types.ts';
import type { CoalescedAudit } from './event-triggers.ts';
import { officeGate, type CommitCounter } from './gate.ts';
import type { ShiftStarter } from './scheduler.ts';
import type { ShiftTriggerInput } from './shift.ts';

/** An issue as a poller read it — still untrusted text. */
export interface SignalIssue {
  source: OfficeSignalSource;
  /** unique per source: the Sentry issue id, `owner/repo#n` on GitHub */
  externalId: string;
  title: string;
  rawText: string;
  url: string | null;
  /** first seen (Sentry) / opened (GitHub); unparsable = never "new" */
  openedAt: string | null;
}

/** What the pollers fetch through (tests inject stubs; the defaults reach Sentry and `gh`). */
export interface SignalFetchers {
  /** null = Sentry is not configured (org/project/token) */
  sentry(settings: AppSettings): Promise<SignalIssue[] | null>;
  github(repo: Repo): Promise<SignalIssue[]>;
}

export interface OfficeSignalsDeps {
  storage: Storage;
  shifts: () => ShiftStarter;
  fetchers?: SignalFetchers;
  /** the scheduler's coalescing audit writer */
  audit?: CoalescedAudit;
  now?: () => number;
  countCommits?: CommitCounter;
  log?: (line: string) => void;
}

export interface OfficeSignalPollReport {
  /** rows created by this poll */
  created: OfficeSignal[];
  /** roles a bucket was opened for */
  enqueued: string[];
  errors: string[];
}

export interface OfficeSignalFlushReport {
  woken: { officeId: string; roleId: string; shiftId: string; signals: number }[];
  skipped: { officeId: string; roleId: string; code: string; reason: string }[];
  deferred: { officeId: string; roleId: string; code: string }[];
}

interface Bucket {
  officeId: string;
  roleId: string;
  dueAt: number;
  firstAt: number;
  deferredSince: number | null;
}

/** A deferred wake is retried this often, for at most `DEFER_MAX_MS`, then skipped. */
const RETRY_MS = 60_000;
const DEFER_MAX_MS = 60 * 60_000;
/** While recent unconsumed signals wait (a skip, more than one shift's worth), a role is retried at most this often. */
export const OFFICE_SIGNAL_BACKLOG_RETRY_MS = 60 * 60_000;
/** A shared fetch is reused by every office for slightly less than a poll window. */
const FETCH_TTL_MS = OFFICE_SIGNAL_POLL_MS - 60_000;
/** Issues `gh issue list` reads per repo. */
const GH_LIMIT = 30;
const GH_TIMEOUT_MS = 60_000;
/** the same fetch error is logged once per hour */
const ERROR_LOG_MS = 60 * 60_000;

const DEFER_CODES = new Set<string>(['slots', 'office-busy', 'busy', 'paused', 'memory']);
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// The default fetchers
// ---------------------------------------------------------------------------

/** A Sentry issue as signal text — the fields the API returns, nothing from the token or config. */
export function sentrySignal(issue: SentryIssue): SignalIssue {
  const lines = [
    `Sentry issue ${issue.shortId} (${issue.level}) — ${issue.count} events / ${issue.userCount} users`,
    `first seen ${issue.firstSeen ?? 'unknown'}, last seen ${issue.lastSeen}`,
    issue.culprit ? `culprit: ${issue.culprit}` : '',
    issue.metadata?.value ? `${issue.metadata.type ?? 'Error'}: ${issue.metadata.value}` : '',
  ].filter(Boolean);
  return {
    source: 'sentry',
    externalId: String(issue.id),
    title: String(issue.title ?? ''),
    rawText: lines.join('\n'),
    url: typeof issue.permalink === 'string' ? issue.permalink : null,
    openedAt: issue.firstSeen ?? null,
  };
}

interface GhIssue {
  number: number;
  title?: string;
  body?: string;
  url?: string;
  createdAt?: string;
  author?: { login?: string } | null;
  labels?: { name?: string }[];
}

/** `owner/repo#n` from an issue URL; the repo id stands in when the URL is not a GitHub issue URL. */
export function githubExternalId(issue: Pick<GhIssue, 'number' | 'url'>, repoId: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(issue.url ?? '');
  return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : `${repoId}#${issue.number}`;
}

export function githubSignal(issue: GhIssue, repo: Pick<Repo, 'id' | 'name'>): SignalIssue {
  const labels = (issue.labels ?? []).map((l) => l?.name).filter((n): n is string => typeof n === 'string' && n !== '');
  const head = [
    `GitHub issue #${issue.number} in ${repo.name}`,
    `author: ${issue.author?.login ?? 'unknown'}${labels.length ? ` · labels: ${labels.join(', ')}` : ''} · opened ${issue.createdAt ?? 'unknown'}`,
  ].join('\n');
  return {
    source: 'github',
    externalId: githubExternalId(issue, repo.id),
    title: String(issue.title ?? ''),
    rawText: `${head}\n\n${String(issue.body ?? '')}`,
    url: typeof issue.url === 'string' ? issue.url : null,
    openedAt: issue.createdAt ?? null,
  };
}

/**
 * The real fetchers. `readToken` is the Sentry token's ONE source — data/config.json
 * (`readSentryAuthToken`, re-read per poll so a token saved on the Config page
 * applies without a restart); tests pass a stub. The token goes into the
 * request header and nowhere else: not tm_config, a signal row, an audit row
 * or a prompt.
 */
export function defaultSignalFetchers(readToken: () => string = readSentryAuthToken): SignalFetchers {
  return {
    async sentry(settings) {
      const target = sentryProject(settings);
      const token = readToken();
      if (!target || !token) return null;
      return (await fetchUnresolvedSentryIssues(target, token)).map(sentrySignal);
    },
    async github(repo) {
      const env = { ...cleanEnv(), ...(await gitNetEnv(repo.path)), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
      // argv only, never a shell; stdout kept apart from stderr so the JSON parses whole
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          'gh',
          ['issue', 'list', '--state', 'open', '--limit', String(GH_LIMIT), '--json', 'number,title,body,url,createdAt,author,labels'],
          { cwd: repo.path, env, timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
          (err, out, errOut) => {
            if (err) reject(new Error(`gh issue list in ${repo.name}: ${String(errOut || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
            else resolve(String(out));
          },
        );
      });
      const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return (parsed as GhIssue[]).filter((i) => Number.isInteger(i?.number)).map((i) => githubSignal(i, repo));
    },
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class OfficeSignals {
  private lastPoll = new Map<string, number>();
  private polling = new Map<string, Promise<OfficeSignalPollReport>>();
  private buckets = new Map<string, Bucket>();
  /** roleId → its last signal wake ATTEMPT (ran, skipped or deferred) */
  private lastAttempt = new Map<string, number>();
  /** roleId → its last signal wake that ran */
  private lastWake = new Map<string, number>();
  private fetchCache = new Map<string, { at: number; p: Promise<SignalIssue[] | null> }>();
  private errorLogged = new Map<string, number>();
  private stopped = false;

  constructor(private deps: OfficeSignalsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get fetchers(): SignalFetchers {
    return (this.deps.fetchers ??= defaultSignalFetchers());
  }

  stop(): void {
    this.stopped = true;
  }

  /** What is waiting, per role (tests, diagnostics). */
  queued(): { officeId: string; roleId: string; dueAt: string }[] {
    return [...this.buckets.values()].map((b) => ({ officeId: b.officeId, roleId: b.roleId, dueAt: iso(b.dueAt) }));
  }

  /** Tests: wait for every detached poll started so far. */
  async settled(): Promise<void> {
    while (this.polling.size) await Promise.allSettled([...this.polling.values()]);
  }

  /**
   * The scheduler's per-office step (every minute): flush this office's due
   * wakes, then start a detached poll when one is due. A disabled office
   * drops its pending wakes and is not polled.
   */
  async onTick(office: Office, now = this.now()): Promise<OfficeSignalFlushReport> {
    if (this.stopped) return { woken: [], skipped: [], deferred: [] };
    if (!office.enabled) {
      for (const [k, b] of this.buckets) if (b.officeId === office.id) this.buckets.delete(k);
      return { woken: [], skipped: [], deferred: [] };
    }
    const report = await this.flush(office.id, now);
    const last = this.lastPoll.get(office.id);
    if (!this.polling.has(office.id) && (last === undefined || now - last >= OFFICE_SIGNAL_POLL_MS)) {
      this.lastPoll.set(office.id, now);
      const p = this.poll(office, now)
        .catch((e) => {
          console.warn(`office ${office.id}: signal poll failed:`, (e as Error).message);
          return { created: [], enqueued: [], errors: [(e as Error).message] };
        })
        .finally(() => this.polling.delete(office.id));
      this.polling.set(office.id, p);
    }
    return report;
  }

  // ---- polling ----

  /** One poll of one office (awaited by tests; the tick runs it detached). */
  async poll(office: Office, now = this.now()): Promise<OfficeSignalPollReport> {
    const report: OfficeSignalPollReport = { created: [], enqueued: [], errors: [] };
    const { storage } = this.deps;
    const roles = (await storage.listOfficeRoles(office.id)).filter((r) => r.enabled && roleSignalSources(r).length);
    const sources = new Set<OfficeSignalSource>();
    for (const r of roles) for (const s of roleSignalSources(r)) if (OFFICE_POLLED_SIGNAL_SOURCES.includes(s)) sources.add(s);
    if (!sources.size) return report;
    const ws = await storage.getWorkspace(office.workspaceId);
    if (!ws) return report;
    const settings = await storage.getSettings();

    const issues: SignalIssue[] = [];
    if (sources.has('sentry')) {
      // the Sentry project is assigned to one repo (`sentry.repoId`); blank = any workspace
      const sentryRepo = settings['sentry.repoId'] || '';
      if (!sentryRepo || ws.repoIds.includes(sentryRepo)) {
        const key = `sentry:${settings['sentry.apiBase'] || ''}|${settings['sentry.org'] || ''}|${settings['sentry.project'] || ''}`;
        const got = await this.cached(key, now, () => this.fetchers.sentry(settings), report);
        if (got) issues.push(...got);
      }
    }
    if (sources.has('github')) {
      const ids = new Set(ws.repoIds);
      for (const repo of (await storage.listRepos()).filter((r) => ids.has(r.id))) {
        if (this.stopped) return report;
        const got = await this.cached(`github:${repo.id}`, now, () => this.fetchers.github(repo), report);
        if (got) issues.push(...got);
      }
    }

    for (const issue of issues) {
      if (this.stopped) return report;
      if (!sources.has(issue.source) || !isRecent(issue.openedAt, now)) continue;
      const externalId = issue.externalId.trim().slice(0, 300);
      if (!externalId) continue;
      const { signal, created } = await storage.appendSignal({
        officeId: office.id,
        source: issue.source,
        externalId,
        title: clipUntrusted(issue.title, OFFICE_SIGNAL_TITLE_MAX),
        rawText: issue.rawText.slice(0, OFFICE_SIGNAL_TEXT_MAX),
        url: issue.url && /^https:\/\//.test(issue.url) ? issue.url.slice(0, 500) : null,
        receivedAt: iso(now),
      });
      if (created) report.created.push(signal);
    }
    if (report.created.length) {
      // ids and a clipped, single-line title only — never the issue text (SECURITY.md)
      await storage.appendEvent({
        kind: 'office.signals',
        actor: 'system',
        data: {
          officeId: office.id,
          workspaceId: office.workspaceId,
          created: report.created.length,
          signals: report.created
            .slice(0, 20)
            .map((s) => ({ id: s.id, source: s.source, externalId: s.externalId, title: clipUntrusted(s.title) })),
        },
      });
    }

    // whom to wake: fresh rows for a subscribed source, or (hourly) a recent backlog
    const unconsumed = await storage.listSignals({ officeId: office.id, unconsumed: true, limit: 2000 });
    for (const role of roles) {
      const mine = new Set(roleSignalSources(role));
      const fresh = report.created.some((s) => mine.has(s.source));
      const backlog = unconsumed.some((s) => mine.has(s.source) && isRecent(s.receivedAt, now));
      const last = this.lastAttempt.get(role.id);
      if (fresh || (backlog && (last === undefined || now - last >= OFFICE_SIGNAL_BACKLOG_RETRY_MS))) {
        if (this.enqueue(office, role, now)) report.enqueued.push(role.id);
      }
    }
    if (report.created.length) {
      (this.deps.log ?? console.log)(`office ${office.id}: ${report.created.length} new signal(s); ${report.enqueued.length} role(s) to wake`);
    }
    return report;
  }

  private async cached(
    key: string,
    now: number,
    fetch: () => Promise<SignalIssue[] | null>,
    report: OfficeSignalPollReport,
  ): Promise<SignalIssue[] | null> {
    let hit = this.fetchCache.get(key);
    if (!hit || now - hit.at >= FETCH_TTL_MS) {
      hit = { at: now, p: fetch() };
      this.fetchCache.set(key, hit);
    }
    try {
      return await hit.p;
    } catch (e) {
      const msg = (e as Error).message;
      report.errors.push(msg);
      const logKey = `${key}:${msg}`;
      const at = this.errorLogged.get(logKey);
      if (at === undefined || now - at >= ERROR_LOG_MS) {
        this.errorLogged.set(logKey, now);
        console.warn(`office signals: ${key.split(':')[0]} poll failed: ${msg}`);
      }
      return null;
    }
  }

  private enqueue(office: Office, role: OfficeRole, now: number): boolean {
    if (this.stopped || this.buckets.has(role.id)) return false;
    const last = this.lastWake.get(role.id);
    this.buckets.set(role.id, {
      officeId: office.id,
      roleId: role.id,
      firstAt: now,
      dueAt: Math.max(now + OFFICE_SIGNAL_DEBOUNCE_MS, last !== undefined ? last + OFFICE_SIGNAL_DEBOUNCE_MS : 0),
      deferredSince: null,
    });
    return true;
  }

  // ---- waking ----

  /** Wake every role of the office whose bucket is due. */
  async flush(officeId: string, now = this.now()): Promise<OfficeSignalFlushReport> {
    const report: OfficeSignalFlushReport = { woken: [], skipped: [], deferred: [] };
    const due = [...this.buckets.values()].filter((b) => b.officeId === officeId && b.dueAt <= now).sort((a, b) => a.firstAt - b.firstAt);
    for (const b of due) {
      if (this.stopped) break;
      try {
        await this.wake(b, now, report);
      } catch (e) {
        this.buckets.delete(b.roleId);
        console.warn(`office signal wake for role ${b.roleId} failed:`, (e as Error).message);
      }
    }
    return report;
  }

  private async wake(b: Bucket, now: number, report: OfficeSignalFlushReport): Promise<void> {
    const { storage } = this.deps;
    const office = await storage.getOffice(b.officeId);
    const role = await storage.getOfficeRole(b.roleId);
    if (!office || !office.enabled || !role || !role.enabled || role.officeId !== office.id) {
      this.buckets.delete(b.roleId);
      return;
    }
    const mine = new Set(roleSignalSources(role));
    // oldest first; another role's shift may have taken them since (one signal, one shift)
    const waiting = (await storage.listSignals({ officeId: office.id, unconsumed: true, limit: 2000 })).filter(
      (s) => mine.has(s.source) && isRecent(s.receivedAt, now),
    );
    if (!waiting.length) {
      this.buckets.delete(b.roleId);
      return;
    }
    const take = waiting.slice(0, OFFICE_SIGNALS_PER_SHIFT);
    const dropped = waiting.length - take.length;
    this.lastAttempt.set(role.id, now);
    const trigger: ShiftTriggerInput = {
      kind: 'signal',
      ref: officeSignalTriggerRef(take, dropped),
      at: take[0].receivedAt,
      signals: take,
      signalsDropped: dropped,
    };
    const gate = await officeGate(storage, office, role, trigger, { now, countCommits: this.deps.countCommits });
    if (!gate.ok) return this.refused(b, office, role, trigger, gate.code, gate.reason, gate.guard ?? null, now, report);
    const res = await this.deps.shifts().start(office, role, trigger);
    if (!res.ok) return this.refused(b, office, role, trigger, res.code, res.reason, null, now, report);
    res.done.catch(() => {});
    this.buckets.delete(b.roleId);
    this.lastWake.set(role.id, now);
    let consumed = 0;
    for (const s of take) if (await storage.consumeSignal(s.id, res.shiftId)) consumed++;
    report.woken.push({ officeId: office.id, roleId: role.id, shiftId: res.shiftId, signals: consumed });
    (this.deps.log ?? console.log)(`office ${office.id}: ${role.key} woke on ${take.length} signal(s): ${trigger.ref}`);
  }

  private async refused(
    b: Bucket,
    office: Office,
    role: OfficeRole,
    trigger: ShiftTriggerInput,
    code: string,
    reason: string,
    guard: string | null,
    now: number,
    report: OfficeSignalFlushReport,
  ): Promise<void> {
    const extra = { trigger: 'signal', ref: trigger.ref, signals: (trigger.signals?.length ?? 0) + (trigger.signalsDropped ?? 0) };
    if (DEFER_CODES.has(code)) {
      b.deferredSince ??= now;
      if (now - b.deferredSince < DEFER_MAX_MS) {
        b.dueAt = now + RETRY_MS;
        report.deferred.push({ officeId: office.id, roleId: role.id, code });
        await this.audit('office.shift-deferred', office, role, code, null, reason, now, extra);
        return;
      }
      reason = `still refused after ${Math.round(DEFER_MAX_MS / 60_000)} min: ${reason}`;
    }
    this.buckets.delete(b.roleId);
    const at = iso(now);
    // the signals stay unconsumed: the role is retried at most hourly while they are recent
    const shift = await this.deps.storage.appendShift({
      officeId: office.id,
      roleId: role.id,
      trigger: { kind: 'signal', ref: trigger.ref ?? null, at: trigger.at ?? at },
      verdict: 'skipped',
      skipReason: reason,
      skipCode: code,
      startedAt: at,
      endedAt: at,
    });
    report.skipped.push({ officeId: office.id, roleId: role.id, code, reason });
    await this.audit('office.shift-skipped', office, role, code, guard, reason, now, { ...extra, shiftId: shift.id });
  }

  private async audit(...args: Parameters<CoalescedAudit>): Promise<void> {
    if (this.deps.audit) return this.deps.audit(...args);
    const [kind, office, role, code, guard, reason, , extra] = args;
    await this.deps.storage.appendEvent({
      kind,
      actor: 'system',
      data: { officeId: office.id, workspaceId: office.workspaceId, roleId: role.id, roleKey: role.key, code, ...(guard ? { guard } : {}), reason, ...extra },
    });
  }
}

/** Opened / received within `OFFICE_SIGNAL_MAX_AGE_MS` of now (a future time counts as now). */
function isRecent(at: string | null, now: number): boolean {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) && now - t <= OFFICE_SIGNAL_MAX_AGE_MS;
}

let instance: OfficeSignals | null = null;

/** Boot wiring (index.ts). */
export function initOfficeSignals(s: OfficeSignals): void {
  instance = s;
}

/** The process-wide signal poller, or null before boot wiring. */
export function officeSignals(): OfficeSignals | null {
  return instance;
}
