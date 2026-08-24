import type { Task } from '@tm/shared';
import { broadcast } from './events.ts';
import type { Storage } from './storage/types.ts';

interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  count: string;
  userCount: number;
  level: string;
  lastSeen: string;
  metadata?: { value?: string; type?: string };
}

export interface SyncResult {
  created: number;
  skipped: number;
  fetched: number;
}

/**
 * Pulls unresolved Sentry issues and files them as tasks (source: sentry,
 * sourceRef: issue id). Idempotent: an issue whose id is already a task's
 * sourceRef is skipped — re-syncing never duplicates.
 */
export async function syncSentryIssues(storage: Storage): Promise<SyncResult> {
  const s = await storage.getSettings();
  const org = s['sentry.org'];
  const project = s['sentry.project'];
  const token = s['sentry.authToken'];
  if (!org || !project || !token) {
    throw new Error('configure sentry.org, sentry.project and sentry.authToken first');
  }
  const base = (s['sentry.apiBase'] || 'https://sentry.io').replace(/\/$/, '');
  const url = `${base}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=is:unresolved&statsPeriod=14d&limit=25`;

  const authHeaders = { Authorization: `Bearer ${token}` };
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error(
        `Sentry API 403 — the token authenticates but lacks scope for issues. Create an auth token with ` +
          `project:read and event:read (Sentry → Settings → Auth Tokens). A sourcemap-upload token (org:read only) will not work.`,
      );
    }
    throw new Error(`Sentry API ${res.status}: ${body.slice(0, 200)}`);
  }
  const issues = (await res.json()) as SentryIssue[];

  // Best-effort per-issue tags (environment, release, transaction, level, and
  // any custom tags your SDK sends). Degrades silently if the tags endpoint is
  // not permitted or slow.
  const fetchTags = async (issueId: string): Promise<{ key: string; value: string }[]> => {
    try {
      const r = await fetch(`${base}/api/0/issues/${encodeURIComponent(issueId)}/tags/?limit=6`, {
        headers: authHeaders,
      });
      if (!r.ok) return [];
      const rows = (await r.json()) as { key: string; name: string; topValues?: { value: string }[] }[];
      return rows
        .filter((t) => t.topValues?.[0]?.value)
        .map((t) => ({ key: t.key, value: t.topValues![0].value }))
        .slice(0, 6);
    } catch {
      return [];
    }
  };
  // pick a task category from the Sentry tag whose key matches sentry.categoryTag
  const categoryTag = (s['sentry.categoryTag'] || '').trim();

  const existing = await storage.listTasks();
  const known = new Set(existing.filter((t) => t.source === 'sentry' && t.sourceRef).map((t) => t.sourceRef));
  const repoId = s['sentry.repoId'] || null;

  let created = 0;
  const newTasks: Task[] = [];
  for (const issue of issues) {
    if (known.has(issue.id)) continue;
    const tags = await fetchTags(issue.id);
    const tagLine = tags.length ? `Tags: ${tags.map((t) => `\`${t.key}:${t.value}\``).join(' ')}` : '';
    const category =
      (categoryTag && tags.find((t) => t.key === categoryTag)?.value) ||
      (issue.level ? issue.level.charAt(0).toUpperCase() + issue.level.slice(1) : null);
    const description = [
      `Sentry issue **${issue.shortId}** (${issue.level}) — ${issue.count} events / ${issue.userCount} users, last seen ${issue.lastSeen}.`,
      issue.culprit ? `Culprit: \`${issue.culprit}\`` : '',
      issue.metadata?.value ? `\n${issue.metadata.type ?? 'Error'}: ${issue.metadata.value}` : '',
      tagLine ? `\n${tagLine}` : '',
      `\n${issue.permalink}`,
      `\nInvestigate the root cause in this repo and fix it. Verify the fix compiles and existing behavior is preserved.`,
    ]
      .filter(Boolean)
      .join('\n');
    const task = await storage.createTask(
      {
        title: `[${issue.shortId}] ${issue.title}`.slice(0, 300),
        description,
        repoId,
        source: 'sentry',
        sourceRef: issue.id,
        category,
      },
      'sentry',
    );
    newTasks.push(task);
    created++;
  }
  for (const t of newTasks) broadcast({ type: 'task.updated', task: t });
  await storage.appendEvent({
    kind: 'sentry.sync',
    actor: 'human',
    data: { fetched: issues.length, created, skipped: issues.length - created },
  });
  return { created, skipped: issues.length - created, fetched: issues.length };
}
