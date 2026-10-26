import type {
  BackgroundShell,
  BackgroundShellKillResult,
  BackgroundShellOutput,
  Anomaly,
  AppSettings,
  AuditEvent,
  BulkRequest,
  BulkResponse,
  Chat,
  ChatMessage,
  ChatMode,
  CommandRun,
  Dispatch,
  Question,
  Feature,
  FeaturePlan,
  HostStatus,
  OrchestratorStatus,
  Proposal,
  Repo,
  RepoCommand,
  Report,
  SpaceFile,
  Space,
  SharedNoteKind,
  SharedNote,
  ReportLanguage,
  ReportRangePreset,
  RepoScripts,
  Run,
  RunActivity,
  ShellSession,
  StatsOverview,
  Task,
  UsageSnapshot,
  TaskMovePlace,
} from '@tm/shared';

// Only user-editable fields — status/error/resultSummary are machine-owned and
// the server rejects them with a 400 (.strict() schemas).
// groupName/groupColor are accepted on a group's ROOT task only (the server
// answers 400 otherwise) — see docs/grouping.md.
export type TaskWrite = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'repoId'
    | 'parentId'
    | 'priority'
    | 'source'
    | 'sourceRef'
    | 'model'
    | 'effort'
    | 'category'
    | 'review'
    | 'reviewModel'
    | 'reviewEffort'
    | 'landing'
    | 'acceptance'
    | 'checks'
    | 'kind'
    | 'loopGoal'
    | 'loopMaxIterations'
    | 'loopBudgetUsd'
    | 'groupName'
    | 'groupColor'
  >
>;

/**
 * A server that predates the task-group or auto-publish migration sends tasks
 * without those columns; read such a task as its own single-task group with
 * auto-publish off, so a rebuilt SPA still renders against a server that has
 * not restarted yet.
 */
export function normalizeTask(t: Task): Task {
  if (
    t.groupId &&
    t.groupPath &&
    t.landing !== undefined &&
    t.customQueueAt !== undefined &&
    typeof t.sortOrder === 'number' &&
    Array.isArray(t.reviewRounds) &&
    Array.isArray(t.checkResults) &&
    Array.isArray(t.loopHistory)
  )
    return t;
  return {
    ...t,
    landing: t.landing ?? null,
    autoLandedAt: t.autoLandedAt ?? null,
    customQueueAt: t.customQueueAt ?? null,
    hiddenAt: t.hiddenAt ?? null,
    reviewState: t.reviewState ?? null,
    reviewModel: t.reviewModel ?? null,
    reviewEffort: t.reviewEffort ?? null,
    reviewRounds: Array.isArray(t.reviewRounds) ? t.reviewRounds : [],
    acceptance: t.acceptance ?? null,
    checks: t.checks ?? null,
    checkState: t.checkState ?? null,
    checkResults: Array.isArray(t.checkResults) ? t.checkResults : [],
    checkDiffHash: t.checkDiffHash ?? null,
    attempts: typeof t.attempts === 'number' ? t.attempts : 0,
    kind: t.kind ?? 'task',
    loopGoal: t.loopGoal ?? null,
    loopMaxIterations: t.loopMaxIterations ?? null,
    loopBudgetUsd: t.loopBudgetUsd ?? null,
    loopIteration: typeof t.loopIteration === 'number' ? t.loopIteration : 0,
    loopState: t.loopState ?? null,
    loopHistory: Array.isArray(t.loopHistory) ? t.loopHistory : [],
    groupId: t.groupId ?? t.id,
    groupPath: t.groupPath ?? '/',
    groupName: t.groupName ?? null,
    groupColor: t.groupColor ?? null,
    sortOrder: typeof t.sortOrder === 'number' ? t.sortOrder : 0,
  };
}

/**
 * What a failure without a server reason should say. A bare "502", or Safari's
 * "Load failed" for a request that never got an answer, told the user nothing
 * (docs/mobile.md § Action errors); the server's own `error` text always wins
 * over these.
 */
