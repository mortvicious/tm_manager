import type { Feature, FeaturePlan, FeatureReview, Proposal, Repo, Run, Task } from '@tm/shared';

// One malformed JSON cell must not break every list query (review F4).
function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Row mappers shared by both drivers. Column names are snake_case in SQL,
// camelCase in the API types. Postgres returns lowercase column names too,
// so these work unchanged for both.

export function rowToRepo(r: any): Repo {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    role: r.role ?? null,
    previewUrl: r.preview_url ?? null,
    createdAt: r.created_at,
  };
}

export function rowToTask(r: any): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    repoId: r.repo_id ?? null,
    parentId: r.parent_id ?? null,
    status: r.status,
    source: r.source,
    sourceRef: r.source_ref ?? null,
    priority: Number(r.priority ?? 0),
    model: r.model ?? null,
    effort: r.effort ?? null,
    category: r.category ?? null,
    createdByRun: r.created_by_run ?? null,
    spawnDepth: Number(r.spawn_depth ?? 0),
    featureId: r.feature_id ?? null,
    featurePhase: r.feature_phase == null ? null : Number(r.feature_phase),
    resultSummary: r.result_summary ?? null,
    review: r.review == null ? null : !!Number(r.review),
    reviewSummary: r.review_summary ?? null,
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToRun(r: any): Run {
  return {
    id: r.id,
    taskId: r.task_id ?? null,
    repoId: r.repo_id ?? null,
    mode: r.mode,
    status: r.status,
    pid: r.pid == null ? null : Number(r.pid),
    exitCode: r.exit_code == null ? null : Number(r.exit_code),
    needsAttention: !!Number(r.needs_attention ?? 0),
    idle: !!Number(r.idle ?? 0),
    model: r.model ?? null,
    effort: r.effort ?? null,
    sessionId: r.session_id ?? null,
    transcriptPath: r.transcript_path ?? null,
    stats: safeParse(r.stats, null),
    resumedFrom: r.resumed_from ?? null,
    statsBaseline: safeParse(r.stats_baseline, null),
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
  };
}

export function rowToFeature(r: any): Feature {
  return {
    id: r.id,
    repoId: r.repo_id ?? null,
    title: r.title,
    request: r.request ?? '',
    status: r.status,
    analysis: safeParse<FeaturePlan | null>(r.analysis, null),
    review: safeParse<FeatureReview | null>(r.review, null),
    analysisRounds: Number(r.analysis_rounds ?? 0),
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToProposal(r: any): Proposal {
  return {
    id: r.id,
    runId: r.run_id ?? null,
    repoId: r.repo_id ?? null,
    taskId: r.task_id ?? null,
    kind: r.kind,
    payload: safeParse(r.payload, { rationale: '(unparseable payload)' }),
    status: r.status,
    createdAt: r.created_at,
  };
}

export const now = () => new Date().toISOString();

// Time-sortable event id (UUIDv7-style): ms hex prefix + random suffix, so
// ORDER BY id preserves insertion order even within one millisecond batch —
// v4 uuids would tiebreak randomly (dashboard review A2).
let lastMs = 0;
let seq = 0;
export function eventId(): string {
  const ms = Date.now();
  if (ms === lastMs) seq++;
  else {
    lastMs = ms;
    seq = 0;
  }
  const rand = Math.random().toString(16).slice(2, 10);
  return `${ms.toString(16).padStart(12, '0')}${seq.toString(16).padStart(3, '0')}-${rand}`;
}

export function rowToEvent(r: any) {
  return {
    id: r.id,
    at: r.at,
    kind: r.kind,
    actor: r.actor,
    taskId: r.task_id ?? null,
    runId: r.run_id ?? null,
    repoId: r.repo_id ?? null,
    data: safeParse(r.data, null),
  };
}
