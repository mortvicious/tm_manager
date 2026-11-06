// The office planner (docs/office.md § Office planner). Before an office
// exists: a no-token wizard → one read-only planning turn → a BLUEPRINT the
// owner edits inline and applies (a new, DISABLED office through the office
// routes' own validators). Afterwards: the Assistant — a chat over the
// office's current state whose replies may carry a blueprint DIFF, applied
// with one press; a diff planned against another state of the office is
// stale (the server refuses it with 409). The transcript lives in the app
// store (`chatMessages`, kept current by `chat.message` frames); the view
// (chat row + the office's current fingerprint) is re-read on the planner
// chat's `chat.updated` and on the office's `office.updated`.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  OFFICE_AUTONOMY_LEVELS,
  OFFICE_BLUEPRINT_SETTING_KEYS,
  OFFICE_PLANNER_GOALS,
  OFFICE_PLANNER_GOAL_LABELS,
  SHIFT_TOOL_ALLOWLIST,
  cronError,
  describeGuard,
  isValidTimeZone,
  roleEditChanges,
  wizardDayBudget,
  type ChatMessage,
  type EffortLevel,
  type Office,
  type OfficeAutonomy,
  type OfficeBlueprint,
  type OfficeBlueprintDiff,
  type OfficeBlueprintRole,
  type OfficeBlueprintSettings,
  type OfficePlannerGoal,
  type OfficePlannerView,
  type OfficePlannerWizard,
  type OfficeRole,
  type OfficeTrigger,
  type Workspace,
} from '@tm/shared';
import { api } from '../api.ts';
import { useArm } from '../arm.ts';
import { onServerEvent, useApp } from '../state.tsx';
import { toastError } from '../toast.ts';
import { Reply } from '../pages/Chat.tsx';
import { IconSend, IconStop } from './Icons.tsx';

const AUTONOMY_HELP: Record<OfficeAutonomy, string> = {
  proposals: 'Proposals — the office suggests, you decide every task',
  'auto-run': 'Auto-run — its tasks are queued and run; you review the results',
  autonomous: 'Autonomous — it runs and lands on the repos’ own landing tiers',
};

const SETTING_LABEL: Record<keyof OfficeBlueprintSettings, string> = {
  maxSlots: 'Worker slots',
  dayBudgetUsd: 'Day budget $',
  maxTasksPerShift: 'Tasks per shift',
  maxOpenTasks: 'Open tasks',
  autonomy: 'Autonomy',
};

const usd = (n: number) => `$${n.toFixed(n >= 10 ? 0 : 2)}`;
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const errText = (e: unknown) => (e as Error)?.message || String(e);
const tzKey = (wsId: string) => `tm.officePlanner.tz.${wsId}`;
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function triggerText(t: OfficeTrigger): string {
  return t.kind === 'event' ? `on ${t.event}` : t.kind === 'signal' ? `on ${t.source} issues` : 'after its commands ran';
}

