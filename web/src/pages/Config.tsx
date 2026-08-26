import { useEffect, useRef, useState } from 'react';
import { EFFORT_LEVELS, MODEL_OPTIONS, type AppSettings } from '@tm/shared';
import { api } from '../api.ts';
import { useApp } from '../state.tsx';

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="track">
        <span className="knob" />
      </span>
    </div>
  );
}

export function ConfigPage() {
  const [cfg, setCfg] = useState<AppSettings | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const snapshot = useRef<AppSettings | null>(null);
  const { repos, refresh } = useApp();
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setCfg(c);
        snapshot.current = c;
      })
      .catch((e) => setErr(e.message));
  }, []);

  if (!cfg) return <div className="muted">{err ?? 'Loading…'}</div>;

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setCfg({ ...cfg, [k]: v });

  const save = async () => {
    setErr(null);
    setSaved(false);
    try {
      // Send only the keys this page changed — never clobber machine-owned
      // state like orchestrator.enabled or stray DB keys (review R11).
      const diff: Partial<AppSettings> = {};
      for (const k of Object.keys(cfg) as (keyof AppSettings)[]) {
        if (snapshot.current && JSON.stringify(cfg[k]) !== JSON.stringify(snapshot.current[k])) {
          (diff as Record<string, unknown>)[k] = cfg[k];
        }
      }
      delete (diff as Record<string, unknown>)['orchestrator.enabled'];
      const next = await api.putConfig(diff);
      setCfg(next);
      snapshot.current = next;
      // the app state carries settings the UI reacts to (board.groupColors)
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const modelChoices = MODEL_OPTIONS.includes(cfg['agent.model'])
    ? MODEL_OPTIONS
    : [cfg['agent.model'], ...MODEL_OPTIONS];

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 className="page-title">
        Config
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={save}>
          {saved ? 'Saved ✓' : 'Save'}
        </button>
      </h1>
      {err && <div className="warn-text" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="panel cfg-group">
        <h3>Orchestrator</h3>
        <div className="cfg-row">
          <div>
            <div>Concurrency</div>
            <div className="hint">max simultaneous worker sessions (2 recommended)</div>
          </div>
          <input
            className="field"
            style={{ width: 80 }}
            type="number"
            min={1}
            max={10}
            value={cfg['orchestrator.concurrency']}
            onChange={(e) => set('orchestrator.concurrency', Number(e.target.value))}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>Auto-complete tasks</div>
            <div className="hint">first agent turn-end marks the task done instead of review</div>
          </div>
          <Toggle on={cfg['orchestrator.autoComplete']} onChange={(v) => set('orchestrator.autoComplete', v)} />
        </div>
      </div>

      <div className="panel cfg-group">
        <h3>Agent</h3>
        <div className="cfg-row">
          <div>
            <div>Worker model</div>
            <div className="hint">the heavy implementation work (opus); tasks can override per-task</div>
          </div>
          <select
            className="field mono"
            style={{ width: 220 }}
            value={cfg['agent.model']}
            onChange={(e) => set('agent.model', e.target.value)}
          >
            {modelChoices.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="cfg-row">
          <div>
            <div>Effort</div>
            <div className="hint">reasoning effort passed via --effort</div>
          </div>
          <select
            className="field mono"
            style={{ width: 220 }}
            value={cfg['agent.effort']}
            onChange={(e) => set('agent.effort', e.target.value as AppSettings['agent.effort'])}
          >
            {EFFORT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="cfg-row">
          <div>
            <div>Analysis model</div>
            <div className="hint">task triage / restructuring (fable tells, opus does)</div>
          </div>
          <select
            className="field mono"
            style={{ width: 220 }}
            value={cfg['analysis.model']}
            onChange={(e) => set('analysis.model', e.target.value)}
          >
            {(MODEL_OPTIONS.includes(cfg['analysis.model'])
              ? MODEL_OPTIONS
              : [cfg['analysis.model'], ...MODEL_OPTIONS]
            ).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="cfg-row">
          <div>
            <div>Orchestrator model</div>
            <div className="hint">review / coordination agents</div>
          </div>
          <select
            className="field mono"
            style={{ width: 220 }}
            value={cfg['orchestrator.model']}
            onChange={(e) => set('orchestrator.model', e.target.value)}
          >
            {(MODEL_OPTIONS.includes(cfg['orchestrator.model'])
              ? MODEL_OPTIONS
              : [cfg['orchestrator.model'], ...MODEL_OPTIONS]
            ).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="cfg-row">
          <div>
            <div>Agents may enqueue tasks</div>
            <div className="hint">
              honor workers' enqueue requests for cross-repo coordination; OFF = agent-filed tasks always
              land as drafts for your review
            </div>
          </div>
          <Toggle on={cfg['agent.allowEnqueue']} onChange={(v) => set('agent.allowEnqueue', v)} />
        </div>
        <div className="cfg-row">
          <div>
            <div>Tasks an agent may file</div>
            <div className="hint">
              how many follow-up tasks ONE worker session can file through the agent API before it's
              refused and told to finish its turn
            </div>
          </div>
          <input
            className="field"
            style={{ width: 80 }}
            type="number"
            min={1}
            max={100}
            value={cfg['agent.taskCreationCap']}
            onChange={(e) => set('agent.taskCreationCap', Number(e.target.value))}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>Resume sessions on follow-up</div>
            <div className="hint">
              a follow-up reopens the agent's previous claude session (<span className="mono">--resume</span>)
              instead of starting a fresh agent that lost its context — the same habit as typing "proceed" in a
              terminal. OFF = every follow-up respawns from the task text plus the previous summary
            </div>
          </div>
          <Toggle on={cfg['agent.resumeSessions']} onChange={(v) => set('agent.resumeSessions', v)} />
        </div>
        <div className="cfg-row">
          <div>
            <div>Terminal keep-alive (minutes)</div>
            <div className="hint">
              how long a finished or exited terminal stays attachable before it's evicted. 0 = keep forever;
              terminals are still recycled oldest-first when all 10 session slots are busy. "Proceed" works even
              after eviction — it reopens the session from disk
            </div>
          </div>
          <input
            className="field"
            style={{ width: 80 }}
            type="number"
            min={0}
            max={10080}
            value={cfg['pty.sessionTtlMinutes']}
            onChange={(e) => set('pty.sessionTtlMinutes', Number(e.target.value))}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>Adversarial self-review</div>
            <div className="hint">
              review every worker's change before it lands in review — on the review model, falling back to
              Opus 5 xhigh when it's unavailable
            </div>
          </div>
          <Toggle on={cfg['review.enabled']} onChange={(v) => set('review.enabled', v)} />
        </div>
        <div className="cfg-row">
          <div>
            <div>Review→fix rounds</div>
            <div className="hint">
              feed blocker/major findings back to the worker to fix, up to N rounds, before the human review
              queue (0 = review only, no auto-fix)
            </div>
          </div>
          <input
            className="field"
            style={{ width: 80 }}
            type="number"
            min={0}
            max={5}
            value={cfg['review.maxRounds']}
            onChange={(e) => set('review.maxRounds', Number(e.target.value))}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>Feature plan re-analysis rounds</div>
            <div className="hint">
              a blocker verdict on a feature's plan feeds the findings back into a fresh analysis, up to N rounds
              (mirrors review→fix; 0 = review the plan once, never re-plan)
            </div>
          </div>
          <input
            className="field"
            style={{ width: 80 }}
            type="number"
            min={0}
            max={5}
            value={cfg['feature.analysisMaxRounds']}
            onChange={(e) => set('feature.analysisMaxRounds', Number(e.target.value))}
          />
        </div>
        <div className="cfg-row">
          <div>Review model</div>
          <select
            className="field mono"
            style={{ width: 220 }}
            value={cfg['review.model']}
            onChange={(e) => set('review.model', e.target.value)}
          >
            {(MODEL_OPTIONS.includes(cfg['review.model']) ? MODEL_OPTIONS : [cfg['review.model'], ...MODEL_OPTIONS]).map(
              (m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ),
            )}
          </select>
        </div>
        <div className="cfg-row">
          <div>
            <div>Permission mode</div>
            <div className="hint">
              auto is the everyday mode; acceptEdits only auto-approves file edits; prompts the agent can't
              answer surface as “needs attention”.
            </div>
            {cfg['agent.permissionMode'] === 'bypassPermissions' && (
              <div className="warn-text">
                bypassPermissions runs agents with --dangerously-skip-permissions — no prompts at all. First
                use shows a one-time acceptance dialog: open the terminal and accept it.
              </div>
            )}
          </div>
          <select
            className="field"
            style={{ width: 200 }}
            value={cfg['agent.permissionMode']}
            onChange={(e) => set('agent.permissionMode', e.target.value as AppSettings['agent.permissionMode'])}
          >
            <option value="auto">auto (recommended)</option>
            <option value="acceptEdits">acceptEdits (cautious)</option>
            <option value="bypassPermissions">bypassPermissions ⚠</option>
          </select>
        </div>
        <div className="cfg-row">
          <div>
            <div>Allowed tools</div>
            <div className="hint">
              extra pre-approved tools, one per line — e.g. <span className="mono">Bash(git *)</span>
            </div>
          </div>
          <textarea
            className="field mono"
            style={{ width: 260 }}
            rows={3}
            value={cfg['agent.allowedTools'].join('\n')}
            onChange={(e) =>
              set(
                'agent.allowedTools',
                e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
              )
            }
          />
        </div>
      </div>

      <div className="panel cfg-group">
        <h3>Model routing</h3>
        <div className="cfg-row">
          <div>
            <div>Route by usage</div>
            <div className="hint">
              primary model while session (5h) usage &lt; threshold, then fallback; tool/browser-testing
              tasks always use the fallback. Per-task model overrides win.
            </div>
          </div>
          <Toggle on={cfg['router.enabled']} onChange={(v) => set('router.enabled', v)} />
        </div>
        <div className="cfg-row">
          <div>Primary model</div>
          <select
            className="field mono"
            style={{ width: 220 }}
            value={cfg['router.primaryModel']}
            onChange={(e) => set('router.primaryModel', e.target.value)}
          >
            {(MODEL_OPTIONS.includes(cfg['router.primaryModel'])
              ? MODEL_OPTIONS
              : [cfg['router.primaryModel'], ...MODEL_OPTIONS]
            ).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="cfg-row">
          <div>Fallback model</div>
          <select
            className="field mono"
            style={{ width: 220 }}
            value={cfg['router.fallbackModel']}
            onChange={(e) => set('router.fallbackModel', e.target.value)}
          >
            {(MODEL_OPTIONS.includes(cfg['router.fallbackModel'])
              ? MODEL_OPTIONS
              : [cfg['router.fallbackModel'], ...MODEL_OPTIONS]
            ).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="cfg-row">
          <div>
            <div>Usage threshold %</div>
            <div className="hint">switch to fallback at this estimated usage</div>
          </div>
          <input
            className="field"
            style={{ width: 80 }}
            type="number"
            min={1}
            max={100}
            value={cfg['router.usageThresholdPct']}
            onChange={(e) => set('router.usageThresholdPct', Number(e.target.value))}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>5h token budget</div>
            <div className="hint">
              fallback only: when the account's own figure is unavailable, usage % is estimated from local
              transcripts against this budget
            </div>
          </div>
          <input
            className="field mono"
            style={{ width: 140 }}
            type="number"
            min={10000}
            step={100000}
            value={cfg['router.budget5hTokens']}
            onChange={(e) => set('router.budget5hTokens', Number(e.target.value))}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>Weekly token budget</div>
            <div className="hint">trailing-7d budget for the `wk` estimate fallback (reporting only)</div>
          </div>
          <input
            className="field mono"
            style={{ width: 140 }}
            type="number"
            min={10000}
            step={1000000}
            value={cfg['router.budgetWeekTokens']}
            onChange={(e) => set('router.budgetWeekTokens', Number(e.target.value))}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>Weekly fable budget</div>
            <div className="hint">same fallback, counting fable-family models only (their separate cap)</div>
          </div>
          <input
            className="field mono"
            style={{ width: 140 }}
            type="number"
            min={10000}
            step={1000000}
            value={cfg['router.budgetWeekFableTokens']}
            onChange={(e) => set('router.budgetWeekFableTokens', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="panel cfg-group">
        <h3>Board</h3>
        <div className="cfg-row">
          <div>
            <div>Group colours</div>
            <div className="hint">
              tint each task group (a task and everything split out of it) with its own colour on the board —
              off leaves the neutral grey blocks, grouping itself is unaffected
            </div>
          </div>
          {/* `?? true` so a server that predates this setting renders the real
              default and the key stays out of the save diff until touched */}
          <Toggle on={cfg['board.groupColors'] ?? true} onChange={(v) => set('board.groupColors', v)} />
        </div>
      </div>

      <div className="panel cfg-group">
        <h3>Terminal</h3>
        <div className="cfg-row">
          <div>
            <div>Click outside the terminal</div>
            <div className="hint">
              compact shrinks the open terminal to a footer bar (session stays attached — the chevron
              reopens it); close detaches the drawer; nothing leaves it open
            </div>
          </div>
          {/* `?? 'compact'` so a server that predates this setting renders the real
              default and the key stays out of the save diff until touched */}
          <select
            className="field"
            style={{ width: 200 }}
            value={cfg['terminal.clickOutside'] ?? 'compact'}
            onChange={(e) => set('terminal.clickOutside', e.target.value as AppSettings['terminal.clickOutside'])}
          >
            <option value="compact">compact (default)</option>
            <option value="close">close</option>
            <option value="nothing">nothing</option>
          </select>
        </div>
      </div>

      <div className="panel cfg-group">
        <h3>Storage</h3>
        <div className="cfg-row">
          <div>
            <div>Driver</div>
            <div className="hint">
              set in <span className="mono">server/data/config.json</span> — switch to postgres by pasting a
              connection string there (Supabase works as-is). Restart required.
            </div>
          </div>
          <span className="chip">file-configured</span>
        </div>
      </div>

      <div className="panel cfg-group">
        <h3>Sentry</h3>
        <div className="cfg-row">
          <div>
            <div>Org / Project</div>
            <div className="hint">sync pulls unresolved issues (14d) as tasks; re-sync never duplicates</div>
          </div>
          <span style={{ display: 'flex', gap: 8 }}>
            <input
              className="field mono"
              style={{ width: 126 }}
              placeholder="org"
              value={cfg['sentry.org']}
              onChange={(e) => set('sentry.org', e.target.value)}
            />
            <input
              className="field mono"
              style={{ width: 126 }}
              placeholder="project"
              value={cfg['sentry.project']}
              onChange={(e) => set('sentry.project', e.target.value)}
            />
          </span>
        </div>
        <div className="cfg-row">
          <div>Auth token</div>
          <input
            className="field mono"
            style={{ width: 260 }}
            type="password"
            value={cfg['sentry.authToken']}
            onChange={(e) => set('sentry.authToken', e.target.value)}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>API base</div>
            <div className="hint">EU-residency orgs use https://de.sentry.io</div>
          </div>
          <input
            className="field mono"
            style={{ width: 260 }}
            value={cfg['sentry.apiBase']}
            onChange={(e) => set('sentry.apiBase', e.target.value)}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>Category from tag</div>
            <div className="hint">Sentry tag key → task category (blank = use the issue level)</div>
          </div>
          <input
            className="field mono"
            style={{ width: 160 }}
            placeholder="environment"
            value={cfg['sentry.categoryTag']}
            onChange={(e) => set('sentry.categoryTag', e.target.value)}
          />
        </div>
        <div className="cfg-row">
          <div>
            <div>Assign to repo</div>
            <div className="hint">new sentry tasks land on this repo</div>
          </div>
          <select
            className="field"
            style={{ width: 260 }}
            value={cfg['sentry.repoId']}
            onChange={(e) => set('sentry.repoId', e.target.value)}
          >
            <option value="">— none —</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.role ? ` (${r.role})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            className="btn primary"
            disabled={syncing}
            onClick={async () => {
              setErr(null);
              setSyncMsg(null);
              setSyncing(true);
              try {
                await save();
                const r = await api.sentrySync();
                setSyncMsg(`fetched ${r.fetched} · created ${r.created} task(s) · ${r.skipped} already known`);
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? 'Syncing…' : 'Sync issues now'}
          </button>
          {syncMsg && <span className="muted mono">{syncMsg}</span>}
        </div>
      </div>
    </div>
  );
}
