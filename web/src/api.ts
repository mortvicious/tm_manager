import type {
  Anomaly,
  AppSettings,
  AuditEvent,
  CommandRun,
  Dispatch,
  Feature,
  FeaturePlan,
  HostStatus,
  OrchestratorStatus,
  Proposal,
  Repo,
  RepoCommand,
  RepoScripts,
  Run,
  RunActivity,
  StatsOverview,
  Task,
  UsageSnapshot,
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
    | 'autoPublish'
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
  if (t.groupId && t.groupPath && t.autoPublish !== undefined && t.customQueueAt !== undefined) return t;
  return {
    ...t,
    autoPublish: t.autoPublish ?? false,
    customQueueAt: t.customQueueAt ?? null,
    groupId: t.groupId ?? t.id,
    groupPath: t.groupPath ?? '/',
    groupName: t.groupName ?? null,
    groupColor: t.groupColor ?? null,
  };
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.error ?? msg;
    } catch {
      /* keep status text */
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
  updateRepo: (id: string, b: Partial<Pick<Repo, 'name' | 'path' | 'role' | 'previewUrl'>>) =>
    req<Repo>('PATCH', `/api/repos/${id}`, b),
  deleteRepo: (id: string) => req<{ ok: true }>('DELETE', `/api/repos/${id}`),
  gitStatus: (id: string) => req<{ isRepo: boolean; branch: string | null; dirty: number; ahead: number }>('GET', `/api/repos/${id}/git`),
  gitCommit: (id: string) => req<{ ok: true; message: string; summary: string }>('POST', `/api/repos/${id}/commit`),
  gitPush: (id: string) => req<{ ok: true; output: string }>('POST', `/api/repos/${id}/push`),

  listCommands: () => req<RepoCommand[]>('GET', '/api/commands'),
  createCommand: (b: { repoId: string; name: string; command: string; kind?: RepoCommand['kind']; cwd?: string | null }) =>
    req<RepoCommand>('POST', '/api/commands', b),
  updateCommand: (id: string, b: Partial<Pick<RepoCommand, 'name' | 'command' | 'kind' | 'cwd' | 'sortOrder'>>) =>
    req<RepoCommand>('PATCH', `/api/commands/${id}`, b),
  deleteCommand: (id: string) => req<{ ok: true }>('DELETE', `/api/commands/${id}`),
  repoScripts: (repoId: string) => req<RepoScripts>('GET', `/api/repos/${repoId}/scripts`),
  runCommand: (id: string) => req<CommandRun>('POST', `/api/commands/${id}/run`),
  listCommandRuns: () => req<CommandRun[]>('GET', '/api/command-runs'),
  stopCommandRun: (runId: string) => req<{ ok: true }>('POST', `/api/command-runs/${runId}/stop`),
  clearCommandRuns: () => req<{ ok: true; cleared: number }>('POST', '/api/command-runs/clear'),

  listTasks: () => req<Task[]>('GET', '/api/tasks').then((l) => l.map(normalizeTask)),
  createTask: (b: TaskWrite & { title: string }) =>
    req<Task>('POST', '/api/tasks', b).then(normalizeTask),
  updateTask: (id: string, b: TaskWrite) =>
    req<Task>('PATCH', `/api/tasks/${id}`, b).then(normalizeTask),
  deleteTask: (id: string) => req<{ ok: true }>('DELETE', `/api/tasks/${id}`),
  taskAction: (
    id: string,
    action: 'enqueue' | 'run-now' | 'cancel' | 'retry' | 'unblock' | 'complete' | 'publish' | 'queue' | 'unqueue',
  ) => req<Task>('POST', `/api/tasks/${id}/${action}`),
  stopAgent: (id: string) => req<{ ok: true; closed: number }>('POST', `/api/tasks/${id}/stop-agent`),
  followUp: (id: string, message: string) => req<Task>('POST', `/api/tasks/${id}/follow-up`, { message }),
  applyReview: (id: string) => req<Task>('POST', `/api/tasks/${id}/apply-review`),
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