/** The planner's view for a workspace, re-read when its chat or its office moves. */
function usePlannerView(workspaceId: string): { view: OfficePlannerView | null; error: string | null; reload: () => void } {
  const [view, setView] = useState<OfficePlannerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const officeId = useRef<string | null>(null);
  const reload = useCallback(() => {
    api.getOfficePlanner(workspaceId).then(
      (v) => {
        officeId.current = v.office?.id ?? null;
        setView(v);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  }, [workspaceId]);
  useEffect(() => {
    setView(null);
    reload();
    const off = onServerEvent((e) => {
      if (e.type === 'chat.updated' && e.chat.plannerWorkspaceId === workspaceId) reload();
      else if (e.type === 'chat.deleted') reload();
      else if (e.type === 'office.updated' && (e.office.workspaceId === workspaceId || e.office.id === officeId.current)) reload();
    });
    return off;
  }, [workspaceId, reload]);
  return { view, error, reload };
}

/** The transcript from the store (loaded once the chat exists). */
function usePlannerMessages(chatId: string | null): ChatMessage[] | undefined {
  const { chatMessages, loadChat } = useApp();
  useEffect(() => {
    if (chatId) loadChat(chatId).catch((e) => toastError(e, 'Could not load the planner chat'));
  }, [chatId, loadChat]);
  return chatId ? chatMessages[chatId] : [];
}

// ─── Before the office exists ────────────────────────────────────────────

/**
 * The planner before an office exists: the wizard until the first turn, then
 * the conversation with the latest blueprint as editable cards.
 */
export function OfficePlannerFlow({
  workspace,
  inSheet,
  onCreated,
  onCancel,
}: {
  workspace: Workspace;
  inSheet: boolean;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { view, error, reload } = usePlannerView(workspace.id);
  const messages = usePlannerMessages(view?.chat?.id ?? null);
  const { armed, press } = useArm();

  if (error) return <div className="warn-text office-pad">{error}</div>;
  if (!view) return <div className="muted office-pad">Loading…</div>;
  // No conversation yet — or an empty planner chat (a refused wizard turn):
  // keep the wizard, its answers and its error, mounted.
  if (!view.chat || view.messages.length === 0) return <PlannerWizard workspace={workspace} onStarted={reload} onCancel={onCancel} />;

  const latest = messages ? [...messages].reverse().find((m) => m.blueprint?.kind === 'blueprint') : undefined;
  const startOver = async () => {
    if (!press('reset')) return;
    try {
      await api.resetPlanner(workspace.id);
      reload();
    } catch (e) {
      toastError(e, 'Could not start over');
    }
  };

  return (
    <div className={`office-planner office-chat${inSheet ? ' in-sheet' : ''}`}>
      <div className="office-planner-head">
        <span className="office-hint muted">
          The assistant read your repos and drafted an office. Edit the cards, ask it to change something, then apply — the office
          starts switched off.
        </span>
        <button className={`btn ghost${armed === 'reset' ? ' danger' : ''}`} onClick={() => void startOver()}>
          {armed === 'reset' ? 'Start over? tap again' : 'Start over'}
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Back
        </button>
      </div>
      <PlannerTranscript workspaceId={workspace.id} view={view} messages={messages} highlight={latest?.id ?? null} />
      {latest && latest.blueprint?.kind === 'blueprint' && (
        <BlueprintEditor
          key={latest.id}
          workspaceId={workspace.id}
          messageId={latest.id}
          initial={latest.blueprint.blueprint}
          onApplied={onCreated}
        />
      )}
      <PlannerComposer workspaceId={workspace.id} chatStatus={view.chat.status} placeholder="Ask for changes — “drop SEO, add a weekly security review”" />
    </div>
  );
}

const STEPS = ['What you want', 'How hands-off', 'Budget', 'Quiet hours'] as const;

function PlannerWizard({ workspace, onStarted, onCancel }: { workspace: Workspace; onStarted: () => void; onCancel: () => void }) {
  const [step, setStep] = useState(0);
  const [goals, setGoals] = useState<OfficePlannerGoal[]>(['ship-features', 'keep-tested']);
  const [wants, setWants] = useState('');
  const [autonomy, setAutonomy] = useState<OfficeAutonomy>('proposals');
  const [amount, setAmount] = useState('5');
  const [per, setPer] = useState<'day' | 'month'>('day');
  const [quiet, setQuiet] = useState(true);
  const [from, setFrom] = useState('22:00');
  const [to, setTo] = useState('07:00');
  const [tz, setTz] = useState(browserTz);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const amountN = Number(amount);
  const budgetBad = !Number.isFinite(amountN) || amountN <= 0;
  const tzBad = !isValidTimeZone(tz.trim());
  const quietBad = quiet && (!from || !to || from === to);
  const day = budgetBad ? 0 : wizardDayBudget({ budget: { amountUsd: amountN, per } });
  const blocked = (step === 2 && budgetBad) || (step === 3 && (tzBad || quietBad));

  const toggle = (g: OfficePlannerGoal) => setGoals((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  const start = async () => {
    const wizard: OfficePlannerWizard = {
      goals,
      wants: wants.trim(),
      autonomy,
      budget: { amountUsd: amountN, per },
      quietHours: quiet ? { from, to } : null,
      timezone: tz.trim(),
    };
    setBusy(true);
    setErr(null);
    try {
      await api.planOffice(workspace.id, wizard);
      try {
        localStorage.setItem(tzKey(workspace.id), wizard.timezone);
      } catch {
        /* private mode: the apply form defaults to this browser's zone */
      }
      onStarted();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel office-planner-wizard">
      <div className="office-section-title">Plan an office for {workspace.name}</div>
      <ol className="office-planner-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}>
            <button className="office-planner-step" disabled={i > step} onClick={() => setStep(i)}>
              <span className="office-planner-step-n">{i + 1}</span> {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="office-planner-pane">
          <div className="office-planner-goals">
            {OFFICE_PLANNER_GOALS.map((g) => (
              <label key={g} className={`office-planner-goal${goals.includes(g) ? ' on' : ''}`}>
                <input type="checkbox" checked={goals.includes(g)} onChange={() => toggle(g)} />
                {OFFICE_PLANNER_GOAL_LABELS[g]}
              </label>
            ))}
          </div>
          <label className="label">In your words (optional)</label>
          <textarea
            className="field office-planner-wants"
            rows={4}
            maxLength={4000}
            value={wants}
            placeholder="What should this office take off your plate? What matters most in these repos?"
            onChange={(e) => setWants(e.target.value)}
          />
        </div>
      )}
      {step === 1 && (
        <div className="office-planner-pane office-planner-radios">
          {OFFICE_AUTONOMY_LEVELS.map((a) => (
            <label key={a} className={`office-planner-radio${autonomy === a ? ' on' : ''}`}>
              <input type="radio" name="autonomy" checked={autonomy === a} onChange={() => setAutonomy(a)} />
              {AUTONOMY_HELP[a]}
            </label>
          ))}
        </div>
      )}
      {step === 2 && (
        <div className="office-planner-pane">
          <div className="office-planner-row">
            <span>$</span>
            <input className="field office-planner-num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <select className="field office-planner-per" value={per} onChange={(e) => setPer(e.target.value as 'day' | 'month')}>
              <option value="day">per day</option>
              <option value="month">per month</option>
            </select>
          </div>
          {budgetBad ? (
            <div className="warn-text">a budget above $0</div>
          ) : (
            <div className="office-hint muted">
              The office’s day budget would be {usd(day)}. The assistant sizes the roles to fit; you can change it before applying.
            </div>
          )}
        </div>
      )}
      {step === 3 && (
        <div className="office-planner-pane">
          <label className="office-planner-radio">
            <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} /> Nothing wakes during quiet hours
          </label>
          {quiet && (
            <div className="office-planner-row">
              <input className="field" type="time" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Quiet from" />
              <span className="muted">to</span>
              <input className="field" type="time" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Quiet until" />
            </div>
          )}
          {quietBad && <div className="warn-text">quiet hours need distinct times</div>}
          <label className="label">Time zone</label>
          <input className="field" value={tz} onChange={(e) => setTz(e.target.value)} />
          {tzBad && <div className="warn-text">not an IANA zone (like Europe/Berlin)</div>}
        </div>
      )}

      {err && <div className="warn-text">{err}</div>}
      <div className="office-actions">
        {step > 0 ? (
          <button className="btn ghost" onClick={() => setStep(step - 1)}>
            Back
          </button>
        ) : (
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button className="btn primary" disabled={blocked} onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button className="btn primary" disabled={busy || blocked} onClick={() => void start()}>
            Plan my office
          </button>
        )}
        <span className="office-hint muted">One read-only planning session reads the repos; it counts toward the day fuse.</span>
      </div>
    </div>
  );
}

/** A blueprint as inline-editable cards, applied as a new disabled office. */
function BlueprintEditor({
  workspaceId,
  messageId,
  initial,
  onApplied,
}: {
  workspaceId: string;
  messageId: string;
  initial: OfficeBlueprint;
  onApplied: () => void;
}) {
  const [bp, setBp] = useState<OfficeBlueprint>(initial);
  const [folder, setFolder] = useState('');
  const [tz, setTz] = useState(() => {
    try {
      return localStorage.getItem(tzKey(workspaceId)) || browserTz();
    } catch {
      return browserTz();
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tzBad = !isValidTimeZone(tz.trim());
  const cronBad = bp.roles.some((r) => r.schedules.some((s) => cronError(s)));

  const setOffice = <K extends keyof OfficeBlueprintSettings>(k: K, v: OfficeBlueprintSettings[K]) => setBp({ ...bp, office: { ...bp.office, [k]: v } });
  const setRole = (i: number, r: OfficeBlueprintRole) => setBp({ ...bp, roles: bp.roles.map((x, j) => (j === i ? r : x)) });
  const dropRole = (i: number) => setBp({ ...bp, roles: bp.roles.filter((_, j) => j !== i) });

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.applyBlueprint(workspaceId, { blueprint: bp, ...(folder.trim() ? { folderPath: folder.trim() } : {}), timezone: tz.trim(), messageId });
      onApplied();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel office-blueprint">
      <div className="office-section-title">Blueprint</div>
      <p className="office-help">{bp.summary}</p>

      <div className="office-blueprint-settings">
        {OFFICE_BLUEPRINT_SETTING_KEYS.map((k) =>
          k === 'autonomy' ? (
            <label key={k}>
              <span className="label">{SETTING_LABEL[k]}</span>
              <select className="field" value={bp.office.autonomy} onChange={(e) => setOffice('autonomy', e.target.value as OfficeAutonomy)}>
                {OFFICE_AUTONOMY_LEVELS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label key={k}>
              <span className="label">{SETTING_LABEL[k]}</span>
              <input
                className="field"
                inputMode="decimal"
                value={String(bp.office[k])}
                onChange={(e) => setOffice(k, Number(e.target.value) as never)}
              />
            </label>
          ),
        )}
      </div>
      <div className="office-blueprint-cost">
        <span className="chip">≈ {usd(bp.cost.dailyUsd)}/day</span>
        <span className="muted">{bp.cost.derivation}</span>
      </div>

      <div className="office-blueprint-roles">
        {bp.roles.map((r, i) => (
          <BlueprintRoleCard key={`${r.key}-${i}`} role={r} onChange={(x) => setRole(i, x)} onRemove={() => dropRole(i)} />
        ))}
      </div>

      {(bp.wins.length > 0 || bp.avoid.length > 0) && (
        <div className="office-blueprint-lists">
          {bp.wins.length > 0 && (
            <div>
              <div className="label">First wins</div>
              <ul>
                {bp.wins.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {bp.avoid.length > 0 && (
            <div>
              <div className="label">Not worth trying</div>
              <ul>
                {bp.avoid.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <details className="office-blueprint-doc">
        <summary>vision.md {bp.vision.trim() ? '' : <span className="muted">(keep the scaffold)</span>}</summary>
        <textarea className="field office-doc-text" value={bp.vision} onChange={(e) => setBp({ ...bp, vision: e.target.value })} />
      </details>
      <details className="office-blueprint-doc">
        <summary>priorities.md {bp.priorities.trim() ? '' : <span className="muted">(keep the scaffold)</span>}</summary>
        <textarea className="field office-doc-text" value={bp.priorities} onChange={(e) => setBp({ ...bp, priorities: e.target.value })} />
      </details>

      <div className="form-grid office-gap">
        <div>
          <label className="label">Folder (outside every repo)</label>
          <input className="field" value={folder} placeholder="default: <shared space folder>/office" onChange={(e) => setFolder(e.target.value)} />
        </div>
        <div>
          <label className="label">Time zone</label>
          <input className="field" value={tz} onChange={(e) => setTz(e.target.value)} />
          {tzBad && <div className="warn-text">not an IANA zone (like Europe/Berlin)</div>}
        </div>
      </div>
      {err && <div className="warn-text office-gap">{err}</div>}
      <div className="office-actions">
        <button className="btn primary" disabled={busy || tzBad || cronBad || bp.roles.length === 0} onClick={() => void apply()}>
          Create this office
        </button>
        <span className="office-hint muted">It starts switched off — turn it on from the office settings.</span>
      </div>
    </div>
  );
}

function BlueprintRoleCard({ role, onChange, onRemove }: { role: OfficeBlueprintRole; onChange: (r: OfficeBlueprintRole) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const [schedText, setSchedText] = useState(role.schedules.join('\n'));
  const bad = role.schedules.map((s) => [s, cronError(s)] as const).filter(([, e]) => e);
  const set = (patch: Partial<OfficeBlueprintRole>) => onChange({ ...role, ...patch });
  const toggleTool = (t: string) => set({ tools: role.tools.includes(t) ? role.tools.filter((x) => x !== t) : [...role.tools, t] });

  return (
    <div className="office-blueprint-role">
      <div className="office-blueprint-role-head">
        <input className="field office-blueprint-title" value={role.title} aria-label="Role title" onChange={(e) => set({ title: e.target.value })} />
        <span className="chip">{role.preset ? `preset · ${role.key}` : `custom · ${role.key}`}</span>
        {role.capUsd != null && <span className="chip">≤ {usd(role.capUsd)}/day</span>}
        <button className="btn ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Less' : 'Edit'}
        </button>
        <button className="btn ghost" title="Leave this role out" onClick={onRemove}>
          Drop
        </button>
      </div>
      <div className="office-hint muted">{role.why}</div>
      <div className="office-blueprint-role-sub muted">
        {role.schedules.length ? role.schedules.join(' · ') : 'no schedule'}
        {role.triggers.length > 0 && ` · ${role.triggers.map(triggerText).join(' · ')}`}
        {role.guards.length > 0 && ` · ${role.guards.map(describeGuard).join(' · ')}`}
      </div>
      {open && (
        <div className="office-blueprint-role-edit">
          <label className="label">Prompt</label>
          <textarea className="field" rows={5} value={role.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          <div className="form-grid">
            <div>
              <label className="label">Model</label>
              <select className="field" value={role.model} onChange={(e) => set({ model: e.target.value })}>
                {[...new Set([role.model, ...MODEL_OPTIONS])].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Effort</label>
              <select className="field" value={role.effort ?? ''} onChange={(e) => set({ effort: (e.target.value || null) as EffortLevel | null })}>
                <option value="">default</option>
                {EFFORT_LEVELS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Cap $/day</label>
              <input
                className="field"
                inputMode="decimal"
                value={role.capUsd == null ? '' : String(role.capUsd)}
                placeholder="none"
                onChange={(e) => set({ capUsd: e.target.value.trim() === '' ? null : Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="label">Autonomy</label>
              <select className="field" value={role.autonomy ?? ''} onChange={(e) => set({ autonomy: (e.target.value || null) as OfficeAutonomy | null })}>
                <option value="">the office’s</option>
                {OFFICE_AUTONOMY_LEVELS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="label">Schedules (cron, one per line, office time)</label>
          <textarea
            className="field"
            rows={2}
            value={schedText}
            onChange={(e) => {
              setSchedText(e.target.value);
              set({ schedules: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) });
            }}
          />
          {bad.map(([s, e]) => (
            <div key={s} className="warn-text">
              {s}: {e}
            </div>
          ))}
          <label className="label">Tools</label>
          <div className="office-blueprint-tools">
            {SHIFT_TOOL_ALLOWLIST.map((t) => (
              <label key={t} className={`office-planner-goal${role.tools.includes(t) ? ' on' : ''}`}>
                <input type="checkbox" checked={role.tools.includes(t)} onChange={() => toggleTool(t)} />
                {t}
              </label>
            ))}
          </div>
          {role.guards.length > 0 && (
            <>
              <label className="label">Guards</label>
              <div className="office-blueprint-tools">
                {role.guards.map((g, i) => (
                  <span key={i} className="chip">
                    {describeGuard(g)}{' '}
                    <button className="office-blueprint-x" aria-label="Remove guard" onClick={() => set({ guards: role.guards.filter((_, j) => j !== i) })}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── After the office exists ─────────────────────────────────────────────

/** The office's Assistant: a chat whose replies may carry a diff applied with one press. */
export function OfficeAssistant({ office, roles, inSheet }: { office: Office; roles: OfficeRole[]; inSheet: boolean }) {
  const { view, error, reload } = usePlannerView(office.workspaceId);
  const messages = usePlannerMessages(view?.chat?.id ?? null);
  const { armed, press } = useArm();

  const clear = async () => {
    if (!press('clear')) return;
    try {
      await api.resetPlanner(office.workspaceId);
      reload();
    } catch (e) {
      toastError(e, 'Could not clear the conversation');
    }
  };

  return (
    <div className={`office-planner office-chat${inSheet ? ' in-sheet' : ''}`}>
      {!inSheet && <div className="office-section-title">Assistant</div>}
      <div className="office-chat-head">
        <span className="office-hint muted">
          Ask how to tune this office — roles, schedules, budget. It reads the office and the repos (read-only); a suggested change is applied
          only when you press Apply.
        </span>
        {view?.chat && (
          <button className={`btn ghost${armed === 'clear' ? ' danger' : ''}`} onClick={() => void clear()}>
            {armed === 'clear' ? 'Clear? tap again' : 'Clear'}
          </button>
        )}
      </div>
      {error && <div className="warn-text office-pad">{error}</div>}
      {!view ? (
        <div className="muted office-pad">Loading…</div>
      ) : (
        <>
          <PlannerTranscript workspaceId={office.workspaceId} view={view} messages={messages} roles={roles} onApplied={reload} highlight={null} />
          <PlannerComposer
            workspaceId={office.workspaceId}
            chatStatus={view.chat?.status ?? 'idle'}
            placeholder="“Why does QA keep skipping?” · “Cut the budget to $3”"
          />
        </>
      )}
    </div>
  );
}

// ─── Shared pieces ───────────────────────────────────────────────────────

function PlannerTranscript({
  workspaceId,
  view,
  messages,
  roles,
  onApplied,
  highlight,
}: {
  workspaceId: string;
  view: OfficePlannerView;
  messages: ChatMessage[] | undefined;
  roles?: OfficeRole[];
  onApplied?: () => void;
  highlight: string | null;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const thinking = view.chat?.status === 'thinking';
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages?.length, thinking]);

  return (
    <div className="office-chat-log office-planner-log">
      {messages === undefined ? (
        <div className="muted">Loading…</div>
      ) : messages.length === 0 ? (
        <div className="muted">Nothing yet.</div>
      ) : (
        messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="chat-msg user">
              <div className="chat-meta">you · {when(m.createdAt)}</div>
              <div className="chat-body">
                <Reply text={m.text} />
              </div>
            </div>
          ) : (
            <div key={m.id} className={`chat-msg assistant${m.id === highlight ? ' office-planner-current' : ''}`}>
              <div className="chat-meta">
                assistant · {when(m.createdAt)}
                {m.durationMs ? ` · ${Math.round(m.durationMs / 1000)}s` : ''}
                {m.costUsd > 0 ? ` · $${m.costUsd.toFixed(2)}` : ''}
              </div>
              <div className={`chat-body${m.error ? ' warn-text' : ''}`}>{m.error ? `⚠ ${m.error}` : <Reply text={m.text} />}</div>
              {m.blueprint?.kind === 'blueprint' && !view.office && m.id !== highlight && (
                <div className="office-hint muted">an earlier blueprint — the latest one is below</div>
              )}
              {m.blueprint?.kind === 'diff' && view.office && (
                <DiffCard
                  workspaceId={workspaceId}
                  message={m}
                  diff={m.blueprint.diff}
                  baseFingerprint={m.blueprint.baseFingerprint}
                  current={view.fingerprint}
                  office={view.office}
                  roles={roles ?? []}
                  onApplied={onApplied}
                />
              )}
            </div>
          ),
        )
      )}
      {thinking && <div className="chat-thinking">The assistant is thinking…</div>}
      <div ref={endRef} />
    </div>
  );
}

function DiffCard({
  workspaceId,
  message,
  diff,
  baseFingerprint,
  current,
  office,
  roles,
  onApplied,
}: {
  workspaceId: string;
  message: ChatMessage;
  diff: OfficeBlueprintDiff;
  baseFingerprint: string;
  current: string | null;
  office: Office;
  roles: OfficeRole[];
  onApplied?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const applied = !!message.blueprintAppliedAt;
  const stale = !applied && current !== null && current !== baseFingerprint;
  const byKey = new Map(roles.map((r) => [r.key, r]));

  const lines: string[] = [];
  for (const k of OFFICE_BLUEPRINT_SETTING_KEYS) {
    const v = diff.office?.[k];
    if (v !== undefined && v !== office[k]) lines.push(`${SETTING_LABEL[k]}: ${String(office[k])} → ${String(v)}`);
  }
  for (const key of diff.removeRoles ?? []) lines.push(`remove ${byKey.get(key)?.name ?? key}`);
  for (const e of diff.editRoles ?? []) {
    const cur = byKey.get(e.key);
    const fields = cur ? roleEditChanges(e, cur) : [];
    if (!fields.length) continue;
    const detail = fields.map((f) => (f === 'schedules' ? `schedules → ${(e.schedules ?? []).join(' · ') || 'none'}` : f === 'capUsd' ? `cap → ${e.capUsd == null ? 'none' : usd(e.capUsd)}` : f)).join(', ');
    lines.push(`${cur?.name ?? e.key}: ${detail}`);
  }
  for (const a of diff.addRoles ?? []) lines.push(`add ${a.title} (${a.key})${a.schedules.length ? ` — ${a.schedules.join(' · ')}` : ''}`);
  if (diff.vision !== undefined) lines.push('rewrite vision.md');
  if (diff.priorities !== undefined) lines.push('rewrite priorities.md');

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.applyBlueprintDiff(workspaceId, { diff, baseFingerprint, messageId: message.id });
      onApplied?.();
    } catch (e) {
      setErr(errText(e));
      onApplied?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`office-diff${stale ? ' stale' : ''}${applied ? ' applied' : ''}`}>
      <div className="office-diff-head">
        <span className="office-diff-title">{diff.summary}</span>
        {diff.cost && <span className="chip">≈ {usd(diff.cost.dailyUsd)}/day</span>}
      </div>
      <ul className="office-diff-lines">
        {lines.length ? lines.map((l) => <li key={l}>{l}</li>) : <li className="muted">nothing that differs from the office now</li>}
      </ul>
      {(diff.vision !== undefined || diff.priorities !== undefined) && (
        <details className="office-blueprint-doc">
          <summary>Preview the docs</summary>
          {diff.vision !== undefined && <pre className="office-diff-doc">{diff.vision}</pre>}
          {diff.priorities !== undefined && <pre className="office-diff-doc">{diff.priorities}</pre>}
        </details>
      )}
      {err && <div className="warn-text">{err}</div>}
      <div className="office-diff-actions">
        {applied ? (
          <span className="chip office-onoff on">applied</span>
        ) : stale ? (
          <span className="muted">The office changed since this was proposed — ask again for a fresh change.</span>
        ) : (
          <button className="btn primary" disabled={busy || lines.length === 0} onClick={() => void apply()}>
            Apply
          </button>
        )}
      </div>
    </div>
  );
}

function PlannerComposer({ workspaceId, chatStatus, placeholder }: { workspaceId: string; chatStatus: string; placeholder: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const thinking = chatStatus === 'thinking';
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setErr(null);
    try {
      await api.sendPlannerMessage(workspaceId, body);
      setText('');
    } catch (e) {
      setErr(errText(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="office-chat-compose">
      {err && <div className="warn-text office-chat-target">{err}</div>}
      <div className="chat-composer">
        <textarea
          value={text}
          rows={2}
          placeholder={thinking ? 'Waiting for the reply…' : placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {thinking ? (
          <button className="btn ghost" title="Stop this turn" onClick={() => void api.stopPlanner(workspaceId).catch(() => {})}>
            <IconStop />
          </button>
        ) : (
          <button className="btn" disabled={!text.trim() || sending} onClick={() => void send()}>
            <IconSend />
          </button>
        )}
      </div>
    </div>
  );
}
