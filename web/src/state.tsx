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
  AppSettings,
  AuditEvent,
  Chat,
  ChatMessage,
  CommandRun,
  ShellSession,
  Dispatch,
  Question,
  Feature,
  HostStatus,
  OrchestratorStatus,
  Proposal,
  Repo,
  Report,
  RepoCommand,
  Run,
  RunActivity,
  ServerEvent,
  SharedNote,
  Space,
  Task,
} from '@tm/shared';
import { api, normalizeTask } from './api.ts';

interface AppState {
  repos: Repo[];
  tasks: Task[];
  runs: Run[];
  /** what each live run is doing right now, keyed by run id (live runs only) */
  activity: Record<string, RunActivity>;
  proposals: Proposal[];
  /** agent-to-agent messages between related tasks (docs/dispatch.md) */
  dispatches: Dispatch[];
  /** decisions worker agents are waiting on — pending only (docs/questions.md) */
  questions: Question[];
  /** bumped by the header chip: the modal drops what was dismissed and reopens */
  questionNudge: number;
  nudgeQuestions: () => void;
  features: Feature[];
  /** free-form conversations with claude (docs/chat.md) */
  chats: Chat[];
  /**
   * Transcripts, keyed by chat id — filled by `loadChat` and kept current by
   * `chat.message` frames. Held HERE rather than in the page so a reply that
   * lands while you are looking at another chat is already there when you
   * come back, which is the whole point of the conversation being persistent.
   * Only chats that have been opened are present; an absent key means "not
   * loaded", which is why the page calls `loadChat` on mount.
   */
  chatMessages: Record<string, ChatMessage[]>;
  loadChat: (id: string) => Promise<void>;
  /** generated work-summary documents, newest first (docs/reports.md) */
  reports: Report[];
  /** shared spaces and their request/note ledger (docs/shared-spaces.md) */
  spaces: Space[];
  sharedNotes: SharedNote[];
  /** saved per-repo command definitions (docs/commands.md) */
  commands: RepoCommand[];
  /** command executions this server knows about — running ones first-class,
   *  finished ones kept briefly for the launcher's history */
  commandRuns: CommandRun[];
  /** open plain shells, every repo (docs/terminals.md) */
  shells: ShellSession[];
  /** live audit events received this session (cap 200, newest last) */
  auditEvents: AuditEvent[];
  orch: OrchestratorStatus;
  /** runtime settings the UI reacts to (board.groupColors…); null until loaded */
  settings: AppSettings | null;
  token: string | null;
  connected: boolean;
  bootedAt: string | null;
  /**
   * The front door's view of the API (docs/host.md), or null when the page is
   * not being served through one (`npm run dev:web` alone, or an old install).
   * This is the only status that survives the API being down, because the
   * process that answers it is not the API.
   */
  host: HostStatus | null;
  refresh: () => Promise<void>;
  refreshHost: () => Promise<void>;
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
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionNudge, setQuestionNudge] = useState(0);
  const nudgeQuestions = useCallback(() => setQuestionNudge((n) => n + 1), []);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatMessages, setChatMessages] = useState<Record<string, ChatMessage[]>>({});
  const [reports, setReports] = useState<Report[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [sharedNotes, setSharedNotes] = useState<SharedNote[]>([]);
  const [commands, setCommands] = useState<RepoCommand[]>([]);
  const [commandRuns, setCommandRuns] = useState<CommandRun[]>([]);
  const [shells, setShells] = useState<ShellSession[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [orch, setOrch] = useState<OrchestratorStatus>({ enabled: false, running: 0, concurrency: 2, aux: 0 });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [bootedAt, setBootedAt] = useState<string | null>(null);
  const [host, setHost] = useState<HostStatus | null>(null);
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
    api.listDispatches().then(setDispatches).catch(() => {});
    api.listQuestions().then(setQuestions).catch(() => {});
    api.listFeatures().then(setFeatures).catch(() => {});
    api.listChats().then(setChats).catch(() => {});
    api.listReports().then(setReports).catch(() => {});
    api.listSpaces().then(setSpaces).catch(() => {});
    api.listSharedNotes().then(setSharedNotes).catch(() => {});
    api.listCommands().then(setCommands).catch(() => {});
    api.listCommandRuns().then(setCommandRuns).catch(() => {});
    api.listShells().then(setShells).catch(() => {});
    api.orchestrator().then(setOrch).catch(() => {});
    api.getConfig().then(setSettings).catch(() => {});
  }, []);

  /**
   * Bootstrap, with retry. The events socket is gated on the token, so a page
   * that loaded while the API was down used to sit there forever: the one-shot
   * fetch failed, no socket was ever opened, and nothing re-polled — only a
   * reload recovered. Now that the page outlives the server it is served
   * beside (docs/host.md), "load first, server later" is an ordinary sequence.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      if (cancelled) return;
      let s: { token: string };
      try {
        s = await api.session();
      } catch {
        timer = setTimeout(attempt, 2500);
        return;
      }
      if (cancelled) return;
      setToken(s.token); // the socket effect below picks it up
      refresh().catch(() => {});
      api.health().then((h) => setBootedAt(h.bootedAt)).catch(() => {});
    };
    void attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  /**
   * Fetch one chat's transcript. Also refreshes the chat row, because the two
   * come from the same endpoint and a page that opened a chat mid-turn needs
   * its `thinking` status without waiting for the next broadcast.
   */
  const loadChat = useCallback(async (id: string) => {
    // Seeded BEFORE the fetch, and that is the whole trick: the `chat.message`
    // handler only appends to a key that exists, so without this a reply that
    // landed while this request was in flight would be dropped by the handler
    // AND missing from the response, and would not appear until the next load.
    setChatMessages((cur) => (id in cur ? cur : { ...cur, [id]: [] }));
    const { chat, messages } = await api.getChat(id);
    setChats((cur) => {
      const i = cur.findIndex((c) => c.id === chat.id);
      if (i === -1) return [chat, ...cur];
      const next = cur.slice();
      next[i] = chat;
      return next;
    });
    setChatMessages((cur) => {
      const seen = new Set(messages.map((m) => m.id));
      const extra = (cur[id] ?? []).filter((m) => !seen.has(m.id));
      // Message ids are the time-sortable eventId(), so id order IS send
      // order — no timestamp tiebreak needed to splice the two lists.
      const merged = extra.length ? [...messages, ...extra].sort((a, b) => (a.id < b.id ? -1 : 1)) : messages;
      return { ...cur, [id]: merged };
    });
  }, []);

  const refreshHost = useCallback(async () => {
    try {
      setHost(await api.hostStatus());
    } catch {
      setHost(null); // no front door in front of this page — hide its controls
    }
  }, []);

  // Polled only while we are out of touch: with the socket up, the header has
  // nothing to ask the front door that the API is not already telling it.
  useEffect(() => {
    void refreshHost();
    if (connected) return;
    const t = setInterval(() => void refreshHost(), 3000);
    return () => clearInterval(t);
  }, [connected, refreshHost]);

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
              const task = normalizeTask(e.task);
              const i = cur.findIndex((t) => t.id === task.id);
              if (i === -1) return [...cur, task];
              const next = cur.slice();
              next[i] = task;
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
          case 'chat.updated':
            setChats((cur) => {
              const i = cur.findIndex((c) => c.id === e.chat.id);
              if (i === -1) return [e.chat, ...cur];
              const next = cur.slice();
              next[i] = e.chat;
              return next;
            });
            break;
          case 'chat.deleted':
            setChats((cur) => cur.filter((c) => c.id !== e.chatId));
            setChatMessages((cur) => {
              if (!(e.chatId in cur)) return cur;
              const next = { ...cur };
              delete next[e.chatId];
              return next;
            });
            break;
          case 'chat.message':
            setChatMessages((cur) => {
              const list = cur[e.message.chatId];
              // Not loaded = not being looked at; `loadChat` will fetch the
              // whole transcript including this one. Appending to an absent
              // key would build a one-message "transcript" the page then
              // renders as if it were complete.
              if (!list) return cur;
              // The sender already has its own message from the POST's 202;
              // the broadcast is the same row coming back.
              if (list.some((m) => m.id === e.message.id)) return cur;
              return { ...cur, [e.message.chatId]: [...list, e.message] };
            });
            break;
          case 'question.updated':
            // The slice is the PENDING set: an answered or expired question
            // leaves it, so the modal and the chips read the slice directly.
            setQuestions((cur) => {
              const rest = cur.filter((q) => q.id !== e.question.id);
              return e.question.status === 'pending' ? [e.question, ...rest] : rest;
            });
            break;
          case 'report.updated':
            // Newest first, matching the server's ORDER BY: a re-run keeps its
            // place in the list rather than jumping to the top.
            setReports((cur) => {
              const i = cur.findIndex((r) => r.id === e.report.id);
              if (i === -1) return [e.report, ...cur];
              const next = [...cur];
              next[i] = e.report;
              return next;
            });
            break;
          case 'report.deleted':
            setReports((cur) => cur.filter((r) => r.id !== e.reportId));
            break;
          case 'space.updated':
            setSpaces((cur) => {
              const i = cur.findIndex((x) => x.id === e.space.id);
              if (i === -1) return [...cur, e.space];
              const next = [...cur];
              next[i] = e.space;
              return next;
            });
            break;
          case 'space.deleted':
            setSpaces((cur) => cur.filter((x) => x.id !== e.spaceId));
            setSharedNotes((cur) => cur.filter((n) => n.spaceId !== e.spaceId));
            break;
          case 'shared-note.updated':
            setSharedNotes((cur) => {
              const i = cur.findIndex((n) => n.id === e.note.id);
              if (i === -1) return [e.note, ...cur];
              const next = [...cur];
              next[i] = e.note;
              return next;
            });
            break;
          case 'shared-note.deleted':
            setSharedNotes((cur) => cur.filter((n) => n.id !== e.noteId));
            break;
          case 'dispatch.updated':
            setDispatches((cur) => {
              const i = cur.findIndex((d) => d.id === e.dispatch.id);
              if (i === -1) return [e.dispatch, ...cur];
              const next = cur.slice();
              next[i] = e.dispatch;
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
          case 'command.updated':
            setCommands((cur) => {
              const i = cur.findIndex((c) => c.id === e.command.id);
              if (i === -1) return [...cur, e.command];
              const next = cur.slice();
              next[i] = e.command;
              return next;
            });
            break;
          case 'command.deleted':
            setCommands((cur) => cur.filter((c) => c.id !== e.commandId));
            break;
          case 'command.run':
            setCommandRuns((cur) => {
              const i = cur.findIndex((r) => r.id === e.run.id);
              if (i === -1) return [e.run, ...cur];
              const next = cur.slice();
              next[i] = e.run;
              return next;
            });
            break;
          case 'shell.session':
            setShells((cur) => {
              const i = cur.findIndex((s) => s.id === e.session.id);
              if (i === -1) return [...cur, e.session];
              const next = cur.slice();
              next[i] = e.session;
              return next;
            });
            break;
          case 'shell.closed':
            setShells((cur) => cur.filter((s) => s.id !== e.id));
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
      value={{
        repos,
        tasks,
        runs,
        activity,
        proposals,
        dispatches,
        questions,
        questionNudge,
        nudgeQuestions,
        features,
        chats,
        chatMessages,
        loadChat,
        reports,
        spaces,
        sharedNotes,
        commands,
        commandRuns,
        shells,
        auditEvents,
        orch,
        settings,
        token,
        connected,
        bootedAt,
        host,
        refresh,
        refreshHost,
        setOrch,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
