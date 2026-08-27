import { useEffect, useState, type ReactNode } from 'react';
import type { UsageSnapshot, UsageWindow } from '@tm/shared';
import { NavLink } from 'react-router-dom';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { CommandsLauncher } from './Commands.tsx';
import { EmulatorLauncher } from './Emulator.tsx';
import { useLocation } from 'react-router-dom';
import { IconBoard, IconBook, IconConfig, IconFeature, IconMoon, IconMore, IconQueue, IconRepo, IconSun, IconTerminal } from './Icons.tsx';

/** The one breakpoint. Mirrors `--tm-mobile-max` in theme.css — keep in step. */
const MOBILE_QUERY = '(max-width: 768px)';

/**
 * Presentational only: the mobile shell is a different arrangement of the SAME
 * components, and a header control cannot be in two parents at once without
 * being mounted twice (two emulators, two usage pollers). So the breakpoint is
 * read in JS and the tree is built once, for one shape.
 */
export function useIsMobile() {
  const [mobile, setMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

function ThemeToggle() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark');
  // Persist only on explicit toggle — never pin a default the user didn't choose (R9).
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem('tm.theme', next);
  };
  return (
    <button className="btn ghost" title="Toggle theme" onClick={toggle}>
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

function OrchestratorSwitch() {
  const { orch, setOrch } = useApp();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.orchestratorAction(orch.enabled ? 'stop' : 'start');
      const s = await api.orchestrator();
      setOrch(s);
    } catch {
      // orchestrator lands in Phase 5; ignore until then
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`switch ${orch.enabled ? 'on' : ''}`} onClick={toggle} role="switch" aria-checked={orch.enabled}>
      <span className="track">
        <span className="knob" />
      </span>
      <span>{orch.enabled ? 'Queue running' : 'Queue stopped'}</span>
    </div>
  );
}

/** 1_234_567 -> "1.2M"; keeps the tooltip readable without a formatter dep. */
function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtAge(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** "in 4h 30m" until the window rolls over. */
function fmtResets(iso: string | null) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  if (h >= 24) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `resets in ${h}h ${m % 60}m` : `resets in ${m}m`;
}

function windowTitle(label: string, w: UsageWindow) {
  const detail =
    w.source === 'account'
      ? [fmtResets(w.resetsAt)].filter(Boolean).join('')
      : `estimated ${fmtTokens(w.tokens ?? 0)}/${fmtTokens(w.budget ?? 0)}`;
  return detail ? `${label} ${w.pct}% (${detail})` : `${label} ${w.pct}%`;
}

function UsageSegment({ label, w, threshold }: { label: string; w: UsageWindow; threshold: number }) {
  return (
    <span
      style={{
        color: w.pct >= threshold ? 'var(--tm-status-review)' : undefined,
        // An estimated figure is dimmed so it never reads as the account's own.
        opacity: w.source === 'estimate' ? 0.65 : undefined,
      }}
    >
      {label} {Math.round(w.pct)}%
      {w.source === 'estimate' ? '~' : ''}
    </span>
  );
}

function UsagePill() {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.usage().then((u) => alive && setUsage(u)).catch(() => {});
    load();
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!usage) return null;
  // A server still on the pre-weekly payload (this one only restarts between
  // worker runs) sends the flat pct alone — degrade rather than crash.
  const { fiveHour, week, weekFable } = usage as Partial<UsageSnapshot>;
  if (!fiveHour || !week || !weekFable) {
    return (
      <span className="runcount" title={`estimated 5h usage · routing to ${usage.routedModel}`}>
        5h {Math.round(usage.pct)}% · {usage.routedModel.replace('claude-', '')}
      </span>
    );
  }
  const anyEstimate = [fiveHour, week, weekFable].some((w) => w.source === 'estimate');
  const title = [
    usage.accountAgeMs === null
      ? 'estimated from local transcripts — no account figures cached'
      : `plan usage as of ${fmtAge(usage.accountAgeMs)}${anyEstimate ? ' (~ = local estimate instead)' : ''}`,
    windowTitle('session', fiveHour),
    windowTitle('week', week),
    windowTitle('week fable', weekFable),
    `routing to ${usage.routedModel}`,
  ].join(' · ');
  return (
    <span className="runcount" title={title}>
      <UsageSegment label="5h" w={fiveHour} threshold={usage.threshold} /> ·{' '}
      <UsageSegment label="wk" w={week} threshold={usage.threshold} /> ·{' '}
      <UsageSegment label="fable" w={weekFable} threshold={usage.threshold} /> ·{' '}
      {usage.routedModel.replace('claude-', '')}
    </span>
  );
}

