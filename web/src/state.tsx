import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AuditEvent,
  Feature,
  OrchestratorStatus,
  Proposal,
  Repo,
  Run,
  RunActivity,
  ServerEvent,
  Task,
} from '@tm/shared';
import { api } from './api.ts';

interface AppState {
  repos: Repo[];
  tasks: Task[];
  runs: Run[];
  /** what each live run is doing right now, keyed by run id (live runs only) */
  activity: Record<string, RunActivity>;
  proposals: Proposal[];
  features: Feature[];
  /** live audit events received this session (cap 200, newest last) */
  auditEvents: AuditEvent[];
  orch: OrchestratorStatus;
  token: string | null;
  connected: boolean;
  bootedAt: string | null;
  refresh: () => Promise<void>;
  setOrch: (o: OrchestratorStatus) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activity, setActivity] = useState<Record<string, RunActivity>>({});
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [orch, setOrch] = useState<OrchestratorStatus>({ enabled: false, running: 0, concurrency: 2 });
  const [token, setToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [bootedAt, setBootedAt] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(async () => {
    const [r, t] = await Promise.all([api.listRepos(), api.listTasks()]);
    setRepos(r);
    setTasks(t);
    // These endpoints appear in later phases; tolerate their absence.
    api.listRuns().then(setRuns).catch(() => {});
    // Snapshot, not merge: the server's map IS the set of live runs, so a run
    // that finished while we were away disappears instead of lingering.
    api
      .runActivity()
      .then((list) => setActivity(Object.fromEntries(list.map((a) => [a.runId, a]))))
      .catch(() => {});
    api.listProposals().then(setProposals).catch(() => {});
    api.listFeatures().then(setFeatures).catch(() => {});
    api.orchestrator().then(setOrch).catch(() => {});
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
    api.session().then((s) => setToken(s.token)).catch(() => {});
    api.health().then((h) => setBootedAt(h.bootedAt)).catch(() => {});
  }, [refresh]);

  // Live updates over /ws/events with quiet retry. Waits for the session
  // token — the events socket is token-gated like the terminal.
  useEffect(() => {
    if (!token) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/events?token=${token}`);
      wsRef.current = ws;
      // Refetch on (re)connect: events between page load / reconnect gaps and
      // now were missed (review M1).
      ws.onopen = () => {
        setConnected(true);
        refresh().catch(() => {});
        api.health().then((h) => setBootedAt(h.bootedAt)).catch(() => {});
      };
      ws.onmessage = (ev) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        // const so narrowing survives into the setState closures below
        const e = parsed as ServerEvent;
        switch (e.type) {
          case 'task.updated':
            setTasks((cur) => {
              const i = cur.findIndex((t) => t.id === e.task.id);
              if (i === -1) return [...cur, e.task];
              const next = cur.slice();
              next[i] = e.task;
              return next;
            });
            break;
          case 'task.deleted':
            setTasks((cur) => cur.filter((t) => t.id !== e.taskId));
            break;
          case 'run.started':
          case 'run.updated':
          case 'run.exited':
          case 'run.needs-attention':
            setRuns((cur) => {
              const i = cur.findIndex((r) => r.id === e.run.id);
              if (i === -1) return [e.run, ...cur];
              const next = cur.slice();
              next[i] = e.run;
              return next;
            });
            break;
          case 'run.activity':
            setActivity((cur) => {
              // text:null is the server saying "this run is no longer live"
              if (e.activity.text === null) {
                if (!(e.activity.runId in cur)) return cur;
                const next = { ...cur };
                delete next[e.activity.runId];
                return next;
              }
              return { ...cur, [e.activity.runId]: e.activity };
            });
            break;
          case 'proposal.created':
            setProposals((cur) => {
              const i = cur.findIndex((p) => p.id === e.proposal.id);
              if (i === -1) return [e.proposal, ...cur];
              const next = cur.slice();
              next[i] = e.proposal;
              return next;
            });
            break;
          case 'feature.updated':
            setFeatures((cur) => {
              const i = cur.findIndex((f) => f.id === e.feature.id);
              if (i === -1) return [e.feature, ...cur];
              const next = cur.slice();
              next[i] = e.feature;
              return next;
            });
            break;
          case 'feature.deleted':
            setFeatures((cur) => cur.filter((f) => f.id !== e.featureId));
            break;
          case 'event.appended':
            setAuditEvents((cur) => [...cur.slice(-199), e.event]);
            break;
          case 'orchestrator.status':
            setOrch(e.status);
            break;
        }
      };
      ws.onclose = () => {
        setConnected(false);
        // Only null the ref if it still points at THIS socket — a StrictMode
        // remount may have already connected a newer one (review R1).
        if (wsRef.current === ws) wsRef.current = null;
        if (!closed) {
          timer = setTimeout(async () => {
            // A server restart rotates the per-boot token: refetch before
            // retrying or we'd loop on 4403 forever (review M1).
            try {
              const s = await api.session();
              if (s.token !== token) {
                setToken(s.token); // effect re-runs and reconnects with the new token
                return;
              }
            } catch {
              // server still down — fall through and retry with the old token
            }
            connect();
          }, 2500);
        }
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [token]);

  return (
    <Ctx.Provider
      value={{ repos, tasks, runs, activity, proposals, features, auditEvents, orch, token, connected, bootedAt, refresh, setOrch }}
    >
      {children}
    </Ctx.Provider>
  );
}
