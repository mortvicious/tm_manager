import { useEffect, useState, type ReactNode } from 'react';
import type { UsageSnapshot, UsageWindow } from '@tm/shared';
import { NavLink } from 'react-router-dom';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { CommandsLauncher } from './Commands.tsx';
import { EmulatorLauncher } from './Emulator.tsx';
import { IconBoard, IconBook, IconConfig, IconFeature, IconMoon, IconQueue, IconRepo, IconSun, IconTerminal } from './Icons.tsx';

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
  const { connected, bootedAt, orch, commandRuns } = useApp();
  const [restarting, setRestarting] = useState(false);
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
    }, 8000);
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        className="runcount"
        title={connected ? `server up ${uptime}` : 'reconnecting to server…'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: restarting || !connected ? 'var(--tm-status-review)' : 'var(--tm-status-done)',
          }}
        />
        {restarting ? 'restarting…' : connected ? `up ${uptime}` : 'offline'}
      </span>
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
      {err && (
        <span className="warn-text mono" title={err} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {err}
        </span>
      )}
    </span>
  );
}

export function Layout({ children, onOpenTerminal }: { children: ReactNode; onOpenTerminal: (runId: string) => void }) {
  const { orch } = useApp();
  const nav = [
    { to: '/', label: 'Dashboard', icon: <IconQueue /> },
    { to: '/board', label: 'Board', icon: <IconBoard /> },
    { to: '/queue', label: 'Queue', icon: <IconTerminal /> },
    { to: '/features', label: 'Features', icon: <IconFeature /> },
    { to: '/repos', label: 'Repos', icon: <IconRepo /> },
    { to: '/config', label: 'Config', icon: <IconConfig /> },
    { to: '/handbook', label: 'Handbook', icon: <IconBook /> },
  ];
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="tm">tm_</span>manager
          <span className="sub">tasks · agents · terminals</span>
        </div>
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            {n.icon} {n.label}
          </NavLink>
        ))}
        <div className="sidebar-foot">127.0.0.1:5175</div>
      </aside>
      <header className="header">
        <OrchestratorSwitch />
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
        <UsagePill />
        <span className="spacer" />
        <ServerControl />
        <CommandsLauncher onOpenTerminal={onOpenTerminal} />
        <EmulatorLauncher />
        <ThemeToggle />
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
