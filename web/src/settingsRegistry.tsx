// The settings descriptor registry (docs/settings-versions.md § Registry): one
// entry per control on the Config page, so every settings version can search,
// group and fold the SAME controls without its own copy of them. The frozen
// `original` (pages/Config.tsx) keeps its own JSX; everything else renders
// from here. Labels and help are the original page's, as plain text — search
// reads them.

import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  CONCURRENCY_MAX,
  EFFORT_LEVELS,
  JOB_CONCURRENCY_MAX,
  JOB_MAX_ACTIVE_TASKS_MAX,
  MODEL_OPTIONS,
  taskPresets,
  type AppSettings,
  type OrchestratorStatus,
  type Repo,
} from '@tm/shared';
import { AppearanceSettings } from './components/AppearanceSettings.tsx';
import { PresetEditor } from './components/PresetEditor.tsx';
import { PushSettings } from './components/PushSettings.tsx';
import { TemplateEditor } from './components/TemplateEditor.tsx';
import type { Look } from './appearance.ts';
import { valueOf, type SettingKey, type SettingsForm } from './settingsForm.ts';

export type SectionId =
  | 'appearance'
  | 'notifications'
  | 'orchestrator'
  | 'agent'
  | 'sessions'
  | 'review'
  | 'routing'
  | 'chat'
  | 'jobs'
  | 'budget'
  | 'board'
  | 'presets'
  | 'templates'
  | 'terminal'
  | 'storage'
  | 'sentry'
  | 'repos';

/** The tabs of the "Tabs by intent" version. */
export type Intent = 'agents' | 'alerts' | 'look' | 'content' | 'integrations';

export const INTENTS: readonly { id: Intent; label: string }[] = [
  { id: 'agents', label: 'Running agents' },
  { id: 'alerts', label: 'Notifications & alerts' },
  { id: 'look', label: 'Look & feel' },
  { id: 'content', label: 'Content' },
  { id: 'integrations', label: 'Integrations' },
];

/** What a control renders from: the shared form plus the app state a few controls read. */
export interface SettingCtx {
  form: SettingsForm;
  cfg: AppSettings;
  repos: Repo[];
  orch: OrchestratorStatus;
  look: Look;
  wsHref: (to: string) => string;
}

export interface SettingsSection {
  id: SectionId;
  title: string;
  intent: Intent;
  /** one line under the heading */
  intro?: string;
  /** a per-device block reused as its own component (applied as clicked, never part of Save) */
  device?: ComponentType;
  /** what search matches for a device block, which has no descriptors */
  keywords?: string;
  /** the section's current value as one line (the Cards version) */
  summary: (ctx: SettingCtx) => string;
}

export interface SettingDescriptor {
  /** an AppSettings key, or `x:` for a row that is not one (a read-out, a link, the Sentry token) */
  key: SettingKey | `x:${string}`;
  section: SectionId;
  label: string;
  help: string;
  /** hidden by the Basic / Advanced version until "Show advanced" */
  advanced?: boolean;
  /** overrides the section's intent (budget alerts sit with notifications) */
  intent?: Intent;
  /** the control goes under the label at every width (editors, lists) */
  wide?: boolean;
  /** extra help that depends on the value (a warning, the token status) */
  note?: (ctx: SettingCtx) => ReactNode;
  render: (ctx: SettingCtx) => ReactNode;
}

export const isSettingKey = (k: SettingDescriptor['key']): k is SettingKey => !k.startsWith('x:');

// ---------- control helpers ----------

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div
      className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!on);
        }
      }}
      role="switch"
      tabIndex={0}
      aria-checked={on}
      aria-label={label}
    >
      <span className="track">
        <span className="knob" />
      </span>
    </div>
  );
}

type BoolKey = { [K in SettingKey]: AppSettings[K] extends boolean ? K : never }[SettingKey];
type NumKey = { [K in SettingKey]: AppSettings[K] extends number ? K : never }[SettingKey];
type StrKey = { [K in SettingKey]: AppSettings[K] extends string ? K : never }[SettingKey];

const toggle =
  (k: BoolKey, label: string) =>
  ({ cfg, form }: SettingCtx) => <Toggle label={label} on={valueOf(cfg, k)} onChange={(v) => form.set(k, v)} />;

const num =
  (k: NumKey, o: { min?: number; max?: number; step?: number; width?: number; mono?: boolean; label: string }) =>
  ({ cfg, form }: SettingCtx) => (
    <input
      className={`field${o.mono ? ' mono' : ''}`}
      style={{ width: o.width ?? 90 }}
      type="number"
      aria-label={o.label}
      min={o.min}
      max={o.max}
      step={o.step}
      value={valueOf(cfg, k)}
      onChange={(e) => form.set(k, Number(e.target.value))}
    />
  );

const text =
  (k: StrKey, o: { width: number; placeholder?: string; label: string }) =>
  ({ cfg, form }: SettingCtx) => (
    <input
      className="field mono"
      style={{ width: o.width }}
      aria-label={o.label}
      placeholder={o.placeholder}
      value={valueOf(cfg, k)}
      onChange={(e) => form.set(k, e.target.value)}
    />
  );

