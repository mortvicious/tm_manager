/**
 * Why the API last stopped (docs/host.md § Restart causes). Every graceful way
 * out writes ONE record here, synchronously, before anything else: a
 * `tsx watch` reload SIGKILLs after 5 s, and a write left for later would be
 * lost with the process. The next boot reads and removes it, so a boot that
 * finds nothing was not a graceful stop: a crash, a SIGKILL, a power loss or a
 * machine reboot (`kind: 'unknown'`).
 *
 * A file, not a `tm_events` row: the row is written too (`server.stopping`),
 * but storage may already be closed, or never reached, on the way out.
 *
 * The front door supervises the API but can only SIGNAL it, and a signal says
 * nothing about who sent it. So before it signals it leaves an INTENT
 * (`writeStopIntent`); the API's signal handler turns a fresh intent into the
 * cause and consumes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.ts';

export type StopCauseKind =
  /** POST /api/server/restart (the header button, Telegram /restart, the CLI without a front door) */
  | 'route'
  /** the front door stopped or restarted its child (`/host/stop|restart`, Rebuild & restart, its own shutdown) */
  | 'supervisor'
  /** a SIGTERM under `npm run dev`: `tsx watch` reloading on a file change, most likely */
  | 'watch'
  /** a signal nobody announced: Ctrl-C, `kill`, launchd, logout */
  | 'signal'
  /** an uncaught exception or unhandled rejection that ended the process */
  | 'crash'
  /** no record: the process died without a graceful stop (SIGKILL, power loss, reboot) */
  | 'unknown';

export interface StopCause {
  kind: StopCauseKind;
  /** when the stop began (ISO) */
  at: string;
  signal?: string;
  /** a forced restart (agents were working) */
  force?: boolean;
  /** route / supervisor: what was asked for */
  action?: 'restart' | 'stop' | 'rebuild-restart' | 'respawn' | 'shutdown';
  /** who asked (route actor, `rebuild`, …) */
  actor?: string;
  /** a crash's message, cut short */
  detail?: string;
  /** the stopping process's pid */
  pid?: number;
}

const causeFile = path.join(dataDir, 'stop-cause.json');
const intentFile = path.join(dataDir, 'stop-intent.json');
/** An intent older than this is not the reason for the signal arriving now. */
const INTENT_FRESH_MS = 60_000;

let recorded: StopCause | null = null;

/**
 * Record why this process is stopping. First writer wins: a restart route
 * that ends in `process.exit` must not be overwritten by the SIGTERM its own
 * supervisor sends a moment later, nor a watch reload by the SIGKILL after it.
 */
export function recordStopCause(cause: Omit<StopCause, 'at' | 'pid'> & { at?: string }): StopCause {
  if (recorded) return recorded;
  recorded = { at: new Date().toISOString(), pid: process.pid, ...cause };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(causeFile, JSON.stringify(recorded));
  } catch (err) {
    console.error('stop-cause: could not write', err);
  }
  return recorded;
}

/** The cause this process recorded, if it is on its way out. */
export function currentStopCause(): StopCause | null {
  return recorded;
}

/**
 * The cause behind a signal: the front door's fresh intent if it left one,
 * else a SIGTERM under `tsx watch` (`TM_WATCH=1`, set by the front door's dev
 * spawn) reads as a watch reload, else a plain signal.
 */
export function signalCause(signal: string): Omit<StopCause, 'at' | 'pid'> {
  const intent = takeStopIntent();
  if (intent) return { ...intent, signal };
  if (process.env.TM_WATCH === '1' && signal === 'SIGTERM') return { kind: 'watch', signal };
  return { kind: 'signal', signal };
}

/** Front door: say why the child is about to be signalled. */
export function writeStopIntent(intent: { action: NonNullable<StopCause['action']>; actor?: string; force?: boolean }): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(intentFile, JSON.stringify({ kind: 'supervisor', at: new Date().toISOString(), ...intent }));
  } catch (err) {
    console.error('stop-intent: could not write', err);
  }
}

/** Front door: the child exited without reading it (it was already gone). */
export function clearStopIntent(): void {
  try {
    fs.rmSync(intentFile, { force: true });
  } catch {
    /* best effort */
  }
}

function takeStopIntent(): Omit<StopCause, 'at' | 'pid'> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(intentFile, 'utf8');
  } catch {
    return null;
  }
  clearStopIntent();
  try {
    const intent = JSON.parse(raw) as StopCause;
    if (Date.now() - Date.parse(intent.at) > INTENT_FRESH_MS) return null;
    return { kind: 'supervisor', action: intent.action, actor: intent.actor, force: intent.force };
  } catch {
    return null;
  }
}

/**
 * Boot: the previous process's record, removed so the NEXT boot cannot read
 * it again. Nothing recorded = `unknown` (crash, SIGKILL, reboot). A stale
 * intent nobody consumed is dropped too.
 */
export function takeStopCause(): StopCause {
  clearStopIntent();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(causeFile, 'utf8');
    fs.rmSync(causeFile, { force: true });
  } catch {
    raw = null;
  }
  if (raw) {
    try {
      const cause = JSON.parse(raw) as StopCause;
      if (cause && typeof cause.kind === 'string') return cause;
    } catch {
      /* unreadable → unknown */
    }
  }
  return { kind: 'unknown', at: new Date().toISOString() };
}

/** One line for logs and the SPA: "restart route (forced)", "SIGTERM (tsx watch)", … */
export function describeStopCause(c: StopCause): string {
  switch (c.kind) {
    case 'route':
      return `restart route${c.force ? ' (forced)' : ''}${c.actor ? ` by ${c.actor}` : ''}`;
    case 'supervisor':
      return `front door ${c.action ?? 'stop'}${c.force ? ' (forced)' : ''}${c.actor ? ` by ${c.actor}` : ''}`;
    case 'watch':
      return `${c.signal ?? 'SIGTERM'} under tsx watch (file-change reload)`;
    case 'signal':
      return `signal ${c.signal ?? '?'}`;
    case 'crash':
      return `crash${c.detail ? `: ${c.detail}` : ''}`;
    default:
      return 'unknown — crash, SIGKILL or machine reboot';
  }
}
