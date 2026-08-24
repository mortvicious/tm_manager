import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';
import { IconBoard, IconBook, IconConfig, IconMoon, IconQueue, IconRepo, IconSun, IconTerminal } from './Icons.tsx';

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

function UsagePill() {
  const [usage, setUsage] = useState<{ pct: number; threshold: number; routedModel: string } | null>(null);
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
  const hot = usage.pct >= usage.threshold;
  return (
    <span className="runcount" title={`estimated 5h usage · routing to ${usage.routedModel}`}>
      usage {usage.pct}% · <span style={{ color: hot ? 'var(--tm-status-review)' : undefined }}>{usage.routedModel.replace('claude-', '')}</span>
    </span>
  );
}

function ServerControl() {
  const { connected, bootedAt, orch } = useApp();
  const [restarting, setRestarting] = useState(false);
  const uptime = (() => {
    if (!bootedAt) return '';
    const s = Math.max(0, Math.floor((Date.now() - new Date(bootedAt).getTime()) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();
  const restart = async () => {
    const n = orch.running;
    if (
      !confirm(
        n > 0
          ? `${n} worker(s) are running and will be interrupted (their tasks marked failed — retry after). Restart the server?`
          : 'Restart the task-manager server?',
      )
    )
      return;
    setRestarting(true);
    try {
      await api.restartServer();
    } catch {
      // the request may drop as the server exits — that's expected
    }
    // the events WS drops → `connected` goes false → reconnect flips it back
    setTimeout(() => setRestarting(false), 8000);
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
      <button className="btn ghost" title="Restart server" disabled={restarting} onClick={restart}>
        ⟳
      </button>
    </span>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { orch } = useApp();
  const nav = [
    { to: '/', label: 'Dashboard', icon: <IconQueue /> },
    { to: '/board', label: 'Board', icon: <IconBoard /> },
    { to: '/queue', label: 'Queue', icon: <IconTerminal /> },
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
        <span className="runcount">
          running {orch.running}/{orch.concurrency}
        </span>
        <UsagePill />
        <span className="spacer" />
        <ServerControl />
        <ThemeToggle />
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