/** A model picker over `MODEL_OPTIONS`, keeping a stored id the list no longer offers. */
const model =
  (k: StrKey, label: string) =>
  ({ cfg, form }: SettingCtx) => {
    const v = valueOf(cfg, k);
    const choices = MODEL_OPTIONS.includes(v) ? MODEL_OPTIONS : [v, ...MODEL_OPTIONS];
    return (
      <select className="field mono" style={{ width: 220 }} aria-label={label} value={v} onChange={(e) => form.set(k, e.target.value)}>
        {choices.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    );
  };

const effort =
  (k: 'agent.effort' | 'chat.effort' | 'jobs.effort', label: string) =>
  ({ cfg, form }: SettingCtx) => (
    <select
      className="field mono"
      style={{ width: 220 }}
      aria-label={label}
      value={valueOf(cfg, k)}
      onChange={(e) => form.set(k, e.target.value as AppSettings[typeof k])}
    >
      {EFFORT_LEVELS.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );

const reposLink = ({ wsHref }: SettingCtx) => (
  <Link className="btn" to={wsHref('/repos')}>
    Repos page →
  </Link>
);

/** `claude-opus-5-5` → `Opus 5.5`, for one-line summaries. */
export function shortModel(id: string): string {
  const parts = id.replace(/^claude-/, '').split('-');
  if (!parts[0]) return id;
  return `${parts[0][0].toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? ` ${parts.slice(1).join('.')}` : ''}`;
}

const onOff = (v: boolean) => (v ? 'on' : 'off');
const usd = (n: number) => (n > 0 ? `$${n}` : 'off');

// ---------- sections ----------

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    intent: 'look',
    device: AppearanceSettings,
    keywords: 'design glass classic theme scheme light dark system board version this device',
    summary: ({ look }) => `${look.design === 'glass' ? 'Glass' : 'Classic'} · ${look.pref} · this device`,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    intent: 'alerts',
    device: PushSettings,
    keywords:
      'push web push notifications devices kinds questions review failed anomalies approval done this device other devices',
    summary: () => 'push kinds chosen per device',
  },
  {
    id: 'orchestrator',
    title: 'Orchestrator',
    intent: 'agents',
    summary: ({ cfg, orch }) =>
      `queue ${orch.enabled ? 'running' : 'stopped'} · max ${valueOf(cfg, 'orchestrator.concurrency')} workers`,
  },
  {
    id: 'agent',
    title: 'Agent',
    intent: 'agents',
    summary: ({ cfg }) =>
      `${shortModel(valueOf(cfg, 'agent.model'))} ${valueOf(cfg, 'agent.effort')} · ${valueOf(cfg, 'agent.permissionMode')}`,
  },
  {
    id: 'review',
    title: 'Review & checks',
    intent: 'agents',
    summary: ({ cfg }) =>
      valueOf(cfg, 'review.enabled')
        ? `review on · ${shortModel(valueOf(cfg, 'review.model'))} · ${valueOf(cfg, 'review.maxRounds')} fix round(s)`
        : `review off · ${valueOf(cfg, 'checks.maxRounds')} check round(s)`,
  },
  {
    id: 'sessions',
    title: 'Sessions',
    intent: 'agents',
    intro: 'how a worker session is resumed, compacted, held and woken',
    summary: ({ cfg }) =>
      `resume ${onOff(valueOf(cfg, 'agent.resumeSessions'))} · compact ${Math.round(valueOf(cfg, 'agent.resumeContextCap') / 1000)}k · wake ${onOff(valueOf(cfg, 'agent.autoWake'))}`,
  },
  {
    id: 'routing',
    title: 'Model routing',
    intent: 'agents',
    summary: ({ cfg }) =>
      valueOf(cfg, 'router.enabled')
        ? `${shortModel(valueOf(cfg, 'router.primaryModel'))} → ${shortModel(valueOf(cfg, 'router.fallbackModel'))} at ${valueOf(cfg, 'router.usageThresholdPct')}%`
        : 'off',
  },
  {
    id: 'chat',
    title: 'Chat',
    intent: 'agents',
    summary: ({ cfg }) =>
      `${shortModel(valueOf(cfg, 'chat.model'))} ${valueOf(cfg, 'chat.effort')} · ${valueOf(cfg, 'chat.concurrency')} at once`,
  },
  {
    id: 'jobs',
    title: 'Scheduled jobs',
    intent: 'agents',
    intro: 'deferred checks fired by the server in their own queue (docs/jobs.md)',
    summary: ({ cfg }) =>
      valueOf(cfg, 'jobs.enabled')
        ? `on · below ${valueOf(cfg, 'jobs.maxActiveTasks')} active tasks · ${shortModel(valueOf(cfg, 'jobs.model'))}`
        : 'off',
  },
  {
    id: 'budget',
    title: 'Budget & alerts',
    intent: 'agents',
    intro:
      'fuses and anomaly notifications (docs/token-budget.md § Fuses) — pings go to Telegram and to devices with the Anomalies push kind on',
    summary: ({ cfg }) =>
      `${usd(valueOf(cfg, 'budget.taskUsd'))}/task · ${usd(valueOf(cfg, 'budget.dayUsd'))}/day · alert past ${valueOf(cfg, 'anomaly.longRunMin')} min`,
  },
  {
    id: 'repos',
    title: 'Per-repo settings',
    intent: 'agents',
    intro: 'set per repo on the Repos page, not here — each can also be overridden per task in the task panel',
    summary: () => 'landing, push policy, autopilot, parallel… on the Repos page',
  },
  {
    id: 'board',
    title: 'Board',
    intent: 'look',
    summary: ({ cfg }) =>
      `group colours ${onOff(valueOf(cfg, 'board.groupColors'))} · drafts stale after ${valueOf(cfg, 'inbox.staleDraftDays')} d`,
  },
  {
    id: 'presets',
    title: 'Presets',
    intent: 'content',
    intro:
      "one-click model / effort / review bundles on the new-task form, the task panel and Telegram's /new (docs/handbook.md § Quick start, Custom presets)",
    summary: ({ cfg }) => `${valueOf(cfg, 'presets.custom').length} custom preset(s)`,
  },
  {
    id: 'templates',
    title: 'Templates',
    intent: 'content',
    intro:
      "task content — title pattern, description skeleton, definition of done, checks and a preset — picked on the new-task form and in Telegram's /new (docs/inbox.md § Templates)",
    summary: ({ cfg }) => `${valueOf(cfg, 'task.templates').length} template(s)`,
  },
  {
    id: 'terminal',
    title: 'Terminal',
    intent: 'integrations',
    summary: ({ cfg }) => `click outside: ${valueOf(cfg, 'terminal.clickOutside')}`,
  },
  {
    id: 'storage',
    title: 'Storage',
    intent: 'integrations',
    summary: () => 'file-configured',
  },
  {
    id: 'sentry',
    title: 'Sentry',
    intent: 'integrations',
    summary: ({ cfg, form }) =>
      cfg['sentry.org'] && cfg['sentry.project']
        ? `${cfg['sentry.org']}/${cfg['sentry.project']} · token ${form.sentry.status?.set ? 'set' : 'not set'}`
        : 'not set up',
  },
];