function ServerControl() {
  const { connected, bootedAt, orch, commandRuns, host, refreshHost } = useApp();
  const [restarting, setRestarting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const uptime = (() => {
    if (!bootedAt) return '';
    const s = Math.max(0, Math.floor((Date.now() - new Date(bootedAt).getTime()) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();
  // Restarting kills every agent: workers lose their sessions and boot recovery
  // fails their tasks, and a headless analysis/review/plan dies mid-run. So the
  // button is CLOSED while any agent is working — the server refuses it too
  // (409), this is just the honest label. `headless` is absent on a server that
  // predates the field, which reads as "none" rather than blocking forever.
  const live = commandRuns.filter((r) => r.status === 'running').length;
  const headless = orch.headless ?? 0;
  const busyAgents = orch.running + headless;
  const blocked = busyAgents > 0;
  // Two different "not connected"s, and the difference is what the button
  // should offer. The front door is a separate process (docs/host.md), so when
  // it answers, ITS reading of the API is authoritative: `stopped` means the
  // server is genuinely not running and can be started, where a bare dropped
  // socket only means we are out of touch and should keep retrying.
  const stopped = host !== null && !host.api.up;
  const canStart = stopped && !blocked;
  const downReason = host?.api.lastError
    ? `last error: ${host.api.lastError}`
    : host?.api.lastExit
      ? `exited ${host.api.lastExit.signal ?? host.api.lastExit.code} at ${new Date(host.api.lastExit.at).toLocaleTimeString()}`
      : 'not running';
  const start = async () => {
    setStarting(true);
    setErr(null);
    try {
      const r = await api.hostStart();
      if (!r.ok) setErr(r.error ?? 'the API did not come up');
    } catch (e) {
      setErr((e as Error).message);
    }
    setStarting(false);
    void refreshHost();
  };
  const restart = async () => {
    if (blocked) return;
    if (
      !confirm(
        live > 0
          ? `Restart the task-manager server? ${live} running command(s) will be stopped.`
          : 'Restart the task-manager server?',
      )
    )
      return;
    setRestarting(true);
    setErr(null);
    try {
      await api.restartServer();
    } catch (e) {
      // A refusal (an agent started between render and click) is real feedback;
      // a dropped socket as the server exits reads the same way and clears on
      // reconnect, so both are shown rather than swallowed.
      setErr((e as Error).message);
    }
    // the events WS drops → `connected` goes false → reconnect flips it back
    setTimeout(() => {
      setRestarting(false);
      setErr(null);
      void refreshHost();
    }, 8000);
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        className="runcount"
        title={
          connected
            ? `server up ${uptime}`
            : stopped
              ? `the API server is not running (${downReason}) — this page is served by the front door on :${host!.host.port}`
              : 'reconnecting to server…'
        }
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background:
              stopped && !starting
                ? 'var(--tm-status-failed)'
                : restarting || starting || !connected
                  ? 'var(--tm-status-review)'
                  : 'var(--tm-status-done)',
          }}
        />
        {starting ? 'starting…' : restarting ? 'restarting…' : connected ? `up ${uptime}` : stopped ? 'stopped' : 'offline'}
      </span>
      {stopped ? (
        // The page is still here because the front door is serving it, so this
        // is the one control that can put the server back — a restart button
        // pointed at a dead API has nothing to talk to.
        <button
          className="btn ghost"
          title={
            blocked
              ? `${busyAgents} agent(s) are recorded as working — refresh once the API is back before starting it.`
              : `Start the task-manager API on :${host!.api.port}`
          }
          disabled={starting || !canStart}
          onClick={start}
        >
          {starting ? 'Starting…' : 'Start server'}
        </button>
      ) : (
        <button
          className="btn ghost"
          title={
            blocked
              ? `${busyAgents} agent(s) are working (${orch.running} session(s), ${headless} headless) — restarting would kill them and fail their tasks. Stop them first.`
              : live > 0
                ? `Restart the task-manager server (${live} running command(s) will be stopped)`
                : 'Restart the task-manager server'
          }
          disabled={restarting || blocked}
          onClick={restart}
        >
          {restarting ? 'Restarting…' : blocked ? 'Agents working' : 'Restart server'}
        </button>
      )}
      {err && (
        <span className="warn-text mono" title={err} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {err}
        </span>
      )}
    </span>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Gets one of the tab bar's four slots; the rest live behind More. */
  primary?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <IconQueue />, primary: true },
  { to: '/board', label: 'Board', icon: <IconBoard />, primary: true },
  { to: '/queue', label: 'Queue', icon: <IconTerminal />, primary: true },
  { to: '/features', label: 'Features', icon: <IconFeature />, primary: true },
  { to: '/repos', label: 'Repos', icon: <IconRepo /> },
  { to: '/config', label: 'Config', icon: <IconConfig /> },
  { to: '/handbook', label: 'Handbook', icon: <IconBook /> },
];

function navClass({ isActive }: { isActive: boolean }) {
  return `nav-link ${isActive ? 'active' : ''}`;
}

/** The address this page was actually served from — it is the one a phone needs. */
function servedFrom() {
  return window.location.host;
}

function RunCount() {
  const { orch } = useApp();
  return (
    <span
      className="runcount"
      title={
        (orch.headless ?? 0) > 0
          ? `${orch.running} of ${orch.concurrency} worker slots in use · ${orch.headless} headless agent(s) (analysis / review / feature plan) — those run outside the worker budget`
          : `${orch.running} of ${orch.concurrency} worker slots in use`
      }
    >
      running {orch.running}/{orch.concurrency}
      {(orch.headless ?? 0) > 0 ? ` · +${orch.headless}` : ''}
    </span>
  );
}

/**
 * The mobile More sheet. It carries the whole nav (so the four tab slots are a
 * shortcut, never the only way to a route) plus every header control the
 * compact top bar could not hold. Those controls are mounted HERE and nowhere
 * else while the viewport is mobile.
 */
function MoreSheet({ onClose, onOpenTerminal }: { onClose: () => void; onOpenTerminal: (runId: string) => void }) {
  // Escape closes it like the slide-over; a phone keyboard has one too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="overlay sheet-overlay" onClick={onClose} />
      <div className="more-sheet" role="dialog" aria-label="Menu">
        <div className="sheet-grip" />
        <div className="sheet-nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={navClass} onClick={onClose}>
              {n.icon} {n.label}
            </NavLink>
          ))}
        </div>
        <div className="sheet-tools">
          <UsagePill />
          <ServerControl />
          <div className="sheet-tool-row">
            <CommandsLauncher onOpenTerminal={onOpenTerminal} />
            <ThemeToggle />
          </div>
        </div>
        <div className="sheet-foot mono">{servedFrom()}</div>
      </div>
    </>
  );
}

