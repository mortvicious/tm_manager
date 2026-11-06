import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CONCURRENCY_MAX,
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  OFFICE_AUTONOMY_LEVELS,
  OFFICE_EVENT_LABELS,
  OFFICE_EVENT_NAMES,
  OFFICE_GUARD_KINDS,
  OFFICE_MAX_OPEN_TASKS_MAX,
  OFFICE_MAX_TASKS_PER_SHIFT_MAX,
  OFFICE_OVER_BUDGET_REASON,
  OFFICE_ROLE_COMMANDS_MAX,
  OFFICE_ROLE_KEY_RE,
  OFFICE_ROLE_PRESETS,
  OFFICE_THEME_LABELS,
  officeThemeId,
  OFFICE_WAKE_NOTE_MAX,
  isFeatureAskTrigger,
  OFFICE_SIGNAL_SOURCES,
  isStandupRole,
  SHIFT_FORBIDDEN_TOOLS,
  SHIFT_TOOL_ALLOWLIST,
  SHIFT_WEB_TOOLS,
  cronError,
  describeGuard,
  formatOfficeTime,
  guardError,
  isValidTimeZone,
  nextCronSlot,
  nextOfficeDayStart,
  officeBudgetTrippedToday,
  type EffortLevel,
  type Office,
  type OfficeAutonomy,
  type OfficeBrief,
  type OfficeRating,
  type OfficeBriefView,
  type OfficeDetail,
  type OfficeEventName,
  type OfficeGuard,
  type OfficeGuardKind,
  type OfficeNotesReview,
  type OfficeRole,
  type OfficeRoleCommand,
  type OfficeRolePreset,
  type OfficeRoleStateEntry,
  type OfficeShift,
  type OfficeStates,
  type OfficeTrigger,
  type OfficeSignalSource,
  type RepoCommand,
  type Workspace,
} from '@tm/shared';
import { api } from '../api.ts';
import { onTick } from '../clock.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { useIsMobile } from '../components/Layout.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { OfficeVision } from '../components/OfficeVision.tsx';
import { OfficeChannel } from '../components/OfficeChannel.tsx';
import { OfficeScorecard } from '../components/OfficeScorecard.tsx';
import { OfficeChat } from '../components/OfficeChat.tsx';
import { OfficeHuddles } from '../components/OfficeHuddles.tsx';
import { RatingButtons, ratingKey, useOfficeRatings } from '../components/OfficeRating.tsx';
import { OfficeWork } from '../components/OfficeWork.tsx';
import { OfficeMetricsPanel, RoleMetrics } from '../components/OfficeMetrics.tsx';
import { OfficePlace } from '../components/office/OfficePlace.tsx';
import { OFFICE_THEMES, useOfficeViewMode, type OfficeViewMode } from '../officeThemes.ts';
import { OfficeAssistant, OfficePlannerFlow } from '../components/OfficePlanner.tsx';
import { useNow } from '../components/TimeAgo.tsx';
import { useArm } from '../arm.ts';
import { toastError } from '../toast.ts';
import { useWorkspace } from '../workspace.ts';

/**
 * The Virtual Office page (docs/office.md § The /office page): the CURRENT
 * workspace's office — its settings, each role as a row with its live state,
 * the role editor and the shift log. All (no `?ws`) lists the workspaces and
 * their offices; picking one switches the workspace. Every write goes through
 * the Origin-gated `/api/offices` routes and the page follows `office.updated`
 * (the event carries the office, sometimes roles and states; the shift log is
 * re-read on it, since no event carries shifts). A phone gets role cards with
 * the editor, the settings and the shift log in `<Sheet>`s.
 */

type Props = { onOpenTask: (id: string) => void; onOpenTerminal: (runId: string) => void };

const usd = (n: number) => `$${n.toFixed(n !== 0 && Math.abs(n) < 1 ? 2 : n % 1 === 0 ? 0 : 2)}`;
const short = (id: string) => id.slice(0, 8);

const AUTONOMY_LABEL: Record<OfficeAutonomy, string> = {
  proposals: 'proposals — files nothing, you convert',
  'auto-run': 'auto-run — files queued tasks',
  autonomous: 'autonomous — files queued tasks',
};

const TRIGGER_KIND_LABEL: Record<OfficeShift['trigger']['kind'], string> = {
  cron: 'schedule',
  event: 'event',
  signal: 'signal',
  request: 'wake now',
  huddle: 'huddle turn',
};

/** a stored taint label (`kind:ref`) as words */
function taintText(label: string): string {
  const i = label.indexOf(':');
  const kind = i < 0 ? label : label.slice(0, i);
  const ref = i < 0 ? '' : label.slice(i + 1);
  const words: Record<string, string> = {
    signal: 'outside signal',
    'web-tool': 'web tool',
    'command-output': 'external command output',
    'tainted-notes': 'tainted notes',
    'tainted-artifact': 'tainted artifact',
    'tainted-session': 'tainted session',
    'tainted-huddle': 'tainted huddle',
  };
  return `${words[kind] ?? kind}${ref ? ` ${ref}` : ''}`;
}

function errText(e: unknown): string {
  return (e as Error)?.message || String(e);
}

// ---------------------------------------------------------------------------
// Data: one office, live
// ---------------------------------------------------------------------------

/** The offices list, upserted from `office.updated`. */
function useOffices() {
  const [offices, setOffices] = useState<Office[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.listOffices().then(
      (l) => (setOffices(l), setError(null)),
      (e) => setError(errText(e)),
    );
  }, []);
  useEffect(() => {
    reload();
    return onServerEvent((e) => {
      if (e.type !== 'office.updated') return;
      setOffices((cur) => {
        if (!cur) return cur;
        const i = cur.findIndex((o) => o.id === e.office.id);
        return i < 0 ? [...cur, e.office] : cur.map((o) => (o.id === e.office.id ? e.office : o));
      });
    });
  }, [reload]);
  return { offices, error, reload };
}

/**
 * The office's detail (roles + shift log) and states. `office.updated` is
 * applied as it comes (office, roles, states when present) and schedules a
 * re-read of the detail — the shift log has no event of its own. A 60 s
 * refresh catches what no event announces (the scheduler only broadcasts
 * states that CHANGED, and a running shift's cost moves silently).
 */