export const sectionById = (id: SectionId) => SETTINGS_SECTIONS.find((s) => s.id === id)!;

// ---------- controls ----------

export const SETTINGS: readonly SettingDescriptor[] = [
  // Orchestrator
  {
    key: 'x:queue',
    section: 'orchestrator',
    label: 'Queue',
    help: 'whether the orchestrator claims queued tasks — the Start/Stop queue switch in the header, applied at once and never part of Save',
    render: ({ orch }) => <span className={`chip${orch.enabled ? ' cfg-on' : ''}`}>{orch.enabled ? 'running' : 'stopped'}</span>,
  },
  {
    key: 'orchestrator.concurrency',
    section: 'orchestrator',
    label: 'Concurrency',
    help: `max simultaneous worker sessions across all repos (default 2, up to ${CONCURRENCY_MAX}); a repo's own Parallel cap on the Repos page says how many of them may share one repo (docs/parallel.md)`,
    render: num('orchestrator.concurrency', { min: 1, max: CONCURRENCY_MAX, width: 80, label: 'Concurrency' }),
  },

  // Agent
  {
    key: 'agent.model',
    section: 'agent',
    label: 'Worker model',
    help: 'the heavy implementation work (opus); tasks can override per-task',
    render: model('agent.model', 'Worker model'),
  },
  {
    key: 'agent.effort',
    section: 'agent',
    label: 'Effort',
    help: 'reasoning effort passed via --effort',
    render: effort('agent.effort', 'Effort'),
  },
  {
    key: 'agent.permissionMode',
    section: 'agent',
    label: 'Permission mode',
    help: 'auto is the everyday mode; acceptEdits only auto-approves file edits; prompts the agent can’t answer surface as “needs attention”.',
    note: ({ cfg }) =>
      cfg['agent.permissionMode'] === 'bypassPermissions' && (
        <div className="warn-text">
          bypassPermissions runs agents with --dangerously-skip-permissions — no prompts at all. First use shows a
          one-time acceptance dialog: open the terminal and accept it.
        </div>
      ),
    render: ({ cfg, form }) => (
      <select
        className="field"
        style={{ width: 200 }}
        aria-label="Permission mode"
        value={cfg['agent.permissionMode']}
        onChange={(e) => form.set('agent.permissionMode', e.target.value as AppSettings['agent.permissionMode'])}
      >
        <option value="auto">auto (recommended)</option>
        <option value="acceptEdits">acceptEdits (cautious)</option>
        <option value="bypassPermissions">bypassPermissions ⚠</option>
      </select>
    ),
  },
  {
    key: 'analysis.model',
    section: 'agent',
    label: 'Analysis model',
    help: 'task triage / restructuring (fable tells, opus does)',
    advanced: true,
    render: model('analysis.model', 'Analysis model'),
  },
  {
    key: 'orchestrator.model',
    section: 'agent',
    label: 'Orchestrator model',
    help: 'review / coordination agents',
    advanced: true,
    render: model('orchestrator.model', 'Orchestrator model'),
  },
  {
    key: 'agent.allowEnqueue',
    section: 'agent',
    label: 'Agents may enqueue tasks',
    help: "honor workers' enqueue requests for cross-repo coordination; OFF = agent-filed tasks always land as drafts for your review",
    advanced: true,
    render: toggle('agent.allowEnqueue', 'Agents may enqueue tasks'),
  },
  {
    key: 'agent.taskCreationCap',
    section: 'agent',
    label: 'Tasks an agent may file',
    help: "how many follow-up tasks ONE worker session can file through the agent API before it's refused and told to finish its turn",
    advanced: true,
    render: num('agent.taskCreationCap', { min: 1, max: 100, width: 80, label: 'Tasks an agent may file' }),
  },
  {
    key: 'agent.maxSpawnDepth',
    section: 'agent',
    label: 'Agent chain depth',
    help: 'how many agent hops from a human a task may be and still file tasks (your task is 0, a task it files is 1, …). Past it the agent API refuses and the work waits for a human',
    advanced: true,
    render: num('agent.maxSpawnDepth', { min: 1, max: 50, width: 80, label: 'Agent chain depth' }),
  },
  {
    key: 'agent.allowedTools',
    section: 'agent',
    label: 'Allowed tools',
    help: 'extra pre-approved tools, one per line — e.g. Bash(git *)',
    advanced: true,
    render: ({ cfg, form }) => (
      <textarea
        className="field mono"
        style={{ width: 260 }}
        rows={3}
        aria-label="Allowed tools"
        value={cfg['agent.allowedTools'].join('\n')}
        onChange={(e) =>
          form.set(
            'agent.allowedTools',
            e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
          )
        }
      />
    ),
  },

  // Review & checks
  {
    key: 'review.enabled',
    section: 'review',
    label: 'Adversarial self-review',
    help: "review every worker's change before it lands in review — on the review model, falling back to Opus 5 xhigh when it's unavailable",
    render: toggle('review.enabled', 'Adversarial self-review'),
  },
  {
    key: 'review.model',
    section: 'review',
    label: 'Default review model',
    help: 'the default reviewer; a task can pick its own reviewer model (and effort) instead',
    render: model('review.model', 'Default review model'),
  },
  {
    key: 'review.maxRounds',
    section: 'review',
    label: 'Review→fix rounds',
    help: 'feed blocker/major findings back to the worker to fix, up to N rounds, before the human review queue (0 = review only, no auto-fix). Each round resumes the warm agent session and triggers a re-review, so 1 is the default — raise it only for a task you expect to argue with.',
    render: num('review.maxRounds', { min: 0, max: 5, width: 80, label: 'Review→fix rounds' }),
  },
  {
    key: 'checks.maxRounds',
    section: 'review',
    label: 'Check→fix rounds',
    help: "a red repo check (a command marked check) is handed back to the worker's own session to fix, up to N rounds, before the task lands in review as checks red. A fix turn that changes nothing stops the loop at once; budget.taskUsd applies (0 = run the checks, never ask for a fix).",
    advanced: true,
    render: num('checks.maxRounds', { min: 0, max: 10, width: 80, label: 'Check→fix rounds' }),
  },
  {
    key: 'feature.analysisMaxRounds',
    section: 'review',
    label: 'Feature plan re-analysis rounds',
    help: "a blocker verdict on a feature's plan feeds the findings back into a fresh analysis, up to N rounds (mirrors review→fix; 0 = review the plan once, never re-plan)",
    advanced: true,
    render: num('feature.analysisMaxRounds', { min: 0, max: 5, width: 80, label: 'Feature plan re-analysis rounds' }),
  },

  // Sessions
  {
    key: 'agent.resumeSessions',
    section: 'sessions',
    label: 'Resume sessions on follow-up',
    help: "a follow-up reopens the agent's previous claude session (--resume) instead of starting a fresh agent that lost its context — the same habit as typing \"proceed\" in a terminal. OFF = every follow-up respawns from the task text plus the previous summary",
    advanced: true,
    render: toggle('agent.resumeSessions', 'Resume sessions on follow-up'),
  },
  {
    key: 'agent.resumeContextCap',
    section: 'sessions',
    label: 'Compact before resuming above (tokens)',
    help: "a session bigger than this is compacted (/compact, focused on the task and the pending instruction) before the follow-up, instead of re-writing the whole conversation to cache twice — measured at ~$15 a resume on a 400k session. The session keeps its identity and its terminal; only the stale bytes go. If the compaction fails, the follow-up starts a fresh agent handed the previous one's report and the files it changed (a publish turn resumes anyway). 0 = never compact. Fires only between turns, never mid-run",
    advanced: true,
    render: num('agent.resumeContextCap', { min: 0, max: 1000000, step: 50000, width: 110, label: 'Compact before resuming above' }),
  },
  {
    key: 'agent.autoCompactWindow',
    section: 'sessions',
    label: 'Auto-compact a working session above (tokens)',
    help: "the CLI compacts a worker's session mid-run near this size instead of letting it grow to the model's 1M window, focused on the task and keeping the trailer, ship and done rules (re-stated right after). Raised to at least the resume cap above; never on the publish turn. 0 = the CLI's default (≈967k on Opus), otherwise 100000–1000000",
    advanced: true,
    render: num('agent.autoCompactWindow', { min: 0, max: 1000000, step: 50000, width: 110, label: 'Auto-compact above' }),
  },
  {
    key: 'agent.shellWaitMinutes',
    section: 'sessions',
    label: 'Wait on background commands (minutes)',
    help: 'a worker that ends its turn to wait for a command it started in the background (a test run, a Lighthouse pass) stays waiting — no review, session kept — until the command exits and the agent carries on. Bounded because a dev server left running never exits: past this many minutes the turn lands in review as usual. 0 = only subagents hold a task',
    advanced: true,
    render: num('agent.shellWaitMinutes', { min: 0, max: 240, step: 5, width: 110, label: 'Wait on background commands' }),
  },
  {
    key: 'agent.autoWake',
    section: 'sessions',
    label: 'Auto wake-up on the usage limit',
    help: "a turn that ends because the 5h usage window is spent is parked with the window's reset time and resumed automatically in its own claude session once the window reopens — instead of waiting for someone to notice and hit Resume. OFF = a spent window leaves the task where it landed",
    advanced: true,
    render: toggle('agent.autoWake', 'Auto wake-up on the usage limit'),
  },
  {
    key: 'agent.autoWakeGraceSec',
    section: 'sessions',
    label: 'Wake-up grace (seconds)',
    help: "extra wait past the stated reset time. The account's reset is a boundary, not a promise of capacity at it, and a resume that arrives early pays the full context re-write for nothing",
    advanced: true,
    render: num('agent.autoWakeGraceSec', { min: 0, max: 3600, step: 30, width: 110, label: 'Wake-up grace' }),
  },
  {
    key: 'pty.sessionTtlMinutes',
    section: 'sessions',
    label: 'Terminal keep-alive (minutes)',
    help: 'how long a finished or exited terminal stays attachable before it\'s evicted. 0 = keep forever; terminals are still recycled oldest-first when all 10 session slots are busy. "Resume" works even after eviction — it reopens the session from disk',
    advanced: true,
    render: num('pty.sessionTtlMinutes', { min: 0, max: 10080, width: 80, label: 'Terminal keep-alive' }),
  },

  // Model routing
  {
    key: 'router.enabled',
    section: 'routing',
    label: 'Route by usage',
    help: 'primary model while session (5h) usage < threshold, then fallback; tool/browser-testing tasks always use the fallback. Per-task model overrides win.',
    render: toggle('router.enabled', 'Route by usage'),
  },
  {
    key: 'router.primaryModel',
    section: 'routing',
    label: 'Primary model',
    help: 'used while usage is under the threshold',
    advanced: true,
    render: model('router.primaryModel', 'Primary model'),
  },
  {
    key: 'router.fallbackModel',
    section: 'routing',
    label: 'Fallback model',
    help: 'used past the threshold and for tool/browser-testing tasks',
    advanced: true,
    render: model('router.fallbackModel', 'Fallback model'),
  },
  {
    key: 'router.usageThresholdPct',
    section: 'routing',
    label: 'Usage threshold %',
    help: 'switch to fallback at this estimated usage',
    advanced: true,
    render: num('router.usageThresholdPct', { min: 1, max: 100, width: 80, label: 'Usage threshold %' }),
  },
  {
    key: 'router.budget5hTokens',
    section: 'routing',
    label: '5h token budget',
    help: "fallback only: when the account's own figure is unavailable, usage % is estimated from local transcripts against this budget",
    advanced: true,
    render: num('router.budget5hTokens', { min: 10000, step: 100000, width: 140, mono: true, label: '5h token budget' }),
  },
  {
    key: 'router.budgetWeekTokens',
    section: 'routing',
    label: 'Weekly token budget',
    help: 'trailing-7d budget for the `wk` estimate fallback (reporting only)',
    advanced: true,
    render: num('router.budgetWeekTokens', { min: 10000, step: 1000000, width: 140, mono: true, label: 'Weekly token budget' }),
  },
  {
    key: 'router.budgetWeekFableTokens',
    section: 'routing',
    label: 'Weekly fable budget',
    help: 'same fallback, counting fable-family models only (their separate cap)',
    advanced: true,
    render: num('router.budgetWeekFableTokens', { min: 10000, step: 1000000, width: 140, mono: true, label: 'Weekly fable budget' }),
  },

  // Chat
  {
    key: 'chat.model',
    section: 'chat',
    label: 'Chat model',
    help: 'default for a new chat (docs/chat.md); each chat can be switched afterwards',
    render: model('chat.model', 'Chat model'),
  },
  {
    key: 'chat.effort',
    section: 'chat',
    label: 'Chat effort',
    help: 'reasoning effort for chat turns',
    advanced: true,
    render: effort('chat.effort', 'Chat effort'),
  },
  {
    key: 'chat.concurrency',
    section: 'chat',
    label: 'Concurrent chat turns',
    help: 'across all chats — a chat is serial on its own; this is the fence against opening several and sending to all of them. Separate from the worker concurrency: a chat turn owns no task and must not take a worker slot',
    advanced: true,
    render: num('chat.concurrency', { min: 1, max: 5, label: 'Concurrent chat turns' }),
  },

  // Scheduled jobs
  {
    key: 'jobs.enabled',
    section: 'jobs',
    label: 'Jobs queue',
    help: 'fire due jobs on their own (docs/jobs.md); independent of the task queue switch — Pause all still stops them',
    render: toggle('jobs.enabled', 'Jobs queue'),
  },
  {
    key: 'jobs.maxActiveTasks',
    section: 'jobs',
    label: 'Fire while fewer than N tasks are active',
    help: 'running + waiting tasks across all repos (default 3, 0 = no threshold)',
    render: num('jobs.maxActiveTasks', { min: 0, max: JOB_MAX_ACTIVE_TASKS_MAX, width: 80, label: 'Fire while fewer than N tasks are active' }),
  },
  {
    key: 'jobs.concurrency',
    section: 'jobs',
    label: 'Job runs at once',
    help: `aux terminals, never a worker slot (default 1, up to ${JOB_CONCURRENCY_MAX})`,
    advanced: true,
    render: num('jobs.concurrency', { min: 1, max: JOB_CONCURRENCY_MAX, width: 80, label: 'Job runs at once' }),
  },
  {
    key: 'jobs.timeoutMinutes',
    section: 'jobs',
    label: 'Job timeout (minutes)',
    help: 'a run past this ends as an error verdict',
    advanced: true,
    render: num('jobs.timeoutMinutes', { min: 2, max: 120, width: 80, label: 'Job timeout' }),
  },
  {
    key: 'jobs.model',
    section: 'jobs',
    label: 'Job model',
    help: 'default for a job without its own pick',
    advanced: true,
    render: model('jobs.model', 'Job model'),
  },
  {
    key: 'jobs.effort',
    section: 'jobs',
    label: 'Job effort',
    help: 'reasoning effort for job runs',
    advanced: true,
    render: effort('jobs.effort', 'Job effort'),
  },
  {
    key: 'jobs.notifyOk',
    section: 'jobs',
    label: 'Ping when a job run is clean',
    help: 'Telegram/push for an ok verdict too (attention and errors always ping)',
    intent: 'alerts',
    advanced: true,
    render: toggle('jobs.notifyOk', 'Ping when a job run is clean'),
  },

  // Budget & alerts
  {
    key: 'budget.taskUsd',
    section: 'budget',
    label: 'Task budget ($)',
    help: 'no AUTOMATIC turn — review fix round, dispatch wake-up, auto wake-up — starts once a task has cost this much; your own clicks always work. 0 = off',
    render: num('budget.taskUsd', { min: 0, step: 0.5, label: 'Task budget' }),
  },
  {
    key: 'budget.dayUsd',
    section: 'budget',
    label: 'Day budget ($)',
    help: "stop claiming new tasks (global, overflow and custom queue) for the rest of the day once today's spend reaches this; running turns finish. 0 = off",
    render: num('budget.dayUsd', { min: 0, step: 1, label: 'Day budget' }),
  },
  {
    key: 'budget.runMinutes',
    section: 'budget',
    label: 'Turn time limit (min)',
    help: 'a worker turn running longer than this is flagged needs-attention and you are pinged — it is never killed. 0 = off',
    advanced: true,
    render: num('budget.runMinutes', { min: 0, step: 5, label: 'Turn time limit' }),
  },
  {
    key: 'anomaly.longRunMin',
    section: 'budget',
    label: 'Long run alert (min)',
    help: 'ping once per turn that runs longer than this (Dashboard + anomaly notification)',
    advanced: true,
    intent: 'alerts',
    render: num('anomaly.longRunMin', { min: 5, step: 5, label: 'Long run alert' }),
  },
  {
    key: 'anomaly.costUsd',
    section: 'budget',
    label: 'Expensive run alert ($)',
    help: 'per RUN, Dashboard only: flags one session turn costing more than this',
    advanced: true,
    intent: 'alerts',
    render: num('anomaly.costUsd', { min: 0.5, step: 0.5, label: 'Expensive run alert' }),
  },
  {
    key: 'anomaly.taskCostUsd',
    section: 'budget',
    label: 'Expensive task alert ($)',
    help: "per TASK (its total cost): one ping, a critical one past 2×. 0 = adaptive — the repo's 30-day p90, never under $10",
    advanced: true,
    intent: 'alerts',
    render: num('anomaly.taskCostUsd', { min: 0, step: 1, label: 'Expensive task alert' }),
  },
  {
    key: 'anomaly.staleReviewHours',
    section: 'budget',
    label: 'Stale review alert (h)',
    help: 'ping once when a task has sat in review this long',
    advanced: true,
    intent: 'alerts',
    render: num('anomaly.staleReviewHours', { min: 1, step: 1, label: 'Stale review alert' }),
  },

  // Per-repo settings (links, never a copy of the Repos page's controls)
  {
    key: 'x:repo.landing',
    section: 'repos',
    label: 'Landing',
    help: 'how far a finished task goes on its own is a per-repo tier (Repos page), overridable per task — supervised, on-green or auto-publish',
    render: reposLink,
  },
  {
    key: 'x:repo.push',
    section: 'repos',
    label: 'Push policy',
    help: 'per repo: repo-rules, agent-pushes or publish-turn — whether a worker may push its own commits (docs/publish.md § Push policy)',
    advanced: true,
    render: reposLink,
  },
  {
    key: 'x:repo.parallel',
    section: 'repos',
    label: 'Parallel worktrees',
    help: 'per repo: PR delivery and how many tasks share it in their own worktrees, plus base branch, setup command and copied files (docs/parallel.md)',
    advanced: true,
    render: reposLink,
  },
  {
    key: 'x:repo.autopilot',
    section: 'repos',
    label: 'Question autopilot · auto-approve',
    help: "per repo: answer an agent's question with its recommended option after N minutes, and pre-approve the safe approval actions (docs/questions.md § Autopilot, docs/approvals.md)",
    advanced: true,
    render: reposLink,
  },
  {
    key: 'x:repo.preview',
    section: 'repos',
    label: 'Preview URL',
    help: "per repo: the link a task's preview button opens",
    advanced: true,
    render: reposLink,
  },

  // Board
  {
    key: 'board.groupColors',
    section: 'board',
    label: 'Group colours',
    help: 'tint each task group (a task and everything split out of it) with its own colour on the board — off leaves the neutral grey blocks, grouping itself is unaffected',
    render: toggle('board.groupColors', 'Group colours'),
  },
  {
    key: 'inbox.staleDraftDays',
    section: 'board',
    label: 'Stale drafts (days)',
    help: 'an agent-filed draft older than this is listed last in the Inbox to keep, hide or cancel; Keep takes it off that list for this long again (docs/inbox.md § Stale drafts)',
    advanced: true,
    render: num('inbox.staleDraftDays', { min: 1, max: 365, step: 1, label: 'Stale drafts' }),
  },
  {
    key: 'commands.agentTtlDays',
    section: 'board',
    label: 'Agent commands: archive unused after (days)',
    help: 'a command an agent saved for its task is archived (hidden from the launcher, restorable on the Repos page) once that task lands, or when nobody started it for this long; 0 = only when the task lands (docs/commands.md § Agent-owned commands)',
    advanced: true,
    render: num('commands.agentTtlDays', { min: 0, max: 365, step: 1, label: 'Archive unused agent commands' }),
  },
  {
    key: 'worktrees.idleEvictDays',
    section: 'board',
    label: 'Task worktrees: evict idle after (days)',
    help: 'a PR-delivery task idle this long in review/failed/done has its worktree folder removed (leftovers committed to its branch; re-created on its next turn); landed and cancelled tasks lose theirs at once; 0 = never (docs/parallel.md § Cleanup)',
    advanced: true,
    render: num('worktrees.idleEvictDays', { min: 0, max: 365, step: 1, label: 'Evict idle worktrees' }),
  },

  // Presets & templates
  {
    key: 'presets.custom',
    section: 'presets',
    label: 'Custom presets',
    help: 'model / effort / review bundles of your own beside the built-in ones',
    advanced: true,
    wide: true,
    render: ({ cfg, form }) => (
      <PresetEditor value={valueOf(cfg, 'presets.custom')} onChange={(v) => form.set('presets.custom', v)} />
    ),
  },
  {
    key: 'task.templates',
    section: 'templates',
    label: 'Task templates',
    help: 'title pattern, description skeleton, definition of done, checks and a preset',
    advanced: true,
    wide: true,
    render: ({ cfg, form }) => (
      <TemplateEditor
        value={valueOf(cfg, 'task.templates')}
        onChange={(v) => form.set('task.templates', v)}
        presets={taskPresets({ 'presets.custom': cfg['presets.custom'] ?? [] })}
      />
    ),
  },

  // Terminal
  {
    key: 'terminal.clickOutside',
    section: 'terminal',
    label: 'Click outside the terminal',
    help: 'compact shrinks the open terminal to a footer bar (session stays attached — the chevron reopens it); close detaches the drawer; nothing leaves it open',
    advanced: true,
    render: ({ cfg, form }) => (
      <select
        className="field"
        style={{ width: 200 }}
        aria-label="Click outside the terminal"
        value={valueOf(cfg, 'terminal.clickOutside')}
        onChange={(e) => form.set('terminal.clickOutside', e.target.value as AppSettings['terminal.clickOutside'])}
      >
        <option value="compact">compact (default)</option>
        <option value="close">close</option>
        <option value="nothing">nothing</option>
      </select>
    ),
  },

  // Storage
  {
    key: 'x:storage.driver',
    section: 'storage',
    label: 'Driver',
    help: 'set in server/data/config.json — switch to postgres by pasting a connection string there (Supabase works as-is). Restart required.',
    advanced: true,
    render: () => <span className="chip">file-configured</span>,
  },

  // Sentry
  {
    key: 'sentry.org',
    section: 'sentry',
    label: 'Sentry org',
    help: 'sync pulls unresolved issues (14d) as tasks; re-sync never duplicates',
    advanced: true,
    render: text('sentry.org', { width: 160, placeholder: 'org', label: 'Sentry org' }),
  },
  {
    key: 'sentry.project',
    section: 'sentry',
    label: 'Sentry project',
    help: 'the project whose issues are pulled',
    advanced: true,
    render: text('sentry.project', { width: 160, placeholder: 'project', label: 'Sentry project' }),
  },
  {
    key: 'x:sentry.token',
    section: 'sentry',
    label: 'Auth token',
    help: 'kept in server/data/config.json, never shown again; saved with Save',
    advanced: true,
    note: ({ form }) => {
      const st = form.sentry.status;
      return (
        <div className="hint">
          {st?.set ? `set${st.last4 ? ` · ends …${st.last4}` : ''} — type a new one to replace it` : 'not set'}
        </div>
      );
    },
    render: ({ form }) => {
      const st = form.sentry.status;
      return (
        <span className="cfg-inline">
          <input
            className="field mono"
            style={{ width: st?.set ? 190 : 260 }}
            type="password"
            autoComplete="off"
            aria-label="Sentry auth token"
            placeholder={st?.set ? 'replace…' : 'paste token'}
            value={form.sentry.draft}
            onChange={(e) => form.sentry.setDraft(e.target.value)}
          />
          {st?.set && (
            <button className="btn" onClick={form.sentry.clear}>
              Clear
            </button>
          )}
        </span>
      );
    },
  },
  {
    key: 'sentry.apiBase',
    section: 'sentry',
    label: 'API base',
    help: 'EU-residency orgs use https://de.sentry.io',
    advanced: true,
    render: text('sentry.apiBase', { width: 260, label: 'Sentry API base' }),
  },
  {
    key: 'sentry.categoryTag',
    section: 'sentry',
    label: 'Category from tag',
    help: 'Sentry tag key → task category (blank = use the issue level)',
    advanced: true,
    render: text('sentry.categoryTag', { width: 160, placeholder: 'environment', label: 'Sentry category tag' }),
  },
  {
    key: 'sentry.repoId',
    section: 'sentry',
    label: 'Assign to repo',
    help: 'new sentry tasks land on this repo',
    advanced: true,
    render: ({ cfg, form, repos }) => (
      <select
        className="field"
        style={{ width: 260 }}
        aria-label="Sentry repo"
        value={cfg['sentry.repoId']}
        onChange={(e) => form.set('sentry.repoId', e.target.value)}
      >
        <option value="">— none —</option>
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
            {r.role ? ` (${r.role})` : ''}
          </option>
        ))}
      </select>
    ),
  },
  {
    key: 'x:sentry.sync',
    section: 'sentry',
    label: 'Sync issues now',
    help: 'saves first, then pulls the issues',
    advanced: true,
    note: ({ form }) => form.sentry.syncMsg && <div className="muted mono">{form.sentry.syncMsg}</div>,
    render: ({ form }) => (
      <button className="btn primary" disabled={form.sentry.syncing} onClick={form.sentry.sync}>
        {form.sentry.syncing ? 'Syncing…' : 'Sync issues now'}
      </button>
    ),
  },
];

export const settingsIn = (section: SectionId) => SETTINGS.filter((s) => s.section === section);

export const intentOf = (s: SettingDescriptor) => s.intent ?? sectionById(s.section).intent;

/**
 * Search (every version): each word of the query must appear in the label,
 * the key, the help or the section title. Case-insensitive.
 */
export function matchesSetting(s: SettingDescriptor, words: string[]): boolean {
  if (!words.length) return true;
  const hay = `${s.label} ${s.key} ${s.help} ${sectionById(s.section).title}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function matchesDevice(sec: SettingsSection, words: string[]): boolean {
  if (!sec.device || !words.length) return !!sec.device;
  const hay = `${sec.title} ${sec.keywords ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const queryWords = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