function TabBar({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  return (
    <nav className="tabbar" aria-label="Primary">
      {NAV.filter((n) => n.primary).map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} className={navClass}>
          {n.icon}
          <span>{n.label}</span>
        </NavLink>
      ))}
      <button type="button" className={`nav-link ${moreOpen ? 'active' : ''}`} aria-expanded={moreOpen} onClick={onMore}>
        <IconMore />
        <span>More</span>
      </button>
    </nav>
  );
}

export function Layout({ children, onOpenTerminal }: { children: ReactNode; onOpenTerminal: (runId: string) => void }) {
  const mobile = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  // A sheet left open across a breakpoint change or a navigation would sit over
  // a layout that no longer has a tab bar under it.
  useEffect(() => setMoreOpen(false), [mobile, pathname]);
  // The sheet owns the scroll while it is up, or the page scrolls behind it.
  useEffect(() => {
    if (!moreOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [moreOpen]);

  return (
    <div className={`app${mobile ? ' mobile' : ''}`}>
      {!mobile && (
        <aside className="sidebar">
          <div className="brand">
            <span className="tm">tm_</span>manager
            <span className="sub">tasks · agents · terminals</span>
          </div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={navClass}>
              {n.icon} {n.label}
            </NavLink>
          ))}
          <div className="sidebar-foot">{servedFrom()}</div>
        </aside>
      )}
      <header className="header">
        {mobile && (
          <span className="brand-mini">
            <span className="tm">tm_</span>manager
          </span>
        )}
        <OrchestratorSwitch />
        <RunCount />
        {!mobile && <UsagePill />}
        <span className="spacer" />
        {mobile ? (
          <button
            type="button"
            className={`btn ghost tools-btn${moreOpen ? ' on' : ''}`}
            title="Menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <IconMore />
          </button>
        ) : (
          <>
            <ServerControl />
            <CommandsLauncher onOpenTerminal={onOpenTerminal} />
            <EmulatorLauncher />
            <ThemeToggle />
          </>
        )}
      </header>
      <main className="main">{children}</main>
      {mobile && <TabBar moreOpen={moreOpen} onMore={() => setMoreOpen((v) => !v)} />}
      {mobile && moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} onOpenTerminal={onOpenTerminal} />}
    </div>
  );
}
