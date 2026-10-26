import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { UsageSnapshot, UsageWindow } from '@tm/shared';
import { NavLink } from 'react-router-dom';
import { api } from '../api.ts';
import { toggleScheme, useLook } from '../appearance.ts';
import type { InboxReturn, ReturnTo } from '../returnTo.ts';
import { useApp } from '../state.tsx';
import { useArm } from '../arm.ts';
import { toastError } from '../toast.ts';
import { CommandsLauncher } from './Commands.tsx';
import { EmulatorLauncher } from './Emulator.tsx';
import { Sheet } from './Sheet.tsx';
import { useLocation, useNavigate } from 'react-router-dom';
import { InboxChip, InboxSheet } from './Inbox.tsx';
import {
  IconBoard,
  IconBook,
  IconShared,
  IconChat,
  IconConfig,
  IconFeature,
  IconInbox,
  IconMoon,
  IconMore,
  IconQueue,
  IconRepo,
  IconReport,
  IconShell,
  IconSun,
  IconTerminal,
} from './Icons.tsx';

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
  // Flips what is on screen and pins it. Only an explicit pick is stored (R9);
  // Config → Appearance → System goes back to following the device.
  const { scheme } = useLook();
  return (
    <button className="btn ghost" title="Toggle light / dark" onClick={toggleScheme}>
      {scheme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

/**
 * The global queue switch (docs/mobile.md § Confirming destructive actions). STARTING it
 * claims queued tasks, which spends money, so start takes a second press
 * (src/arm.ts); stopping is the safe direction and never asks. On a phone it
 * lives in the More sheet — the header's top-left is where iOS puts Back — and
 * the header keeps only the non-interactive state dot on the run count.
 */
function OrchestratorSwitch() {
  const { orch, setOrch } = useApp();
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const arm = useArm();
  const armed = arm.armed === 'start';
  const toggle = async () => {
    if (busy) return;
    const verb = orch.enabled ? 'stop' : 'start';
    if (verb === 'start' && !arm.press('start')) return;
    setBusy(true);
    try {
      await api.orchestratorAction(verb);
      setOrch(await api.orchestrator());
    } catch (e) {
      toastError(e, verb === 'start' ? 'Start queue' : 'Stop queue');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={orch.enabled}
      className={`switch${orch.enabled ? ' on' : ''}${armed ? ' armed' : ''}`}
      disabled={busy}
      title={
        orch.enabled
          ? 'Stop the global queue — running agents finish, nothing new is claimed'
          : 'Start the global queue — it claims queued tasks (asks for a second press)'
      }
      onClick={toggle}
    >
      <span className="track" aria-hidden="true">
        <span className="knob" />
      </span>
      <span>
        {armed ? `Start queue? ${mobile ? 'tap' : 'click'} again` : orch.enabled ? 'Queue running' : 'Queue stopped'}
      </span>
    </button>
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

/**
 * The front door's reading of the API and the one action that can put it back
 * (docs/host.md). Shared by the header's ServerControl and the phone's offline
 * banner, so the two can never disagree about whether Start is offered.
 */
function useServerStart() {
  const { orch, host, refreshHost } = useApp();
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Restarting kills every agent: workers lose their sessions and boot recovery
  // fails their tasks, and an aux session (review, plan, chat, …) dies mid-run.
  // So the button is CLOSED while any agent is working — the server refuses it
  // too (409), this is just the honest label. `aux` is absent on a server that
  // predates the field, which reads as "none" rather than blocking forever.
  const auxLive = orch.aux ?? 0;
  const busyAgents = orch.running + auxLive;
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
  const startTitle = blocked
    ? `${busyAgents} agent(s) are recorded as working — refresh once the API is back before starting it.`
    : `Start the task-manager API on :${host?.api.port ?? ''}`;
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
  return { stopped, canStart, blocked, busyAgents, auxLive, downReason, startTitle, starting, err, setErr, start };
}

function ServerControl() {
  const { connected, bootedAt, orch, commandRuns, shells, host, refreshHost } = useApp();
  const { stopped, canStart, blocked, busyAgents, auxLive, downReason, startTitle, starting, err, setErr, start } =
    useServerStart();
  const [restarting, setRestarting] = useState(false);
  const uptime = (() => {
    if (!bootedAt) return '';
    const s = Math.max(0, Math.floor((Date.now() - new Date(bootedAt).getTime()) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })();
  const live = commandRuns.filter((r) => r.status === 'running').length;
  const liveShells = shells.filter((s) => s.status === 'running').length;
  const restart = async () => {
    if (blocked) return;
    if (
      !confirm(
        live > 0 || liveShells > 0
          ? `Restart the task-manager server? ${[
              live > 0 ? `${live} running command(s) will be stopped` : null,
              liveShells > 0 ? `${liveShells} open terminal(s) will be closed` : null,
            ]
              .filter(Boolean)
              .join(' and ')}.`
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
          title={startTitle}
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
              ? `${busyAgents} agent(s) are working (${orch.running} worker session(s), ${auxLive} aux session(s)) — restarting would kill them and fail their tasks. Stop them first.`
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

/** after a dropped socket, how long before the phone says so: a server restart
 *  or the page's own first connect is over well inside it */
const OFFLINE_GRACE_MS = 4000;

/**
 * The phone's out-of-contact state (docs/mobile.md § Server offline). Its
 * header has no room for ServerControl, so without this a stopped API read as
 * an empty board or a live-looking stale one. A slim bar at the top of the
 * page: "stopped" (the front door says the API is not running) carries Start
 * server; "offline" (socket down, nobody to ask) just says we are retrying.
 */
function OfflineBanner() {
  const { connected, loaded } = useApp();
  const { stopped, canStart, blocked, downReason, startTitle, starting, err, start } = useServerStart();
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (connected) {
      setLost(false);
      return;
    }
    const t = setTimeout(() => setLost(true), OFFLINE_GRACE_MS);
    return () => clearTimeout(t);
  }, [connected]);
  // the front door's "stopped" is an answer, not a blip: no grace needed
  if (connected || !(lost || stopped)) return null;
  const tone = stopped && !starting ? 'stopped' : 'offline';
  return (
    <div className={`offline-banner ${tone}`} role="alert">
      <span className="offline-dot" aria-hidden="true" />
      <span className="offline-text">
        <b>{starting ? 'Starting server…' : stopped ? 'Server stopped' : 'Offline'}</b>
        <span className="offline-sub">
          {stopped
            ? blocked
              ? // the agent count is the last thing the API said; a reload starts from zero
                'agents were recorded as working — reload the page to start it'
              : downReason
            : loaded
              ? 'showing what was loaded last — reconnecting…'
              : "can't reach the server — retrying…"}
        </span>
        {err && <span className="offline-sub warn-text">{err}</span>}
      </span>
      {stopped && (
        <button type="button" className="btn primary" title={startTitle} disabled={starting || !canStart} onClick={start}>
          {starting ? 'Starting…' : 'Start server'}
        </button>
      )}
    </div>
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
  { to: '/inbox', label: 'Inbox', icon: <IconInbox /> },
  { to: '/queue', label: 'Queue', icon: <IconTerminal />, primary: true },
  { to: '/features', label: 'Features', icon: <IconFeature />, primary: true },
  { to: '/chat', label: 'Chat', icon: <IconChat /> },
  { to: '/reports', label: 'Reports', icon: <IconReport /> },
  { to: '/shared', label: 'Shared', icon: <IconShared /> },
  { to: '/terminals', label: 'Terminal', icon: <IconShell /> },
  { to: '/repos', label: 'Repos', icon: <IconRepo /> },
  { to: '/config', label: 'Config', icon: <IconConfig /> },
  { to: '/handbook', label: 'Handbook', icon: <IconBook /> },
];

/**
 * Glass on a PHONE leaves these out of the tab bar and the More sheet
 * (docs/glass.md § Hidden in Glass). The desktop sidebar keeps them in both
 * designs, and the routes stay, so push deep links, the Inbox's plan rows and
 * the Queue's aux-run links still land on them.
 */
const GLASS_HIDDEN = new Set(['/features', '/chat']);

function useNav() {
  const { design } = useLook();
  const mobile = useIsMobile();
  return design === 'glass' && mobile ? NAV.filter((n) => !GLASS_HIDDEN.has(n.to)) : NAV;
}

function navClass({ isActive }: { isActive: boolean }) {
  return `nav-link ${isActive ? 'active' : ''}`;
}

/** The address this page was actually served from — it is the one a phone needs. */
function servedFrom() {
  return window.location.host;
}

/** `state`: the phone's header, where the queue switch is a dot here and the switch is in More. */
function RunCount({ state = false }: { state?: boolean }) {
  const { orch } = useApp();
  const slots =
    (orch.aux ?? 0) > 0
      ? `${orch.running} of ${orch.concurrency} worker slots in use · ${orch.aux} aux session(s) (review / plan / analysis / chat / report …) — those run outside the worker budget`
      : `${orch.running} of ${orch.concurrency} worker slots in use`;
  const queue = orch.enabled ? 'Queue running' : 'Queue stopped';
  return (
    <span className="runcount" title={state ? `${queue} (switch it in the ⋯ menu) · ${slots}` : slots}>
      {state && (
        <>
          <span className={`queue-dot${orch.enabled ? ' on' : ''}`} aria-hidden="true" />
          <span className="sr-only">{queue}, </span>
        </>
      )}
      running {orch.running}/{orch.concurrency}
      {(orch.aux ?? 0) > 0 ? ` · +${orch.aux}` : ''}
    </span>
  );
}

/**
 * The mobile More sheet. It carries the whole nav (so the four tab slots are a
 * shortcut, never the only way to a route) plus every header control the
 * compact top bar could not hold. Those controls are mounted HERE and nowhere
 * else while the viewport is mobile.
 */
/** "❓ n" while any agent is waiting on a decision; a click reopens the modal (docs/questions.md). */
function QuestionChip() {
  const { questions, nudgeQuestions } = useApp();
  const n = questions.length;
  if (n === 0) return null;
  return (
    <button
      type="button"
      className="btn ghost qchip"
      title={`${n} agent question${n === 1 ? '' : 's'} waiting for your answer`}
      onClick={nudgeQuestions}
    >
      <span className="dot" /> {n} {n === 1 ? 'question' : 'questions'}
    </button>
  );
}

function MoreSheet({ onClose, onOpenTerminal }: { onClose: () => void; onOpenTerminal: (runId: string) => void }) {
  const nav = useNav();
  return (
    <Sheet label="Menu" onClose={onClose}>
      <div className="sheet-nav">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={navClass} onClick={onClose}>
            {n.icon} {n.label}
          </NavLink>
        ))}
      </div>
      <div className="sheet-tools">
        <OrchestratorSwitch />
        <UsagePill />
        <ServerControl />
        <div className="sheet-tool-row">
          <CommandsLauncher onOpenTerminal={onOpenTerminal} />
          <ThemeToggle />
        </div>
      </div>
      <div className="sheet-foot mono">{servedFrom()}</div>
    </Sheet>
  );
}

/** NavLink's own matching: `/` exactly, anything else as a path prefix. */
function owns(to: string, pathname: string) {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
}

function TabBar({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const tabs = useNav().filter((n) => n.primary);
  const { pathname } = useLocation();
  // Glass's lens sits under the tab that owns this page; a page reached from
  // the More sheet belongs to More. Classic ignores both variables.
  const owner = moreOpen ? -1 : tabs.findIndex((n) => owns(n.to, pathname));
  const lens = owner === -1 ? tabs.length : owner;
  const lensVars = { '--tab-i': lens, '--tab-n': tabs.length + 1 } as CSSProperties;
  return (
    <nav className="tabbar" aria-label="Primary" style={lensVars}>
      {tabs.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} className={navClass}>
          {n.icon}
          <span>{n.label}</span>
        </NavLink>
      ))}
      <button
        type="button"
        className={`nav-link ${moreOpen ? 'active' : ''}${lens === tabs.length ? ' here' : ''}`}
        aria-expanded={moreOpen}
        onClick={onMore}
      >
        <IconMore />
        <span>More</span>
      </button>
    </nav>
  );
}

export function Layout({
  children,
  onOpenTerminal,
  onOpenTask,
  inboxReturn,
}: {
  children: ReactNode;
  onOpenTerminal: (runId: string, from?: ReturnTo) => void;
  onOpenTask: (taskId: string) => void;
  /** a closed terminal returning to the Inbox sheet it was opened from */
  inboxReturn: InboxReturn | null;
}) {
  const mobile = useIsMobile();
  const nav = useNav();
  const [moreOpen, setMoreOpen] = useState(false);
  // the phone's Inbox sheet stack, opened from the header chip (docs/inbox.md)
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxKey, setInboxKey] = useState<string | null>(null);
  const navigate = useNavigate();
  const inboxNav = useMemo(() => ({ onOpenTask, onOpenTerminal }), [onOpenTask, onOpenTerminal]);
  const { pathname } = useLocation();
  // A sheet left open across a breakpoint change or a navigation would sit over
  // a layout that no longer has a tab bar under it.
  useEffect(() => {
    setMoreOpen(false);
    setInboxOpen(false);
    setInboxKey(null);
  }, [mobile, pathname]);
  useEffect(() => {
    if (!inboxReturn?.sheet || !mobile) return;
    setInboxKey(inboxReturn.key);
    setInboxOpen(true);
  }, [inboxReturn]);
  // Glass's row cascade runs only while a section is entering (glass.css § motion):
  // a reorder moves rows, and a moved row would replay an always-on animation.
  const mainRef = useRef<HTMLElement>(null);
  const section = pathname.split('/')[1] ?? '';
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    main.dataset.entering = '';
    const t = setTimeout(() => delete main.dataset.entering, 900);
    return () => clearTimeout(t);
  }, [section]);
  // Scroll lock and Escape live in <Sheet>, shared with every other sheet.

  return (
    <div className={`app${mobile ? ' mobile' : ''}`}>
      {!mobile && (
        <aside className="sidebar">
          <div className="brand">
            <span className="tm">tm_</span>manager
            <span className="sub">tasks · agents · terminals</span>
          </div>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={navClass}>
              {n.icon} {n.label}
            </NavLink>
          ))}
          <div className="sidebar-foot">{servedFrom()}</div>
        </aside>
      )}
      {/* Glass only: the blur the page scrolls under (glass.css § the shell) */}
      <div className="edge-top" aria-hidden="true" />
      <header className="header">
        {mobile && (
          <span className="brand-mini">
            <span className="tm">tm_</span>manager
          </span>
        )}
        {!mobile && <OrchestratorSwitch />}
        <RunCount state={mobile} />
        {/* A phone's bar holds four capsules: there the Inbox chip stands in
            for the question chip (questions head the Inbox). */}
        {!mobile && <QuestionChip />}
        <InboxChip compact={mobile} onClick={() => (mobile ? setInboxOpen(true) : navigate('/inbox'))} />
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
      <main className="main" ref={mainRef}>
        {mobile && <OfflineBanner />}
        {children}
      </main>
      {mobile && <TabBar moreOpen={moreOpen} onMore={() => setMoreOpen((v) => !v)} />}
      {mobile && moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} onOpenTerminal={onOpenTerminal} />}
      {mobile && inboxOpen && (
        <InboxSheet
          nav={inboxNav}
          initialKey={inboxKey}
          onClose={() => {
            setInboxOpen(false);
            setInboxKey(null);
          }}
        />
      )}
    </div>
  );
}