function useOfficeDetail(officeId: string) {
  const [detail, setDetail] = useState<OfficeDetail | null>(null);
  const [states, setStates] = useState<OfficeStates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reload = useCallback(() => {
    api.getOffice(officeId).then(
      (d) => (setDetail(d), setError(null)),
      (e) => setError(errText(e)),
    );
    api.officeStates(officeId).then(setStates, () => {});
  }, [officeId]);
  const soon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, 400);
  }, [reload]);
  useEffect(() => {
    setDetail(null);
    setStates(null);
    reload();
    // the shared clock (src/clock.ts): paused while hidden, re-read on return
    const offTick = onTick(60_000, reload);
    const off = onServerEvent((e) => {
      if (e.type !== 'office.updated' || e.office.id !== officeId) return;
      setDetail((cur) => (cur ? { ...cur, office: e.office, roles: e.roles ?? cur.roles } : cur));
      if (e.states) setStates(e.states);
      soon();
    });
    return () => {
      offTick();
      clearTimeout(timer.current);
      off();
    };
  }, [officeId, reload, soon]);
  return { detail, states, error, reload: soon };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function OfficePage({ onOpenTask, onOpenTerminal }: Props) {
  const { workspace, setWorkspace } = useWorkspace();
  const { workspaces } = useApp();
  const { offices, error, reload } = useOffices();
  const office = workspace && offices ? (offices.find((o) => o.workspaceId === workspace.id) ?? null) : null;
  const [briefId] = useBriefParam();
  // A deep link (`/office?brief=<id>`, the push ping) names a brief, not a
  // workspace: switch to the brief's workspace so its office opens with it.
  useEffect(() => {
    if (!briefId) return;
    let live = true;
    api.getOfficeBrief(briefId).then(
      (v) => {
        if (!live || v.workspaceId === workspace?.id) return;
        const ws = workspaces.find((w) => w.id === v.workspaceId);
        if (ws) setWorkspace(ws.slug);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [briefId, workspace?.id, workspaces, setWorkspace]);

  return (
    <div className="office-page">
      <h1 className="page-title">Office{workspace ? ` · ${workspace.name}` : ''}</h1>
      {error && <div className="warn-text">{error}</div>}
      {!workspace ? (
        <OfficeList offices={offices} />
      ) : offices === null ? (
        <div className="muted">Loading…</div>
      ) : office ? (
        <OfficeView key={office.id} officeId={office.id} onOpenTask={onOpenTask} onOpenTerminal={onOpenTerminal} />
      ) : (
        <NoOffice key={workspace.id} workspace={workspace} onCreated={reload} />
      )}
    </div>
  );
}

/** All: every workspace and its office; a pick switches the workspace (the office lives there). */
function OfficeList({ offices }: { offices: Office[] | null }) {
  const { workspaces } = useApp();
  const { setWorkspace } = useWorkspace();
  if (offices === null) return <div className="muted">Loading…</div>;
  if (workspaces.length === 0) {
    return (
      <div className="empty panel">
        <div className="big">No workspaces yet</div>
        An office belongs to a workspace — create one in Config → Workspaces first.
      </div>
    );
  }
  return (
    <div className="panel office-list">
      <div className="office-section-title">Pick a workspace — each can have one office</div>
      {workspaces.map((w) => {
        const o = offices.find((x) => x.workspaceId === w.id);
        return (
          <button key={w.id} className="office-list-row" onClick={() => setWorkspace(w.slug)}>
            <span className="office-list-name">{w.name}</span>
            <span className="muted office-list-sub">
              {o
                ? `${o.enabled ? 'on' : 'off'}${o.pausedAt ? ' · paused' : ''} · ${usd(o.dayBudgetUsd)}/day · ${o.autonomy}`
                : 'no office yet'}
            </span>
            <span className={`chip office-onoff${o?.enabled ? ' on' : ''}`}>{o ? (o.enabled ? 'on' : 'off') : 'create'}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * No office yet: the plain create form, or the planner (docs/office.md §
 * Office planner) — opened by its button, or straight away when this
 * workspace already has a planner conversation going.
 */
function NoOffice({ workspace, onCreated }: { workspace: Workspace; onCreated: () => void }) {
  const mobile = useIsMobile();
  const [planning, setPlanning] = useState(false);
  useEffect(() => {
    let live = true;
    api.getOfficePlanner(workspace.id).then(
      (v) => live && v.chat && setPlanning(true),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [workspace.id]);
  const flow = <OfficePlannerFlow workspace={workspace} inSheet={mobile} onCreated={onCreated} onCancel={() => setPlanning(false)} />;
  return (
    <>
      {!(planning && !mobile) && <CreateOffice workspace={workspace} onCreated={onCreated} onPlan={() => setPlanning(true)} />}
      {planning && !mobile && flow}
      {planning && mobile && (
        <Sheet label="Plan an office" title="Plan with the assistant" onClose={() => setPlanning(false)} disableDrag tall>
          {flow}
        </Sheet>
      )}
    </>
  );
}

function CreateOffice({ workspace, onCreated, onPlan }: { workspace: Workspace; onCreated: () => void; onPlan: () => void }) {
  const [folder, setFolder] = useState('');
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [theme, setTheme] = useState<string>(OFFICE_THEMES[0].id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tzBad = tz.trim() !== '' && !isValidTimeZone(tz.trim());
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.createOffice({
        workspaceId: workspace.id,
        ...(folder.trim() ? { folderPath: folder.trim() } : {}),
        ...(tz.trim() ? { timezone: tz.trim() } : {}),
        theme,
      });
      onCreated();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel office-create">
      <div className="office-section-title">No office in {workspace.name} yet</div>
      <p className="muted office-help">
        An office gives this workspace standing roles — a director, a developer, devops, QA, SEO — that wake on a schedule, run one
        read-only shift and file the work they find as tasks. It starts switched off: you set a day budget, then turn it on.
      </p>
      <div className="form-grid">
        <div>
          <label className="label">Folder (notes, briefs, deliverables — outside every repo)</label>
          <input
            className="field"
            value={folder}
            placeholder="default: <shared space folder>/office"
            onChange={(e) => setFolder(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Time zone (schedules, quiet hours and the budget day)</label>
          <input className="field" value={tz} onChange={(e) => setTz(e.target.value)} />
          {tzBad && <div className="warn-text">not an IANA zone (like Europe/Berlin)</div>}
        </div>
        <div>
          <label className="label">Theme (the Office view's skin and the roles' generated names)</label>
          <select className="field" value={theme} onChange={(e) => setTheme(e.target.value)}>
            {OFFICE_THEMES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {err && <div className="warn-text">{err}</div>}
      <div className="office-actions">
        <button className="btn primary" disabled={busy || tzBad} onClick={() => void create()}>
          Create office
        </button>
        <button className="btn" onClick={onPlan}>
          Plan with the assistant
        </button>
        <span className="office-hint muted">a short wizard, then one read-only session reads the repos and drafts the office for you to edit</span>
      </div>
    </div>
  );
}

function OfficeView({ officeId, onOpenTask, onOpenTerminal }: { officeId: string } & Props) {
  const mobile = useIsMobile();
  const now = useNow();
  const { detail, states, error, reload } = useOfficeDetail(officeId);
  const [editing, setEditing] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'settings' | 'log' | 'briefs' | 'vision' | 'ask' | 'channel' | 'huddles' | 'chat' | 'assistant' | 'work' | 'scorecard' | 'metrics' | null>(null);
  const briefs = useOfficeBriefs(officeId);
  const ratings = useOfficeRatings({ officeId });
  const [briefId, setBriefId] = useBriefParam();
  const [mode, setMode] = useOfficeViewMode();

  if (!detail) return error ? <div className="warn-text">{error}</div> : <div className="muted">Loading…</div>;
  const { office, roles, shifts } = detail;
  const shiftFeatures = detail.shiftFeatures ?? {};
  const director = roles.find((r) => isStandupRole(r) && r.enabled) ?? roles.find((r) => isStandupRole(r)) ?? null;
  const stateOf = (id: string) => states?.states.find((s) => s.roleId === id) ?? null;
  const editRole = editing ? (roles.find((r) => r.id === editing) ?? null) : null;

  const settings = <OfficeSettings office={office} spentToday={states?.spentTodayUsd ?? null} />;
  const log = (
    <ShiftLog
      office={office}
      roles={roles}
      shifts={shifts}
      shiftFeatures={shiftFeatures}
      inSheet={mobile}
      onOpenTask={onOpenTask}
      onOpenTerminal={onOpenTerminal}
    />
  );
  const ask = <AskDirector office={office} director={director} onAsked={reload} />;
  const channel = <OfficeChannel office={office} roles={roles} inSheet={mobile} onOpenTask={onOpenTask} />;
  const chat = <OfficeChat office={office} roles={roles} inSheet={mobile} />;
  const assistant = <OfficeAssistant office={office} roles={roles} inSheet={mobile} />;
  const huddles = <OfficeHuddles office={office} roles={roles} inSheet={mobile} onOpenTask={onOpenTask} />;
  const briefList = (
    <BriefList office={office} roles={roles} briefs={briefs} ratings={ratings} selected={briefId} inSheet={mobile} onSelect={(id) => setBriefId(id === briefId ? null : id)} />
  );
  const viewer = briefId && <BriefViewer key={briefId} office={office} briefId={briefId} ratings={ratings} inSheet={mobile} onClose={() => setBriefId(null)} />;
  const work = <OfficeWork office={office} roles={roles} ratings={ratings} inSheet={mobile} onOpenTask={onOpenTask} />;
  const metricsPanel = <OfficeMetricsPanel office={office} roles={roles} />;
  const editor = editRole && (
    <RoleEditor key={editRole.id} office={office} role={editRole} inSheet={mobile} onClose={() => setEditing(null)} onSaved={reload} />
  );

  return (
    <BriefOpen.Provider value={setBriefId}>
      <OfficeBanner office={office} spentToday={states?.spentTodayUsd ?? null} now={now} />
      <OfficeStatusBar office={office} spentToday={states?.spentTodayUsd ?? null} />
      {mobile ? (
        <div className="office-phone-bar">
          <button className="btn" onClick={() => setSheet('settings')}>
            Settings
          </button>
          <button className="btn" onClick={() => setSheet('assistant')}>
            Assistant
          </button>
          <button className="btn" onClick={() => setSheet('vision')}>
            Vision &amp; wishes
          </button>
          <button className="btn" onClick={() => setSheet('ask')}>
            Ask the Director
          </button>
          <button className="btn" onClick={() => setSheet('chat')}>
            Chat
          </button>
          <button className="btn" onClick={() => setSheet('channel')}>
            Channel
          </button>
          <button className="btn" onClick={() => setSheet('huddles')}>
            Huddles
          </button>
          <button className="btn" onClick={() => setSheet('briefs')}>
            Briefs <span className="muted">{briefs?.length ?? ''}</span>
          </button>
          <button className="btn" onClick={() => setSheet('work')}>
            Rate the work
          </button>
          <button className="btn" onClick={() => setSheet('scorecard')}>
            Scorecard
          </button>
          <button className="btn" onClick={() => setSheet('metrics')}>
            Metrics
          </button>
          <button className="btn" onClick={() => setSheet('log')}>
            Shift log <span className="muted">{shifts.length}</span>
          </button>
        </div>
      ) : null}

      <OfficeViewSwitch mode={mode} onChange={setMode} />
      {mode === 'place' ? (
        <OfficePlace
          officeId={office.id}
          mobile={mobile}
          onOpenTask={onOpenTask}
          onOpenTerminal={onOpenTerminal}
          onOpenBrief={setBriefId}
          onEditRole={(id) => setEditing(id)}
        />
      ) : (
        <div className="panel office-roles">
          <div className="office-section-title">
            Roles <span className="muted">{roles.length}</span>
          </div>
          {roles.length === 0 && <div className="muted office-pad">No roles — add one from a preset below.</div>}
          {roles.map((r) => (
            <RoleRow
              key={r.id}
              office={office}
              role={r}
              state={stateOf(r.id)}
              now={now}
              editing={editing === r.id}
              onEdit={() => setEditing(editing === r.id ? null : r.id)}
            />
          ))}
          <AddRole office={office} />
        </div>
      )}

      {editor && !mobile && <div className="panel office-editor-panel">{editor}</div>}
      {!mobile && settings}
      {!mobile && (
        <div className="panel">
          <OfficeScorecard office={office} />
        </div>
      )}

      {!mobile && (
        <div className="panel">
          <div className="office-section-title">Vision &amp; wishes</div>
          <OfficeVision office={office} />
        </div>
      )}
      {!mobile && (
        <div className="panel">
          <div className="office-section-title">Ask the Director for a feature</div>
          {ask}
        </div>
      )}
      {!mobile && <div className="panel">{assistant}</div>}
      {!mobile && <div className="panel">{chat}</div>}
      {!mobile && <div className="panel">{channel}</div>}
      {!mobile && <div className="panel">{huddles}</div>}
      {mobile && sheet === 'assistant' && (
        <Sheet label="Office assistant" title="Assistant" onClose={() => setSheet(null)} disableDrag tall>
          {assistant}
        </Sheet>
      )}
      {mobile && sheet === 'chat' && (
        <Sheet label="Office group chat" title="Group chat" onClose={() => setSheet(null)} disableDrag tall>
          {chat}
        </Sheet>
      )}
      {mobile && sheet === 'huddles' && (
        <Sheet label="Office huddles" title="Huddles" onClose={() => setSheet(null)} disableDrag tall>
          {huddles}
        </Sheet>
      )}
      {mobile && sheet === 'channel' && (
        <Sheet label="Office channel" title="Channel" onClose={() => setSheet(null)} disableDrag tall>
          {channel}
        </Sheet>
      )}
      {mobile && sheet === 'ask' && (
        <Sheet label="Ask the Director for a feature" title="Ask the Director" onClose={() => setSheet(null)} disableDrag>
          {ask}
        </Sheet>
      )}
      {mobile && sheet === 'vision' && (
        <Sheet label="Vision and wishes" title="Vision & wishes" onClose={() => setSheet(null)} disableDrag tall>
          <OfficeVision office={office} />
        </Sheet>
      )}
      {editor && mobile && (
        <Sheet label={`Edit ${editRole!.name}`} title={`${editRole!.avatar} ${editRole!.name}`} onClose={() => setEditing(null)} disableDrag tall>
          {editor}
        </Sheet>
      )}

      {!mobile && (
        <div className="panel office-briefs">
          {briefList}
          {viewer}
        </div>
      )}
      {!mobile && <div className="panel">{metricsPanel}</div>}
      {!mobile && <div className="panel">{work}</div>}
      {!mobile && log}
      {mobile && sheet === 'briefs' && !briefId && (
        <Sheet label="Briefs" title="Briefs" onClose={() => setSheet(null)} tall>
          {briefList}
        </Sheet>
      )}
      {mobile && viewer && (
        <Sheet label="Brief" title="Brief" onClose={() => setBriefId(null)} tall>
          {viewer}
        </Sheet>
      )}
      {mobile && sheet === 'settings' && (
        <Sheet label="Office settings" title="Office settings" onClose={() => setSheet(null)} disableDrag tall>
          {settings}
        </Sheet>
      )}
      {mobile && sheet === 'work' && (
        <Sheet label="Rate the work" title="Rate the work" onClose={() => setSheet(null)} tall>
          {work}
        </Sheet>
      )}
      {mobile && sheet === 'scorecard' && (
        <Sheet label="Office scorecard" title="Scorecard" onClose={() => setSheet(null)} tall>
          <OfficeScorecard office={office} />
        </Sheet>
      )}
      {mobile && sheet === 'metrics' && (
        <Sheet label="Product metrics" title="Product metrics" onClose={() => setSheet(null)} tall>
          {metricsPanel}
        </Sheet>
      )}
      {mobile && sheet === 'log' && (
        <Sheet label="Shift log" title="Shift log" onClose={() => setSheet(null)} tall>
          {log}
        </Sheet>
      )}
      {error && <div className="warn-text">{error}</div>}
    </BriefOpen.Provider>
  );
}

/** The office as a place (docs/office.md § The view) or the phase-2 role list; per device (`tm.officeView`). */
function OfficeViewSwitch({ mode, onChange }: { mode: OfficeViewMode; onChange: (m: OfficeViewMode) => void }) {
  return (
    <div className="ov-switch">
      <div className="rm-seg" role="radiogroup" aria-label="Office view">
        {(['place', 'list'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => onChange(m)}>
            {m === 'place' ? 'Office' : 'List'}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Office over budget until midnight", or why the office is paused. */
function OfficeBanner({ office, spentToday, now }: { office: Office; spentToday: number | null; now: number }) {
  if (office.killSwitch) {
    return (
      <div className="office-banner paused" role="status">
        <strong>Kill switch on.</strong> Every task of this office lands supervised and no push of its is auto-approved, whatever the repos opted in to.
      </div>
    );
  }
  if (officeBudgetTrippedToday(office, now)) {
    const midnight = nextOfficeDayStart(now, office.timezone);
    return (
      <div className="office-banner over" role="status">
        <strong>Office over budget until midnight.</strong>{' '}
        {spentToday !== null ? `Spent ${usd(spentToday)} of ${usd(office.dayBudgetUsd)} today. ` : ''}
        No shift starts and the office's queued tasks wait until {formatOfficeTime(midnight, now, office.timezone)} ({office.timezone}
        ) — or raise the day budget.
      </div>
    );
  }
  if (office.pausedAt && office.pausedReason !== OFFICE_OVER_BUDGET_REASON) {
    return (
      <div className="office-banner paused" role="status">
        <strong>Office paused</strong>
        {office.pausedReason ? ` — ${office.pausedReason}` : ''}. No shift starts and its queued tasks wait until you continue.
      </div>
    );
  }
  return null;
}

/** On/off, pause/continue and today's spend — always visible, both layouts. */
function OfficeStatusBar({ office, spentToday }: { office: Office; spentToday: number | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const patch = async (b: Parameters<typeof api.updateOffice>[1]) => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateOffice(office.id, b);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => !busy && void patch({ enabled: !office.enabled });
  return (
    <div className="panel office-status">
      <div className="office-switch">
        <span
          className={`switch ${office.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={office.enabled}
          aria-disabled={busy}
          aria-label="Office on"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), toggle())}
        >
          <span className="track">
            <span className="knob" />
          </span>
        </span>
        <span>{office.enabled ? 'Office on' : 'Office off'}</span>
      </div>
      <span className="muted office-status-text">
        {spentToday !== null ? `${usd(spentToday)} of ${usd(office.dayBudgetUsd)} today` : `${usd(office.dayBudgetUsd)}/day`}
        {!(office.dayBudgetUsd > 0) ? ' · set a day budget to turn it on' : ''}
      </span>
      <span style={{ flex: 1 }} />
      <KillSwitchButton office={office} />
      <button className="btn" disabled={busy} onClick={() => void patch({ paused: !office.pausedAt })}>
        {office.pausedAt ? 'Continue' : 'Pause'}
      </button>
      {err && <div className="warn-text office-status-err">{err}</div>}
    </div>
  );
}

/**
 * The office kill switch (docs/office.md § Autonomous opt-in): one press takes
 * the autonomy opt-in's two powers — landing above supervised, auto-approved
 * pushes — from every task of this office at once; releasing asks first. The
 * count is the server's reading (`OrchestratorStatus.autonomous`).
 */
function KillSwitchButton({ office }: { office: Office }) {
  const { orch } = useApp();
  const [busy, setBusy] = useState(false);
  const autonomous = (orch?.autonomous ?? []).filter((t) => t.officeId === office.id).length;
  const press = async () => {
    const on = !office.killSwitch;
    if (!on && !window.confirm('Release the kill switch? Tasks of this office may land without you again where a repo opted in and nothing they read was tainted.')) return;
    setBusy(true);
    try {
      await api.setOfficeKillSwitch(office.id, on);
    } catch (e) {
      toastError(e, on ? 'Kill switch' : 'Release kill switch');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className={`btn${office.killSwitch ? ' danger' : ''}`}
      disabled={busy}
      aria-pressed={office.killSwitch}
      title={
        office.killSwitch
          ? 'Kill switch on: every task of this office lands supervised and no push is auto-approved. Press to release.'
          : `Take autonomy away from every task of this office at once${autonomous ? ` — ${autonomous} would land without you now` : ''}.`
      }
      onClick={() => void press()}
    >
      {office.killSwitch ? 'Kill switch on' : `Kill switch${autonomous ? ` · ${autonomous} autonomous` : ''}`}
    </button>
  );
}

function numOr(v: string, fallback: number): number {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : fallback;
}

function OfficeSettings({ office, spentToday }: { office: Office; spentToday: number | null }) {
  const [budget, setBudget] = useState(String(office.dayBudgetUsd));
  const [autonomy, setAutonomy] = useState<OfficeAutonomy>(office.autonomy);
  const [slots, setSlots] = useState(String(office.maxSlots));
  const [perShift, setPerShift] = useState(String(office.maxTasksPerShift));
  const [open, setOpen] = useState(String(office.maxOpenTasks));
  const [tz, setTz] = useState(office.timezone);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // a saved (or another tab's) change re-seeds the fields
  useEffect(() => {
    setBudget(String(office.dayBudgetUsd));
    setAutonomy(office.autonomy);
    setSlots(String(office.maxSlots));
    setPerShift(String(office.maxTasksPerShift));
    setOpen(String(office.maxOpenTasks));
    setTz(office.timezone);
  }, [office.dayBudgetUsd, office.autonomy, office.maxSlots, office.maxTasksPerShift, office.maxOpenTasks, office.timezone]);

  const body: Parameters<typeof api.updateOffice>[1] = {};
  if (numOr(budget, office.dayBudgetUsd) !== office.dayBudgetUsd) body.dayBudgetUsd = numOr(budget, office.dayBudgetUsd);
  if (autonomy !== office.autonomy) body.autonomy = autonomy;
  if (numOr(slots, office.maxSlots) !== office.maxSlots) body.maxSlots = numOr(slots, office.maxSlots);
  if (numOr(perShift, office.maxTasksPerShift) !== office.maxTasksPerShift) body.maxTasksPerShift = numOr(perShift, office.maxTasksPerShift);
  if (numOr(open, office.maxOpenTasks) !== office.maxOpenTasks) body.maxOpenTasks = numOr(open, office.maxOpenTasks);
  if (tz.trim() && tz.trim() !== office.timezone) body.timezone = tz.trim();
  const dirty = Object.keys(body).length > 0;
  const tzBad = !!tz.trim() && !isValidTimeZone(tz.trim());

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateOffice(office.id, body);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel office-settings">
      <div className="office-section-title">Settings</div>
      <div className="form-grid office-settings-grid">
        <div>
          <label className="label">Day budget (USD, office-local day)</label>
          <input className="field" type="number" min={0} step={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
          <div className="muted office-hint">
            {spentToday !== null ? `spent ${usd(spentToday)} today · ` : ''}required above $0 to turn the office on
          </div>
        </div>
        <div>
          <label className="label">Autonomy</label>
          <select className="field" value={autonomy} onChange={(e) => setAutonomy(e.target.value as OfficeAutonomy)}>
            {OFFICE_AUTONOMY_LEVELS.map((a) => (
              <option key={a} value={a}>
                {AUTONOMY_LABEL[a]}
              </option>
            ))}
          </select>
          <div className="muted office-hint">a tainted shift or a stopped queue always files drafts</div>
        </div>
        <div>
          <label className="label">Max slots (office tasks at once)</label>
          <input className="field" type="number" min={1} max={CONCURRENCY_MAX} value={slots} onChange={(e) => setSlots(e.target.value)} />
        </div>
        <div>
          <label className="label">Tasks per shift (≤ {OFFICE_MAX_TASKS_PER_SHIFT_MAX})</label>
          <input
            className="field"
            type="number"
            min={1}
            max={OFFICE_MAX_TASKS_PER_SHIFT_MAX}
            value={perShift}
            onChange={(e) => setPerShift(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Open tasks at once (≤ {OFFICE_MAX_OPEN_TASKS_MAX})</label>
          <input
            className="field"
            type="number"
            min={1}
            max={OFFICE_MAX_OPEN_TASKS_MAX}
            value={open}
            onChange={(e) => setOpen(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Time zone</label>
          <input className="field" value={tz} onChange={(e) => setTz(e.target.value)} />
          {tzBad && <div className="warn-text">not an IANA zone (like Europe/Berlin)</div>}
        </div>
        <div>
          <label className="label">Theme</label>
          <div className="field office-readonly">{OFFICE_THEME_LABELS[officeThemeId(office.theme)]}</div>
          <div className="muted office-hint">set at creation (it named the roles); the Office view draws this skin when it is implemented, else the default; a device may pick its own</div>
        </div>
        <div>
          <label className="label">Folder</label>
          <div className="field office-readonly mono">{office.folderPath}</div>
        </div>
      </div>
      {err && <div className="warn-text">{err}</div>}
      <div className="office-actions">
        <button className="btn primary" disabled={busy || !dirty || tzBad} onClick={() => void save()}>
          Save settings
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function RoleRow({
  office,
  role,
  state,
  now,
  editing,
  onEdit,
}: {
  office: Office;
  role: OfficeRole;
  state: OfficeRoleStateEntry | null;
  now: number;
  editing: boolean;
  onEdit: () => void;
}) {
  const arm = useArm();
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const web = role.tools.filter((t) => SHIFT_WEB_TOOLS.includes(t));
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const next = state?.nextSlotAt ? formatOfficeTime(Date.parse(state.nextSlotAt), now, office.timezone) : null;
  return (
    <div className={`office-role${editing ? ' editing' : ''}${role.enabled ? '' : ' off'}`}>
      <div className="office-role-main">
        <span className="office-avatar" aria-hidden>
          {role.avatar}
        </span>
        <div className="office-role-who">
          <div className="office-role-name">
            {role.name} <span className="muted office-role-title">{role.title}</span>
          </div>
          <div className="office-role-state">
            {state ? (
              <>
                <span className={`chip office-state s-${state.state}`}>{state.state}</span>
                <span className="muted office-role-detail">{state.detail}</span>
              </>
            ) : (
              <span className="muted">…</span>
            )}
          </div>
        </div>
        <dl className="office-role-facts">
          <div>
            <dt>next</dt>
            <dd>{next ?? '—'}</dd>
          </div>
          <div>
            <dt>today</dt>
            <dd>{state ? usd(state.spentTodayUsd) : '—'}</dd>
          </div>
          <div>
            <dt>cap</dt>
            <dd>{role.capUsd === null ? '—' : usd(role.capUsd)}</dd>
          </div>
          <div>
            <dt>autonomy</dt>
            <dd>{role.autonomy ?? <span className="muted">office's</span>}</dd>
          </div>
        </dl>
      </div>
      {(web.length > 0 || role.notesTaintedAt || role.sessionTainted || !role.enabled) && (
        <div className="office-role-flags">
          {!role.enabled && <span className="chip">role off</span>}
          {web.length > 0 && (
            <span className="chip office-taint" title="a shift that uses one of these is tainted: drafts only, digest-only to later shifts">
              {web.join(' · ')} · taints
            </span>
          )}
          {role.notesTaintedAt && (
            <span className="chip office-taint" title={`a tainted shift wrote ${role.notesPath}`}>
              notes tainted
            </span>
          )}
          {role.sessionTainted && <span className="chip office-taint">session tainted</span>}
        </div>
      )}
      <div className="office-role-actions">
        <button className="btn primary" disabled={busy} onClick={() => setWaking((w) => !w)}>
          Wake now
        </button>
        <button className={`btn${editing ? ' on' : ''}`} onClick={onEdit}>
          {editing ? 'Close editor' : 'Edit'}
        </button>
        <button
          className={`btn${arm.armed === 'reset' ? ' danger' : ''}`}
          disabled={busy}
          onClick={() => arm.press('reset') && void run(() => api.resetOfficeRoleNotes(office.id, role.id))}
        >
          {arm.armed === 'reset' ? 'Reset notes? tap again' : 'Reset notes'}
        </button>
        {role.notesTaintedAt && (
          <button
            className={`btn${reviewing ? ' on' : ''}`}
            title={`read the notes a tainted shift wrote, then vouch for that exact version`}
            onClick={() => setReviewing((r) => !r)}
          >
            {reviewing ? 'Close notes' : 'Review notes'}
          </button>
        )}
      </div>
      {waking && (
        <div className="office-wake">
          <textarea
            className="field"
            rows={2}
            maxLength={OFFICE_WAKE_NOTE_MAX}
            placeholder="Optional note for this shift (what you want looked at)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="office-actions">
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void run(() => api.wakeOfficeRole(office.id, role.id, note.trim() || undefined), () => (setWaking(false), setNote('')))}
            >
              Wake {role.name}
            </button>
            <button className="btn ghost" onClick={() => setWaking(false)}>
              Cancel
            </button>
            <span className="muted office-hint">the hard gate still applies; guards and cooldown do not</span>
          </div>
        </div>
      )}
      {reviewing && role.notesTaintedAt && (
        <NotesReview key={role.notesTaintedAt} office={office} role={role} now={now} onDone={() => setReviewing(false)} />
      )}
      {err && <div className="warn-text office-pad">{err}</div>}
    </div>
  );
}

/**
 * Mark notes reviewed (docs/office.md § The /office page): shows the exact
 * file the next shift would read (the untrusted twin, else roles/<key>.md)
 * and vouches for THAT version — the POST carries the `notesTaintedAt` and
 * sha256 shown here, and a shift that rewrote the notes since makes it a 409.
 * Remounted (keyed) on every new `notesTaintedAt`, so a rewrite re-reads.
 */
function NotesReview({ office, role, now, onDone }: { office: Office; role: OfficeRole; now: number; onDone: () => void }) {
  const arm = useArm();
  const [review, setReview] = useState<OfficeNotesReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setReview(null);
    api.officeNotesReview(office.id, role.id).then(setReview, (e) => setErr(errText(e)));
  }, [office.id, role.id]);
  useEffect(load, [load]);
  const mark = async () => {
    if (!review?.notesTaintedAt) return;
    setBusy(true);
    setErr(null);
    try {
      await api.markOfficeNotesReviewed(office.id, role.id, { notesTaintedAt: review.notesTaintedAt, sha256: review.sha256 });
      onDone();
    } catch (e) {
      setErr(errText(e));
      load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="office-wake office-notes-review">
      {!review && !err && <div className="muted">Loading the notes…</div>}
      {review && (
        <>
          <div className="muted office-hint">
            {review.path}
            {review.modifiedAt && <> · written {formatOfficeTime(Date.parse(review.modifiedAt), now, office.timezone)}</>}
            {review.promotes ? ` · on review it is copied over ${role.notesPath}` : ' · no untrusted copy: only the flag clears'}
          </div>
          <pre className="office-notes-text">{review.text ?? '(no notes file)'}</pre>
          <div className="office-actions">
            <button
              className={`btn${arm.armed === 'reviewed' ? ' danger' : ''}`}
              disabled={busy || !review.notesTaintedAt}
              onClick={() => arm.press('reviewed') && void mark()}
            >
              {arm.armed === 'reviewed' ? 'Read and safe? tap again' : 'Mark these notes reviewed'}
            </button>
            <button className="btn ghost" onClick={onDone}>
              Cancel
            </button>
            <span className="muted office-hint">the next shift reads exactly this text as trusted</span>
          </div>
        </>
      )}
      {err && <div className="warn-text">{err}</div>}
    </div>
  );
}

function AddRole({ office }: { office: Office }) {
  const [preset, setPreset] = useState<OfficeRolePreset>('qa');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keyBad = key.trim() !== '' && !OFFICE_ROLE_KEY_RE.test(key.trim());
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.createOfficeRole(office.id, { preset, ...(key.trim() ? { key: key.trim() } : {}) });
      setKey('');
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="office-add-role">
      <select className="field" value={preset} onChange={(e) => setPreset(e.target.value as OfficeRolePreset)} aria-label="Preset">
        {OFFICE_ROLE_PRESETS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <input className="field" value={key} placeholder="key (e.g. qa-mobile)" onChange={(e) => setKey(e.target.value)} aria-label="Role key" />
      <button className="btn" disabled={busy || keyBad} onClick={() => void add()}>
        Add role
      </button>
      {keyBad && <span className="warn-text">a kebab slug: a-z, 0-9 and dashes</span>}
      {err && <span className="warn-text">{err}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role editor
// ---------------------------------------------------------------------------

/** A guard of a kind with its default parameters. */
function blankGuard(kind: OfficeGuardKind): OfficeGuard {
  switch (kind) {
    case 'open-bugs-below':
      return { kind, n: 5 };
    case 'budget-left':
      return { kind, minUsd: 1 };
    case 'quiet-hours':
      return { kind, from: '22:00', to: '07:00' };
    case 'cooldown':
      return { kind, minutes: 60 };
    case 'briefs-since':
      return { kind, orTasksLanded: true };
    default:
      return { kind } as OfficeGuard;
  }
}

/** The saved commands a role may allowlist — the server's `allowlistCheck`, read off the client's list. */
function allowlistable(c: RepoCommand, repoIds: readonly string[]): boolean {
  return !c.isCheck && !c.archivedAt && c.ownerTaskId === null && c.kind !== 'service' && repoIds.includes(c.repoId);
}

function RoleEditor({
  office,
  role,
  inSheet,
  onClose,
  onSaved,
}: {
  office: Office;
  role: OfficeRole;
  /** the Sheet's own title already names the role */
  inSheet: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { commands, repos, workspaces } = useApp();
  const now = useNow();
  const arm = useArm();
  const ws = workspaces.find((w) => w.id === office.workspaceId);
  const repoIds = ws?.repoIds ?? [];
  const [name, setName] = useState(role.name);
  const [avatar, setAvatar] = useState(role.avatar);
  const [title, setTitle] = useState(role.title);
  const [prompt, setPrompt] = useState(role.prompt);
  const [model, setModel] = useState(role.model);
  const [effort, setEffort] = useState<EffortLevel | ''>(role.effort ?? '');
  const [tools, setTools] = useState<string[]>(role.tools);
  const [autonomy, setAutonomy] = useState<OfficeAutonomy | ''>(role.autonomy ?? '');
  const [cap, setCap] = useState(role.capUsd === null ? '' : String(role.capUsd));
  const [enabled, setEnabled] = useState(role.enabled);
  const [schedules, setSchedules] = useState<string[]>(role.schedules);
  const [triggers, setTriggers] = useState<OfficeTrigger[]>(role.triggers);
  const [guards, setGuards] = useState<OfficeGuard[]>(role.guards);
  const [allow, setAllow] = useState<OfficeRoleCommand[]>(role.commands);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const allowDirty = JSON.stringify(allow) !== JSON.stringify(role.commands);
  const capNum = cap.trim() === '' ? null : Number(cap);
  const problems = [
    ...schedules.map((s, i) => (s.trim() ? cronError(s.trim()) : `schedule ${i + 1} is empty`)).filter((x): x is string => !!x),
    ...guards.map(guardError).filter((x): x is string => !!x),
    ...triggers.filter((t) => t.kind === 'signal' && !t.source.trim()).map(() => 'a signal trigger needs a source'),
    ...(capNum !== null && !(Number.isFinite(capNum) && capNum >= 0) ? ['the cap is not a number ≥ 0'] : []),
    ...(!name.trim() || !title.trim() || !prompt.trim() || !avatar.trim() ? ['name, avatar, title and prompt are required'] : []),
  ];

  const save = async () => {
    setBusy(true);
    setErr(null);
    setWarning(null);
    try {
      const res = await api.updateOfficeRole(office.id, role.id, {
        name: name.trim(),
        avatar: avatar.trim(),
        title: title.trim(),
        prompt,
        model,
        effort: effort || null,
        tools,
        autonomy: autonomy || null,
        capUsd: capNum,
        enabled,
        schedules: schedules.map((s) => s.trim()),
        triggers,
        guards,
      });
      if (allowDirty) await api.setOfficeRoleCommands(office.id, role.id, allow);
      setWarning(res.warning ?? null);
      onSaved();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    try {
      await api.deleteOfficeRole(office.id, role.id);
      onClose();
    } catch (e) {
      toastError(e, 'Delete role');
    } finally {
      setBusy(false);
    }
  };

  const eligible = commands.filter((c) => allowlistable(c, repoIds));
  const stale = allow.filter((a) => !eligible.some((c) => c.id === a.commandId));
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? short(id);
  const models = MODEL_OPTIONS.includes(model) ? MODEL_OPTIONS : [model, ...MODEL_OPTIONS];

  return (
    <div className="office-editor">
      {!inSheet && (
        <div className="office-editor-head">
          <span className="office-avatar" aria-hidden>
            {avatar}
          </span>
          <div className="office-editor-title">
            {role.name} <span className="muted mono">{role.key}</span>
          </div>
        </div>
      )}

      <div className="form-grid">
        <div>
          <label className="label">Name</label>
          <input className="field" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Avatar (emoji)</label>
          <input className="field" value={avatar} maxLength={16} onChange={(e) => setAvatar(e.target.value)} />
        </div>
        <div>
          <label className="label">Title</label>
          <input className="field" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="label">Role on</label>
          <label className="office-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> wakes on its schedule and triggers
          </label>
        </div>
      </div>

      <label className="label office-gap">Prompt (the role's standing instructions)</label>
      <textarea className="field office-prompt" rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      <div className="form-grid office-gap">
        <div>
          <label className="label">Model</label>
          <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Effort</label>
          <select className="field" value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')}>
            <option value="">default</option>
            {EFFORT_LEVELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Autonomy</label>
          <select className="field" value={autonomy} onChange={(e) => setAutonomy(e.target.value as OfficeAutonomy | '')}>
            <option value="">office's ({office.autonomy})</option>
            {OFFICE_AUTONOMY_LEVELS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <div className="muted office-hint">never above the office's</div>
        </div>
        <div>
          <label className="label">Daily cap (USD, empty = only the office budget)</label>
          <input className="field" type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} />
        </div>
      </div>

      <EditorSection title="Tools" hint={`${SHIFT_FORBIDDEN_TOOLS.join(', ')} are never offered: a shift never executes or edits.`}>
        <div className="office-tools">
          {SHIFT_TOOL_ALLOWLIST.map((t) => {
            const web = SHIFT_WEB_TOOLS.includes(t);
            return (
              <label key={t} className={`office-check office-tool${web ? ' web' : ''}`}>
                <input
                  type="checkbox"
                  checked={tools.includes(t)}
                  onChange={(e) => setTools((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))}
                />
                <span className="mono">{t}</span>
                {web && <span className="chip office-taint">taints the shift</span>}
              </label>
            );
          })}
        </div>
      </EditorSection>

      <EditorSection title="Schedules" hint={`5-field cron, read in ${office.timezone}`}>
        {schedules.map((s, i) => {
          const e = s.trim() ? cronError(s.trim()) : 'empty';
          const next = !e ? nextCronSlot(s.trim(), now, office.timezone) : null;
          return (
            <div key={i} className="office-list-edit">
              <input
                className="field mono"
                value={s}
                placeholder="0 9 * * 1-5"
                onChange={(ev) => setSchedules((cur) => cur.map((x, j) => (j === i ? ev.target.value : x)))}
              />
              <span className={e ? 'warn-text' : 'muted'}>{e ?? (next !== null ? `next ${formatOfficeTime(next, now, office.timezone)}` : 'never fires')}</span>
              <button className="btn ghost" onClick={() => setSchedules((cur) => cur.filter((_, j) => j !== i))} aria-label="Remove schedule">
                Remove
              </button>
            </div>
          );
        })}
        <button className="btn" disabled={schedules.length >= 10} onClick={() => setSchedules((cur) => [...cur, '0 9 * * 1-5'])}>
          Add schedule
        </button>
      </EditorSection>

      <EditorSection title="Triggers" hint="wakes besides the schedule; a signal (new Sentry or GitHub issues) is outside text: its shift is tainted, files drafts only, and gets no web tools or command runs — except signal: metric (this role's product metric crossed its threshold), which the server writes, so that wake is untainted">
        {triggers.map((t, i) => (
          <TriggerRow
            key={i}
            trigger={t}
            repoIds={repoIds}
            repoName={repoName}
            onChange={(n) => setTriggers((cur) => cur.map((x, j) => (j === i ? n : x)))}
            onRemove={() => setTriggers((cur) => cur.filter((_, j) => j !== i))}
          />
        ))}
        <button
          className="btn"
          disabled={triggers.length >= 10}
          onClick={() => setTriggers((cur) => [...cur, { kind: 'event', event: 'task-landed' }])}
        >
          Add trigger
        </button>
      </EditorSection>

      <EditorSection title="Guards" hint="a failing guard skips a due shift with its reason (Wake now ignores them)">
        {guards.map((g, i) => (
          <GuardRow
            key={i}
            guard={g}
            onChange={(n) => setGuards((cur) => cur.map((x, j) => (j === i ? n : x)))}
            onRemove={() => setGuards((cur) => cur.filter((_, j) => j !== i))}
          />
        ))}
        <button className="btn" disabled={guards.length >= 10} onClick={() => setGuards((cur) => [...cur, blankGuard('cooldown')])}>
          Add guard
        </button>
      </EditorSection>

      <EditorSection
        title="Saved commands this role may run"
        hint={`a shift may ask for these, and only these; the server runs them after the shift (≤ ${OFFICE_ROLE_COMMANDS_MAX}). External = reads the outside world: its output taints the next shift.`}
      >
        {eligible.length === 0 && stale.length === 0 && (
          <div className="muted">No eligible saved commands in this workspace's repos (one-shot, saved by a human, not a check).</div>
        )}
        {eligible.map((c) => {
          const entry = allow.find((a) => a.commandId === c.id);
          return (
            <div key={c.id} className="office-cmd">
              <label className="office-check">
                <input
                  type="checkbox"
                  checked={!!entry}
                  disabled={!entry && allow.length >= OFFICE_ROLE_COMMANDS_MAX}
                  onChange={(e) =>
                    setAllow((cur) => (e.target.checked ? [...cur, { commandId: c.id, external: false }] : cur.filter((a) => a.commandId !== c.id)))
                  }
                />
                <span className="office-cmd-name">{c.name}</span>
                <span className="muted">{repoName(c.repoId)}</span>
              </label>
              <span className="mono muted office-cmd-line">{c.command}</span>
              <label className={`office-check${entry ? '' : ' disabled'}`}>
                <input
                  type="checkbox"
                  disabled={!entry}
                  checked={!!entry?.external}
                  onChange={(e) => setAllow((cur) => cur.map((a) => (a.commandId === c.id ? { ...a, external: e.target.checked } : a)))}
                />
                external
              </label>
            </div>
          );
        })}
        {stale.map((a) => (
          <div key={a.commandId} className="office-cmd">
            <span className="warn-text">{commands.find((c) => c.id === a.commandId)?.name ?? short(a.commandId)} — no longer eligible</span>
            <button className="btn ghost" onClick={() => setAllow((cur) => cur.filter((x) => x.commandId !== a.commandId))}>
              Remove
            </button>
          </div>
        ))}
      </EditorSection>

      <EditorSection
        title="Product metrics"
        hint="a saved command the server runs on a cron with zero tokens; it prints TM_METRIC=<number>. Crossing the threshold files ONE metric signal (untainted) that wakes this role if it has a signal: metric trigger. Saved on their own, not by Save role."
      >
        <RoleMetrics office={office} role={role} />
      </EditorSection>

      {problems.length > 0 && <div className="warn-text office-gap">{problems[0]}</div>}
      {warning && <div className="office-banner over office-gap">{warning}</div>}
      {err && <div className="warn-text office-gap">{err}</div>}
      <div className="office-actions office-gap">
        <button className="btn primary" disabled={busy || problems.length > 0} onClick={() => void save()}>
          Save role
        </button>
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn danger" disabled={busy} onClick={() => arm.press('delete') && void del()}>
          {arm.armed === 'delete' ? 'Delete role? tap again' : 'Delete role'}
        </button>
      </div>
    </div>
  );
}

function EditorSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="office-editor-section">
      <div className="office-editor-section-title">{title}</div>
      {hint && <div className="muted office-hint">{hint}</div>}
      <div className="office-editor-section-body">{children}</div>
    </div>
  );
}

/** What the role editor's signal source picker says per source (docs/office.md § Signals, § Product metrics). */
const OFFICE_SIGNAL_SOURCE_LABELS: Record<OfficeSignalSource, string> = {
  sentry: 'Sentry — new unresolved issues',
  github: 'GitHub — new open issues in the workspace repos',
  metric: "Metric — this role's product metric crossed its threshold (untainted)",
};

function TriggerRow({
  trigger,
  repoIds,
  repoName,
  onChange,
  onRemove,
}: {
  trigger: OfficeTrigger;
  repoIds: readonly string[];
  repoName: (id: string) => string;
  onChange: (t: OfficeTrigger) => void;
  onRemove: () => void;
}) {
  return (
    <div className="office-list-edit">
      <select
        className="field"
        value={trigger.kind}
        aria-label="Trigger kind"
        onChange={(e) => {
          const k = e.target.value as OfficeTrigger['kind'];
          onChange(k === 'event' ? { kind: 'event', event: 'task-landed' } : k === 'signal' ? { kind: 'signal', source: 'sentry' } : { kind: 'command-done' });
        }}
      >
        <option value="event">event</option>
        <option value="signal">signal (outside — taints)</option>
        <option value="command-done">its command runs finished</option>
      </select>
      {trigger.kind === 'event' && (
        <>
          <select
            className="field"
            value={trigger.event}
            aria-label="Event"
            onChange={(e) => onChange({ ...trigger, event: e.target.value as OfficeEventName })}
          >
            {OFFICE_EVENT_NAMES.map((n) => (
              <option key={n} value={n} title={OFFICE_EVENT_LABELS[n]}>
                {n} — {OFFICE_EVENT_LABELS[n]}
              </option>
            ))}
          </select>
          <select
            className="field"
            value={trigger.repoId ?? ''}
            aria-label="Repo"
            onChange={(e) => onChange({ ...trigger, repoId: e.target.value || null })}
          >
            <option value="">any repo</option>
            {repoIds.map((id) => (
              <option key={id} value={id}>
                {repoName(id)}
              </option>
            ))}
          </select>
        </>
      )}
      {trigger.kind === 'signal' && (
        <select
          className="field"
          value={trigger.source}
          aria-label="Signal source"
          title="Sentry / GitHub issues are polled every 10 min; their text is fenced as untrusted data, the shift is tainted, files drafts and runs nothing. A metric signal is the server's own (an untainted wake)."
          onChange={(e) => onChange({ kind: 'signal', source: e.target.value })}
        >
          {!OFFICE_SIGNAL_SOURCES.includes(trigger.source as OfficeSignalSource) && (
            <option value={trigger.source}>{trigger.source || 'pick a source'}</option>
          )}
          {OFFICE_SIGNAL_SOURCES.map((src) => (
            <option key={src} value={src}>
              {OFFICE_SIGNAL_SOURCE_LABELS[src]}
            </option>
          ))}
        </select>
      )}
      <button className="btn ghost" onClick={onRemove} aria-label="Remove trigger">
        Remove
      </button>
    </div>
  );
}

function GuardRow({ guard, onChange, onRemove }: { guard: OfficeGuard; onChange: (g: OfficeGuard) => void; onRemove: () => void }) {
  const e = guardError(guard);
  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  return (
    <div className="office-list-edit">
      <select className="field" value={guard.kind} aria-label="Guard" onChange={(ev) => onChange(blankGuard(ev.target.value as OfficeGuardKind))}>
        {OFFICE_GUARD_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      {guard.kind === 'open-bugs-below' && (
        <input className="field office-num" type="number" min={1} value={Number.isFinite(guard.n) ? guard.n : ''} aria-label="Bugs" onChange={(ev) => onChange({ ...guard, n: num(ev.target.value) })} />
      )}
      {guard.kind === 'budget-left' && (
        <input
          className="field office-num"
          type="number"
          min={0}
          value={guard.minUsd ?? ''}
          aria-label="Minimum USD left"
          onChange={(ev) => onChange(ev.target.value.trim() === '' ? { kind: 'budget-left' } : { ...guard, minUsd: num(ev.target.value) })}
        />
      )}
      {guard.kind === 'quiet-hours' && (
        <>
          <input className="field office-num" type="time" value={guard.from} aria-label="From" onChange={(ev) => onChange({ ...guard, from: ev.target.value })} />
          <input className="field office-num" type="time" value={guard.to} aria-label="To" onChange={(ev) => onChange({ ...guard, to: ev.target.value })} />
        </>
      )}
      {guard.kind === 'briefs-since' && (
        <label className="muted">
          <input type="checkbox" checked={!!guard.orTasksLanded} onChange={(ev) => onChange(ev.target.checked ? { kind: 'briefs-since', orTasksLanded: true } : { kind: 'briefs-since' })} /> or a landed task
        </label>
      )}
      {guard.kind === 'cooldown' && (
        <input
          className="field office-num"
          type="number"
          min={1}
          value={Number.isFinite(guard.minutes) ? guard.minutes : ''}
          aria-label="Minutes"
          onChange={(ev) => onChange({ ...guard, minutes: num(ev.target.value) })}
        />
      )}
      <span className={e ? 'warn-text' : 'muted'}>{e ?? describeGuard(guard)}</span>
      <button className="btn ghost" onClick={onRemove} aria-label="Remove guard">
        Remove
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shift log
// ---------------------------------------------------------------------------

/**
 * Ask the Director for a feature (docs/office.md § Director features → Ask the
 * Director): one `request` wake of the Director whose note is this text,
 * trusted; the shift files it as its `feature` section, which the shift log
 * then links. The hard gate applies (409 says why), guards do not.
 */
function AskDirector({ office, director, onAsked }: { office: Office; director: OfficeRole | null; onAsked: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!director) return <div className="muted office-pad">This office has no Director role — add one from the presets to ask for features.</div>;
  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.askOfficeFeature(office.id, text.trim());
      setText('');
      setMsg({ ok: true, text: `${director.name} is on it — the feature appears linked in the shift log once the shift files it, and its plan comes to your Inbox for approval.` });
      onAsked();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="office-wake office-ask">
      <textarea
        className="field"
        rows={4}
        maxLength={OFFICE_WAKE_NOTE_MAX}
        placeholder={`What should ${director.name} plan? The goal, why, what done looks like — a feature spanning the workspace's repos.`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="office-actions">
        <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? 'Asking…' : `Ask ${director.avatar} ${director.name}`}
        </button>
        <span className="muted office-hint">wakes the Director now (the hard gate applies); you approve the plan before any task exists</span>
      </div>
      {msg && <div className={msg.ok ? 'muted office-pad' : 'warn-text office-pad'}>{msg.text}</div>}
    </div>
  );
}

function ShiftLog({
  office,
  roles,
  shifts,
  shiftFeatures,
  inSheet,
  onOpenTask,
  onOpenTerminal,
}: {
  office: Office;
  roles: OfficeRole[];
  shifts: OfficeShift[];
  /** shift id → the feature it filed */
  shiftFeatures: Record<string, string>;
  /** the Sheet's own title already says "Shift log" */
  inSheet: boolean;
} & Props) {
  const now = useNow();
  return (
    <div className="panel office-log">
      {!inSheet && (
        <div className="office-section-title">
          Shift log <span className="muted">{shifts.length ? `latest ${shifts.length}` : ''}</span>
        </div>
      )}
      {shifts.length === 0 && <div className="muted office-pad">No shifts yet.</div>}
      {shifts.map((s) => (
        <ShiftRow
          key={s.id}
          office={office}
          shift={s}
          role={roles.find((r) => r.id === s.roleId) ?? null}
          featureId={shiftFeatures[s.id] ?? null}
          now={now}
          onOpenTask={onOpenTask}
          onOpenTerminal={onOpenTerminal}
        />
      ))}
    </div>
  );
}

function ShiftRow({
  office,
  shift: s,
  role,
  featureId,
  now,
  onOpenTask,
  onOpenTerminal,
}: { office: Office; shift: OfficeShift; role: OfficeRole | null; featureId: string | null; now: number } & Props) {
  const { tasks, features } = useApp();
  const navigate = useNavigate();
  const feature = featureId ? features.find((x) => x.id === featureId) : undefined;
  const openBrief = useContext(BriefOpen);
  const live = s.verdict === 'ran' && s.endedAt === null;
  const verdict = s.verdict === 'skipped' ? 'skipped' : live ? 'on shift' : s.error ? 'error' : 'ran';
  const trigger = isFeatureAskTrigger(s.trigger)
    ? `${TRIGGER_KIND_LABEL[s.trigger.kind]} · feature ask`
    : `${TRIGGER_KIND_LABEL[s.trigger.kind]}${s.trigger.ref ? ` ${s.trigger.ref}` : ''}`;
  const taskTitle = (id: string) => tasks.find((t) => t.id === id)?.title ?? short(id);
  const f = s.filing;
  const c = s.commands;
  return (
    <div className={`office-shift v-${verdict.replace(' ', '-')}`}>
      <div className="office-shift-head">
        <span className="office-shift-when">{formatOfficeTime(Date.parse(s.startedAt), now, office.timezone)}</span>
        <span className="office-shift-role">
          {role ? `${role.avatar} ${role.name}` : <span className="muted">deleted role</span>}
        </span>
        <span className="muted office-shift-trigger">{trigger}</span>
        <span className={`chip office-verdict v-${verdict.replace(' ', '-')}`}>{verdict}</span>
        {s.verdict === 'ran' && <span className="chip task-cost">{usd(s.costUsd)}</span>}
        {s.tainted && <span className="chip office-taint">tainted</span>}
        <span style={{ flex: 1 }} />
        {s.briefId && (
          <button className="btn ghost office-term" onClick={() => openBrief(s.briefId)}>
            Brief
          </button>
        )}
        {s.runId && (
          <button className="btn ghost office-term" onClick={() => onOpenTerminal(s.runId!)}>
            Terminal
          </button>
        )}
      </div>
      {s.verdict === 'skipped' && s.skipReason && (
        <div className="office-shift-line">
          skip: {s.skipReason}
          {s.skipCode ? <span className="muted"> ({s.skipCode})</span> : null}
        </div>
      )}
      {s.error && <div className="office-shift-line warn-text">{s.error}</div>}
      {s.tainted && s.taintSources.length > 0 && (
        <div className="office-shift-line">
          <span className="muted">taint from </span>
          {s.taintSources.map(taintText).join(' · ')}
        </div>
      )}
      {featureId && (
        <div className="office-shift-line">
          <span className="muted">filed feature: </span>
          <button className="office-link" onClick={() => navigate(`/features/${featureId}`)}>
            {feature?.title ?? short(featureId)}
          </button>
          {feature && <span className="muted"> · {feature.status}</span>}
          {feature?.taintedAt && (
            <>
              {' '}
              <span className="chip office-taint">tainted</span>
            </>
          )}
        </div>
      )}
      {s.filedTaskIds.length > 0 && (
        <div className="office-shift-line">
          <span className="muted">filed{f ? ` as ${f.status}` : ''}: </span>
          {s.filedTaskIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ' · '}
              <button className="office-link" onClick={() => onOpenTask(id)}>
                {taskTitle(id)}
              </button>
            </span>
          ))}
        </div>
      )}
      {f && (f.note || f.held.length > 0 || f.dropped.length > 0) && (
        <div className="office-shift-line muted">
          {[f.note, f.held.length ? `${f.held.length} held as proposals` : null, f.dropped.length ? `${f.dropped.length} dropped (${f.dropped.map((d) => d.reason).join('; ')})` : null]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {c && (c.runs.length > 0 || c.dropped.length > 0) && (
        <div className="office-shift-cmds">
          {c.runs.map((r, i) => (
            <details key={`${r.commandId}-${i}`} className="office-shift-cmd">
              <summary>
                <span className="mono">{r.name || short(r.commandId)}</span>{' '}
                <span className={`chip office-cmd-status st-${r.status}${r.status === 'done' && r.exitCode !== 0 ? ' red' : ''}`}>
                  {r.status === 'done' ? `exit ${r.exitCode}` : r.status}
                </span>
                {r.external && <span className="chip office-taint">external</span>}
                {r.reason && <span className="muted"> {r.reason}</span>}
              </summary>
              {r.tail ? <pre className="office-cmd-tail">{r.tail}</pre> : <div className="muted">no output</div>}
              {r.reportPath && <div className="muted mono">{r.reportPath}</div>}
            </details>
          ))}
          {c.dropped.map((d, i) => (
            <div key={`d-${i}`} className="office-shift-line muted">
              not run: {short(d.commandId)} — {d.reason}
            </div>
          ))}
          {c.wake && (
            <div className="office-shift-line muted">
              {c.wake.shiftId ? 'woke the role again after the runs' : `no wake after the runs: ${c.wake.skipReason ?? 'skipped'}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Briefings (docs/office.md § Briefings)
// ---------------------------------------------------------------------------

/** Opens a brief in the viewer (the shift log's Brief button). */
const BriefOpen = createContext<(id: string | null) => void>(() => {});

/** `?brief=<id>` — the open brief, kept in the URL so the push deep link and a reload land on it. */
function useBriefParam(): [string | null, (id: string | null) => void] {
  const { search } = useLocation();
  const navigate = useNavigate();
  const id = new URLSearchParams(search).get('brief') || null;
  const set = useCallback(
    (next: string | null) => {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set('brief', next);
      else url.searchParams.delete('brief');
      navigate({ pathname: url.pathname, search: url.search, hash: url.hash }, { replace: true });
    },
    [navigate],
  );
  return [id, set];
}

/** The office's newest briefs, following `office.brief` (created → prepended, reviewed → replaced). */
function useOfficeBriefs(officeId: string): OfficeBrief[] | null {
  const [briefs, setBriefs] = useState<OfficeBrief[] | null>(null);
  useEffect(() => {
    let live = true;
    setBriefs(null);
    api.listOfficeBriefs(officeId).then(
      (l) => live && setBriefs(l),
      () => live && setBriefs([]),
    );
    const off = onServerEvent((e) => {
      if (e.type !== 'office.brief' || e.brief.officeId !== officeId) return;
      setBriefs((cur) => {
        const list = cur ?? [];
        return list.some((b) => b.id === e.brief.id) ? list.map((b) => (b.id === e.brief.id ? e.brief : b)) : [e.brief, ...list];
      });
    });
    return () => {
      live = false;
      off();
    };
  }, [officeId]);
  return briefs;
}

function BriefList({
  office,
  roles,
  briefs,
  ratings,
  selected,
  inSheet,
  onSelect,
}: {
  office: Office;
  roles: OfficeRole[];
  briefs: OfficeBrief[] | null;
  ratings: Map<string, OfficeRating>;
  selected: string | null;
  inSheet: boolean;
  onSelect: (id: string) => void;
}) {
  const now = useNow();
  return (
    <div className="office-brief-list">
      {!inSheet && (
        <div className="office-section-title">
          Briefs <span className="muted">{briefs?.length ? `latest ${briefs.length}` : ''}</span>
        </div>
      )}
      {briefs === null && <div className="muted office-pad">Loading…</div>}
      {briefs?.length === 0 && <div className="muted office-pad">No briefs yet — every shift leaves one.</div>}
      {briefs?.map((b) => {
        const role = roles.find((r) => r.id === b.roleId);
        return (
          <button key={b.id} className={`office-brief-row${selected === b.id ? ' on' : ''}`} onClick={() => onSelect(b.id)}>
            <span className="office-shift-when">{formatOfficeTime(Date.parse(b.createdAt), now, office.timezone)}</span>
            <span className="office-shift-role">{role ? `${role.avatar} ${role.name}` : 'deleted role'}</span>
            {b.kind === 'standup' && <span className="chip office-brief-kind">stand-up</span>}
            {b.taintedAt && <span className="chip office-taint">untrusted</span>}
            {ratings.get(ratingKey('brief', b.id)) && (
              <span className="chip" title="your rating">
                {ratings.get(ratingKey('brief', b.id))!.value === 1 ? '👍' : '👎'}
              </span>
            )}
            <span className="office-brief-summary">{b.summary}</span>
          </button>
        );
      })}
    </div>
  );
}

function BriefViewer({
  office,
  briefId,
  ratings,
  inSheet,
  onClose,
}: {
  office: Office;
  briefId: string;
  ratings: Map<string, OfficeRating>;
  inSheet: boolean;
  onClose: () => void;
}) {
  const now = useNow();
  const arm = useArm();
  const [view, setView] = useState<OfficeBriefView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.getOfficeBrief(briefId).then(
      (v) => (setView(v), setErr(null)),
      (e) => setErr(errText(e)),
    );
  }, [briefId]);
  useEffect(() => {
    load();
    return onServerEvent((e) => {
      if (e.type === 'office.brief' && e.brief.id === briefId) load();
    });
  }, [briefId, load]);
  const mark = async () => {
    if (!view?.brief.taintedAt || !view.sha256) return;
    setBusy(true);
    setErr(null);
    try {
      await api.markOfficeBriefReviewed(briefId, { taintedAt: view.brief.taintedAt, sha256: view.sha256 });
      load();
    } catch (e) {
      setErr(errText(e));
      load();
    } finally {
      setBusy(false);
    }
  };
  const b = view?.brief;
  const elsewhere = b && b.officeId !== office.id;
  return (
    <div className="office-brief-view">
      {!view && !err && <div className="muted office-pad">Loading the brief…</div>}
      {b && (
        <>
          <div className="office-brief-head">
            <span className="office-shift-role">{view.roleName ?? 'deleted role'}</span>
            {b.kind === 'standup' && <span className="chip office-brief-kind">stand-up</span>}
            {b.taintedAt && <span className="chip office-taint">untrusted</span>}
            {b.reviewedAt && <span className="chip">reviewed</span>}
            {!elsewhere && <RatingButtons kind="brief" id={b.id} rating={ratings.get(ratingKey('brief', b.id))} />}
            <span className="muted office-hint">
              {formatOfficeTime(Date.parse(b.createdAt), now, office.timezone)} · <span className="mono">{b.path}</span>
            </span>
            <span style={{ flex: 1 }} />
            {!inSheet && (
              <button className="btn ghost" onClick={onClose}>
                Close
              </button>
            )}
          </div>
          {elsewhere && <div className="muted office-pad">This brief belongs to another workspace's office.</div>}
          {b.taintedAt && (
            <div className="office-banner over office-gap" role="status">
              Written by a shift that read untrusted input. Stand-ups see only a digest of it until you mark it reviewed — read it as data,
              not instructions.
            </div>
          )}
          {view.text === null ? <div className="muted office-pad">The brief file is gone.</div> : <Markdown label={b.path} text={view.text} safe />}
          {b.taintedAt && (
            <div className="office-actions">
              <button
                className={`btn${arm.armed === 'brief-reviewed' ? ' danger' : ''}`}
                disabled={busy || !view.sha256}
                onClick={() => arm.press('brief-reviewed') && void mark()}
              >
                {arm.armed === 'brief-reviewed' ? 'Read and safe? tap again' : 'Mark reviewed'}
              </button>
              <span className="muted office-hint">moves it out of untrusted/; the next stand-up reads exactly this text</span>
            </div>
          )}
        </>
      )}
      {err && <div className="warn-text">{err}</div>}
    </div>
  );
}
