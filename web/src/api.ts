import type { Anomaly, AppSettings, AuditEvent, Proposal, Repo, Run, StatsOverview, Task } from '@tm/shared';

// Only user-editable fields — status/error/resultSummary are machine-owned and
// the server rejects them with a 400 (.strict() schemas).
export type TaskWrite = Partial<
  Pick<Task, 'title' | 'description' | 'repoId' | 'parentId' | 'priority' | 'source' | 'sourceRef' | 'model' | 'effort' | 'category' | 'review'>
>;

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
  health: () => req<{ ok: boolean; driver: string; bootedAt: string }>('GET', '/api/health'),
  restartServer: () => req<{ ok: true; restarting: true }>('POST', '/api/server/restart'),

  listRepos: () => req<Repo[]>('GET', '/api/repos'),
  createRepo: (b: { name?: string; path: string; role?: string | null }) => req<Repo>('POST', '/api/repos', b),
  updateRepo: (id: string, b: Partial<Pick<Repo, 'name' | 'path' | 'role'>>) =>
    req<Repo>('PATCH', `/api/repos/${id}`, b),
  deleteRepo: (id: string) => req<{ ok: true }>('DELETE', `/api/repos/${id}`),
  gitStatus: (id: string) => req<{ isRepo: boolean; branch: string | null; dirty: number; ahead: number }>('GET', `/api/repos/${id}/git`),
  gitCommit: (id: string) => req<{ ok: true; message: string; summary: string }>('POST', `/api/repos/${id}/commit`),
  gitPush: (id: string) => req<{ ok: true; output: string }>('POST', `/api/repos/${id}/push`),

  listTasks: () => req<Task[]>('GET', '/api/tasks'),
  createTask: (b: TaskWrite & { title: string }) => req<Task>('POST', '/api/tasks', b),
  updateTask: (id: string, b: TaskWrite) => req<Task>('PATCH', `/api/tasks/${id}`, b),
  deleteTask: (id: string) => req<{ ok: true }>('DELETE', `/api/tasks/${id}`),
  taskAction: (id: string, action: 'enqueue' | 'run-now' | 'cancel' | 'retry' | 'unblock' | 'complete') =>
    req<Task>('POST', `/api/tasks/${id}/${action}`),
  stopAgent: (id: string) => req<{ ok: true; closed: number }>('POST', `/api/tasks/${id}/stop-agent`),
  followUp: (id: string, message: string) => req<Task>('POST', `/api/tasks/${id}/follow-up`, { message }),
  applyReview: (id: string) => req<Task>('POST', `/api/tasks/${id}/apply-review`),
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

  listRuns: () => req<Run[]>('GET', '/api/runs'),
  killRun: (id: string) => req<Run>('POST', `/api/runs/${id}/kill`),

  analyze: (b: { repoId: string; taskIds?: string[] }) => req<{ runId: string }>('POST', '/api/analyze', b),
  listProposals: (status?: string) =>
    req<Proposal[]>('GET', `/api/proposals${status ? `?status=${status}` : ''}`),
  acceptProposal: (id: string, chosenOptionIndex?: number) =>
    req<{ proposal: Proposal; tasks: Task[] }>('POST', `/api/proposals/${id}/accept`, { chosenOptionIndex }),
  rejectProposal: (id: string) => req<Proposal>('POST', `/api/proposals/${id}/reject`),

  getConfig: () => req<AppSettings>('GET', '/api/config'),
  putConfig: (b: Partial<AppSettings>) => req<AppSettings>('PUT', '/api/config', b),

  orchestrator: () => req<{ enabled: boolean; running: number; concurrency: number }>('GET', '/api/orchestrator'),
  usage: () => req<{ pct: number; threshold: number; routedModel: string }>('GET', '/api/usage'),
  sentrySync: () => req<{ created: number; skipped: number; fetched: number }>('POST', '/api/sentry/sync'),
  statsOverview: (days: number) => req<StatsOverview>('GET', `/api/stats/overview?days=${days}`),
  anomalies: () => req<Anomaly[]>('GET', '/api/stats/anomalies'),
  events: (limit = 50) => req<AuditEvent[]>('GET', `/api/events?limit=${limit}`),
  orchestratorAction: (a: 'start' | 'stop' | 'stop-and-kill') =>
    req<{ enabled: boolean }>('POST', `/api/orchestrator/${a}`),
};