function statusText(res: Response): string {
  if (res.status === 502 || res.status === 503 || res.status === 504)
    return `can't reach the task-manager server (${res.status})`;
  return res.statusText ? `${res.status} ${res.statusText}` : `request failed (${res.status})`;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // fetch rejects only when no response arrived at all ("Load failed",
    // "Failed to fetch", "NetworkError when…"): the server or the network is gone.
    // An abort is the caller's own doing and keeps its identity.
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error("can't reach the task-manager server — check that it is running");
  }
  if (!res.ok) {
    let msg = statusText(res);
    try {
      const j = await res.json();
      if (typeof j?.error === 'string' && j.error) msg = j.error;
    } catch {
      /* keep the status text */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  session: () => req<{ token: string }>('GET', '/api/session'),
  health: () => req<{ ok: boolean; driver: string; bootedAt: string; supervised?: boolean }>('GET', '/api/health'),
  // Refused with 409 while agents are working; `force` is the explicit override.
  restartServer: (force = false) => req<{ ok: true; restarting: true }>('POST', '/api/server/restart', { force }),

  // The front door (docs/host.md). These do NOT go through /api: they are
  // answered by the process that supervises the API, which is the whole point —
  // it is still there when /api is not. `npm run dev:web` on its own has no
  // front door behind it, so every one of these can legitimately fail; the
  // caller treats that as "no host" rather than as an error.
  hostStatus: () => req<HostStatus>('GET', '/host/status'),
  hostStart: () => req<HostStatus & { ok: boolean; already?: boolean; error?: string }>('POST', '/host/start', {}),
  hostStop: (force = false) => req<HostStatus & { ok: boolean }>('POST', '/host/stop', { force }),
  hostRestart: (force = false) => req<HostStatus & { ok: boolean }>('POST', '/host/restart', { force }),

  listRepos: () => req<Repo[]>('GET', '/api/repos'),
  createRepo: (b: { name?: string; path: string; role?: string | null; previewUrl?: string | null }) =>
    req<Repo>('POST', '/api/repos', b),
  updateRepo: (id: string, b: Partial<Pick<Repo, 'name' | 'path' | 'role' | 'previewUrl' | 'landing'>>) =>
    req<Repo>('PATCH', `/api/repos/${id}`, b),
  deleteRepo: (id: string) => req<{ ok: true }>('DELETE', `/api/repos/${id}`),
  gitStatus: (id: string) => req<{ isRepo: boolean; branch: string | null; dirty: number; ahead: number }>('GET', `/api/repos/${id}/git`),
  gitCommit: (id: string) => req<{ ok: true; message: string; summary: string }>('POST', `/api/repos/${id}/commit`),
  gitPush: (id: string) => req<{ ok: true; output: string }>('POST', `/api/repos/${id}/push`),

  // Reports (docs/reports.md). Create answers 202 with a `pending` row — the
  // document itself arrives over /ws/events, because the claude pass that
  // writes it outlives any HTTP timeout.
  listReports: () => req<Report[]>('GET', '/api/reports'),
  createReport: (b: {
    repoIds: string[];
    preset: ReportRangePreset;
    language: ReportLanguage;
    from?: string;
    to?: string;
    title?: string;
    model?: string;
  }) => req<Report>('POST', '/api/reports', b),
  regenerateReport: (id: string) => req<Report>('POST', `/api/reports/${id}/regenerate`),
  deleteReport: (id: string) => req<{ ok: boolean }>('DELETE', `/api/reports/${id}`),
  // Shared spaces (docs/shared-spaces.md)
  listSpaces: () => req<Space[]>('GET', '/api/spaces'),
  createSpace: (b: { name: string; path: string; repoIds: string[] }) =>
    req<{ space: Space; imported: number; importError?: string }>('POST', '/api/spaces', b),
  updateSpace: (id: string, b: { name?: string; path?: string; repoIds?: string[] }) =>
    req<Space>('PATCH', `/api/spaces/${id}`, b),
  deleteSpace: (id: string) => req<{ ok: boolean }>('DELETE', `/api/spaces/${id}`),
  importSpaceSeed: (id: string) =>
    req<{ imported: number; skipped: number; error?: string }>('POST', `/api/spaces/${id}/import`),
  listSharedNotes: () => req<SharedNote[]>('GET', '/api/shared-notes'),
  createSharedNote: (
    spaceId: string,
    b: { kind: SharedNoteKind; title: string; body: string; toRepoId: string | null; fromRepoId: string | null; files?: string[] },
  ) => req<SharedNote>('POST', `/api/spaces/${spaceId}/notes`, b),
  updateSharedNote: (
    id: string,
    b: { title?: string; body?: string; toRepoId?: string | null; status?: 'open' | 'done' | 'dismissed'; resolution?: string | null },
  ) => req<SharedNote>('PATCH', `/api/shared-notes/${id}`, b),
  deleteSharedNote: (id: string) => req<{ ok: boolean }>('DELETE', `/api/shared-notes/${id}`),
  fileSharedNote: (id: string, placement: 'queue' | 'draft') =>
    req<{ note: SharedNote; task: Task; placement: 'queue' | 'draft'; placementNote: string | null }>(
      'POST',
      `/api/shared-notes/${id}/file`,
      { placement },
    ),
  spaceFiles: (id: string) => req<{ files: SpaceFile[]; truncated: boolean }>('GET', `/api/spaces/${id}/files`),
  spaceFileText: async (id: string, path: string): Promise<string> => {
    const res = await fetch(`/api/spaces/${id}/file?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* keep status */
      }
      throw new Error(msg);
    }
    return res.text();
  },
  listCommands: () => req<RepoCommand[]>('GET', '/api/commands'),
  createCommand: (b: {
    repoId: string;
    name: string;
    command: string;
    kind?: RepoCommand['kind'];
    cwd?: string | null;
    isCheck?: boolean;
    timeoutSec?: number | null;
  }) =>
    req<RepoCommand>('POST', '/api/commands', b),
  updateCommand: (id: string, b: Partial<Pick<RepoCommand, 'name' | 'command' | 'kind' | 'cwd' | 'sortOrder' | 'isCheck' | 'timeoutSec'>>) =>
    req<RepoCommand>('PATCH', `/api/commands/${id}`, b),
  deleteCommand: (id: string) => req<{ ok: true }>('DELETE', `/api/commands/${id}`),
  repoScripts: (repoId: string) => req<RepoScripts>('GET', `/api/repos/${repoId}/scripts`),
  runCommand: (id: string) => req<CommandRun>('POST', `/api/commands/${id}/run`),
  listCommandRuns: () => req<CommandRun[]>('GET', '/api/command-runs'),
  stopCommandRun: (runId: string) => req<{ ok: true }>('POST', `/api/command-runs/${runId}/stop`),
  clearCommandRuns: () => req<{ ok: true; cleared: number }>('POST', '/api/command-runs/clear'),
  listShells: () => req<ShellSession[]>('GET', '/api/shells'),
  openShells: (repoId: string, count = 1) => req<ShellSession[]>('POST', '/api/shells', { repoId, count }),
  closeShell: (id: string) => req<{ ok: true }>('DELETE', `/api/shells/${id}`),
  listBackgroundShells: () => req<BackgroundShell[]>('GET', '/api/background-shells'),
  backgroundShellOutput: (runId: string, shellId: string, from?: number) =>
    req<BackgroundShellOutput>(
      'GET',
      `/api/background-shells/${encodeURIComponent(runId)}/${encodeURIComponent(shellId)}/output${from === undefined ? '' : `?from=${from}`}`,
    ),
  killBackgroundShell: (runId: string, shellId: string) =>
    req<BackgroundShellKillResult>('POST', `/api/background-shells/${encodeURIComponent(runId)}/${encodeURIComponent(shellId)}/kill`),
  killAllBackgroundShells: (taskId?: string) =>
    req<BackgroundShellKillResult>('POST', '/api/background-shells/kill-all', taskId ? { taskId } : {}),

  listTasks: () => req<Task[]>('GET', '/api/tasks').then((l) => l.map(normalizeTask)),
  createTask: (b: TaskWrite & { title: string }) =>
    req<Task>('POST', '/api/tasks', b).then(normalizeTask),
  updateTask: (id: string, b: TaskWrite) =>
    req<Task>('PATCH', `/api/tasks/${id}`, b).then(normalizeTask),
  deleteTask: (id: string) => req<{ ok: true }>('DELETE', `/api/tasks/${id}`),
  /** Board multi-select (docs/inbox.md § Bulk actions): per-id results, refusals included */
  bulkTasks: (b: BulkRequest) =>
    req<BulkResponse>('POST', '/api/tasks/bulk', b).then((r) => ({
      ...r,
      results: r.results.map((x) => (x.ok ? { ...x, task: normalizeTask(x.task) } : x)),
    })),
  /** One board drop / picker choice (docs/grouping.md § Drag and drop) */
  moveTask: (id: string, b: { place: TaskMovePlace; targetId?: string | null }) =>
    req<Task>('POST', `/api/tasks/${id}/move`, b).then(normalizeTask),
  taskAction: (
    id: string,
    action:
      | 'enqueue'
      | 'run-now'
      | 'cancel'
      | 'undo'
      | 'stop-waiting'
      | 'release'
      | 'retry'
      | 'unblock'
      | 'complete'
      | 'publish'
      | 'queue'
      | 'unqueue'
      | 'hide'
      | 'unhide',
  ) => req<Task>('POST', `/api/tasks/${id}/${action}`),
  stopAgent: (id: string) => req<{ ok: true; closed: number }>('POST', `/api/tasks/${id}/stop-agent`),
  followUp: (id: string, message: string) => req<Task>('POST', `/api/tasks/${id}/follow-up`, { message }),
  applyReview: (id: string) => req<Task>('POST', `/api/tasks/${id}/apply-review`),
  /** A loop task that stopped short goes on (docs/loops.md) */
  continueLoop: (id: string) => req<Task>('POST', `/api/tasks/${id}/loop/continue`).then(normalizeTask),
  /** The loop's ledger ($TM_ARTIFACTS_DIR/progress.md); 404 until an iteration writes it */
  loopLedger: (id: string) => req<{ text: string; mtime: string }>('GET', `/api/tasks/${id}/loop/ledger`),
  /** "Review now": run the adversarial reviewer on demand (409 while a round is in flight) */
  reviewNow: (id: string) => req<Task>('POST', `/api/tasks/${id}/review`),
  proceed: (id: string, message?: string) =>
    req<Task>('POST', `/api/tasks/${id}/proceed`, { message: message ?? null }),
  resumable: (id: string) =>
    req<{ resumable: boolean; sessionId: string | null }>('GET', `/api/tasks/${id}/resumable`),
  taskFiles: (id: string) => req<{ name: string; size: number; mtime: string }[]>('GET', `/api/tasks/${id}/files`),
  uploadTaskFiles: async (id: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    const res = await fetch(`/api/tasks/${id}/files`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status}`);
    return res.json() as Promise<{ ok: true; saved: string[] }>;
  },
  deleteTaskFile: (id: string, name: string) =>
    req<{ ok: true }>('DELETE', `/api/tasks/${id}/files/${encodeURIComponent(name)}`),

  listDispatches: (taskId?: string) =>
    req<Dispatch[]>('GET', `/api/dispatches${taskId ? `?taskId=${taskId}` : ''}`),
  cancelDispatch: (id: string) => req<Dispatch>('POST', `/api/dispatches/${id}/cancel`),
  // questions a worker handed to the human (docs/questions.md)
  listQuestions: (status: 'pending' | 'answered' | 'expired' = 'pending') =>
    req<Question[]>('GET', `/api/questions?status=${status}`),
  answerQuestion: (id: string, answers: Record<string, string>) =>
    req<Question>('POST', `/api/questions/${id}/answer`, { answers }),

  listRuns: () => req<Run[]>('GET', '/api/runs'),
  runActivity: () => req<RunActivity[]>('GET', '/api/runs/activity'),
  killRun: (id: string) => req<Run>('POST', `/api/runs/${id}/kill`),

  analyze: (b: { repoId: string; taskIds?: string[] }) => req<{ runId: string }>('POST', '/api/analyze', b),
  listProposals: (status?: string) =>
    req<Proposal[]>('GET', `/api/proposals${status ? `?status=${status}` : ''}`),
  acceptProposal: (id: string, chosenOptionIndex?: number) =>
    req<{ proposal: Proposal; tasks: Task[] }>('POST', `/api/proposals/${id}/accept`, { chosenOptionIndex }),
  rejectProposal: (id: string) => req<Proposal>('POST', `/api/proposals/${id}/reject`),

  listFeatures: () => req<Feature[]>('GET', '/api/features'),
  getFeature: (id: string) => req<{ feature: Feature; tasks: Task[] }>('GET', `/api/features/${id}`),
  createFeature: (b: { repoId: string; title: string; request: string }) => req<Feature>('POST', '/api/features', b),
  updateFeature: (id: string, b: { title?: string; request?: string }) =>
    req<Feature>('PATCH', `/api/features/${id}`, b),
  updateFeaturePlan: (id: string, analysis: FeaturePlan) =>
    req<Feature>('PATCH', `/api/features/${id}/plan`, { analysis }),
  deleteFeature: (id: string) => req<{ ok: true }>('DELETE', `/api/features/${id}`),
  analyzeFeature: (id: string, note?: string) =>
    req<{ runId: string; feature: Feature }>('POST', `/api/features/${id}/analyze`, { note: note || null }),
  approveFeature: (id: string) =>
    req<{ feature: Feature; tasks: Task[] }>('POST', `/api/features/${id}/approve`),
  featureAction: (id: string, action: 'start' | 'pause' | 'resume' | 'cancel' | 'complete') =>
    req<unknown>('POST', `/api/features/${id}/${action}`),

  // Chat (docs/chat.md). `sendChatMessage` answers 202 on ACCEPTANCE — the
  // reply itself arrives over /ws/events as a `chat.message`, because a turn
  // outlives any reasonable HTTP timeout.
  listChats: (repoId?: string) => req<Chat[]>('GET', `/api/chats${repoId ? `?repoId=${repoId}` : ''}`),
  getChat: (id: string) => req<{ chat: Chat; messages: ChatMessage[] }>('GET', `/api/chats/${id}`),
  createChat: (b: { repoId: string; title?: string; model?: string; effort?: string | null; mode?: ChatMode }) =>
    req<Chat>('POST', '/api/chats', b),
  updateChat: (id: string, b: { title?: string; model?: string; effort?: string | null; mode?: ChatMode }) =>
    req<Chat>('PATCH', `/api/chats/${id}`, b),
  deleteChat: (id: string) => req<{ ok: true }>('DELETE', `/api/chats/${id}`),
  sendChatMessage: (id: string, text: string) =>
    req<{ accepted: true; message: ChatMessage }>('POST', `/api/chats/${id}/messages`, { text }),
  stopChat: (id: string) => req<{ stopped: boolean }>('POST', `/api/chats/${id}/stop`),

  getConfig: () => req<AppSettings>('GET', '/api/config'),
  putConfig: (b: Partial<AppSettings>) => req<AppSettings>('PUT', '/api/config', b),

  orchestrator: () => req<OrchestratorStatus>('GET', '/api/orchestrator'),
  usage: () => req<UsageSnapshot>('GET', '/api/usage'),
  sentrySync: () => req<{ created: number; skipped: number; fetched: number }>('POST', '/api/sentry/sync'),
  statsOverview: (days: number) => req<StatsOverview>('GET', `/api/stats/overview?days=${days}`),
  anomalies: () => req<Anomaly[]>('GET', '/api/stats/anomalies'),
  events: (limit = 50) => req<AuditEvent[]>('GET', `/api/events?limit=${limit}`),
  orchestratorAction: (a: 'start' | 'stop' | 'stop-and-kill') =>
    req<{ enabled: boolean }>('POST', `/api/orchestrator/${a}`),
};
