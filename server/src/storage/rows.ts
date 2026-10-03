import type {
  Chat,
  ChatMessage,
  Dispatch,
  Feature,
  FeaturePlan,
  FeatureReview,
  Proposal,
  Question,
  Repo,
  RepoCommand,
  Report,
  Run,
  SharedNote,
  Space,
  Task,
} from '@tm/shared';

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

export function rowToCommand(r: any): RepoCommand {
  return {
    id: r.id,
    repoId: r.repo_id,
    name: r.name,
    command: r.command,
    // An unknown value (hand-edited row) reads as the harmless kind: a `task`
    // command is never counted as a running service in the header.
    kind: r.kind === 'service' ? 'service' : 'task',
    cwd: r.cwd ?? null,
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToTask(r: any): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    repoId: r.repo_id ?? null,
    parentId: r.parent_id ?? null,
    // Pre-migration-12 rows (and any row a driver forgot to place) read as
    // their own single-task group rather than as a null group.
    groupId: r.group_id ?? r.id,
    groupPath: r.group_path ?? '/',
    groupName: r.group_name ?? null,
    groupColor: r.group_color == null ? null : Number(r.group_color),
    status: r.status,
    source: r.source,
    sourceRef: r.source_ref ?? null,
    priority: Number(r.priority ?? 0),
    sortOrder: Number(r.sort_order ?? 0),
    model: r.model ?? null,
    effort: r.effort ?? null,
    category: r.category ?? null,
    createdByRun: r.created_by_run ?? null,
    spawnDepth: Number(r.spawn_depth ?? 0),
    featureId: r.feature_id ?? null,
    featurePhase: r.feature_phase == null ? null : Number(r.feature_phase),
    resultSummary: r.result_summary ?? null,
    review: r.review == null ? null : !!Number(r.review),
    reviewModel: r.review_model ?? null,
    reviewEffort: r.review_effort ?? null,
    autoPublish: !!Number(r.auto_publish ?? 0),
    customQueueAt: r.custom_queue_at ?? null,
    reviewSummary: r.review_summary ?? null,
    reviewDiffHash: r.review_diff_hash ?? null,
    baseSha: r.base_sha ?? null,
    baseRef: r.base_ref ?? null,
    baseAt: r.base_at ?? null,
    reviewState: r.review_state ?? null,
    reviewRounds: safeParse(r.review_rounds, []),
    wakeAt: r.wake_at ?? null,
    queueHeldAt: r.queue_held_at ?? null,
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
    kind: r.kind ?? (r.mode === 'worker' ? 'worker' : 'analysis'),
    subjectId: r.subject_id ?? null,
    label: r.label ?? null,
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

export function rowToQuestion(r: any): Question {
  return {
    id: r.id,
    taskId: r.task_id,
    runId: r.run_id,
    toolUseId: r.tool_use_id ?? null,
    status: r.status,
    questions: safeParse(r.questions, []),
    answers: r.answers == null ? null : safeParse<Record<string, string> | null>(r.answers, null),
    answeredBy: r.answered_by ?? null,
    note: r.note ?? null,
    createdAt: r.created_at,
    answeredAt: r.answered_at ?? null,
  };
}

export function rowToReport(r: any): Report {
  return {
    id: r.id,
    title: r.title,
    repoIds: safeParse<string[]>(r.repo_ids, []),
    fromDate: r.from_date,
    toDate: r.to_date,
    preset: r.preset,
    // Rows written before the column existed cannot occur (it ships in the same
    // migration as the table), but a NULL must still read as the default.
    language: r.language ?? 'ru',
    status: r.status,
    markdown: r.markdown ?? null,
    summary: r.summary ?? null,
    // pg returns INTEGER as a number, sqlite too — but a NULL from a row
    // written before the DEFAULT took effect must not become NaN.
    taskCount: Number(r.task_count ?? 0),
    model: r.model ?? null,
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Patch -> (column, value) pairs for tm_reports, shared verbatim by both
 * drivers so an added field cannot land in one and not the other. `undefined`
 * means "leave as-is"; `null` is a real value that clears the column.
 */
export function reportPatchColumns(patch: {
  title?: string;
  status?: string;
  markdown?: string | null;
  summary?: string | null;
  taskCount?: number;
  model?: string | null;
  error?: string | null;
}): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (patch.title !== undefined) out.push(['title', patch.title]);
  if (patch.status !== undefined) out.push(['status', patch.status]);
  if (patch.markdown !== undefined) out.push(['markdown', patch.markdown]);
  if (patch.summary !== undefined) out.push(['summary', patch.summary]);
  if (patch.taskCount !== undefined) out.push(['task_count', patch.taskCount]);
  if (patch.model !== undefined) out.push(['model', patch.model]);
  if (patch.error !== undefined) out.push(['error', patch.error]);
  return out;
}

export function rowToSpace(r: any): Space {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    repoIds: safeParse<string[]>(r.repo_ids, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToSharedNote(r: any): SharedNote {
  return {
    id: r.id,
    spaceId: r.space_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    fromRepoId: r.from_repo_id ?? null,
    fromTaskId: r.from_task_id ?? null,
    toRepoId: r.to_repo_id ?? null,
    status: r.status,
    taskId: r.task_id ?? null,
    resolution: r.resolution ?? null,
    files: safeParse<string[]>(r.files, []),
    actor: r.actor,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function rowToDispatch(r: any): Dispatch {
  return {
    id: r.id,
    fromTaskId: r.from_task_id,
    fromRunId: r.from_run_id ?? null,
    toTaskId: r.to_task_id,
    message: r.message,
    // pre-migration-18 rows have no column at all; they were created under
    // wake-the-session semantics, so that is what they keep reading as.
    intent: r.intent === 'fyi' ? 'fyi' : 'needs_action',
    status: r.status,
    note: r.note ?? null,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at ?? null,
  };
}

export function rowToChat(r: any): Chat {
  return {
    id: r.id,
    repoId: r.repo_id,
    title: r.title,
    model: r.model,
    effort: (r.effort ?? null) as Chat['effort'],
    mode: r.mode === 'write' ? 'write' : 'read',
    sessionId: r.session_id ?? null,
    status: r.status,
    error: r.error ?? null,
    // pre-migration-20 rows have no column at all, which reads as "no turn".
    pid: r.pid === null || r.pid === undefined ? null : Number(r.pid),
    turns: Number(r.turns ?? 0),
    // pg returns NUMERIC/REAL as a string on some drivers; Number() is the
    // same normalisation rowToRun does for its stats.
    costUsd: Number(r.cost_usd ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at ?? null,
  };
}

export function rowToChatMessage(r: any): ChatMessage {
  return {
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    text: r.text,
    actor: r.actor,
    error: r.error ?? null,
    costUsd: Number(r.cost_usd ?? 0),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    createdAt: r.created_at,
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
