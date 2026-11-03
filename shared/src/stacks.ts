// Board version "Stacks" (docs/board-versions.md § Stacks): the pure model.
// Sections by what needs the human — Needs you · Working · Up next · Drafts ·
// Landed · Stopped — and a group as ONE stack in the section of its most
// urgent member (a group never splits across sections). "Needs you" is not
// defined here: it is the shared `buildInbox` the caller already ran, read for
// its question / approval / attention / review / failed items.

import {
  groupColorSlot,
  groupLabel,
  verifyOpen,
  type InboxItem,
  type Task,
} from './types.ts';

export type StackSectionId = 'needs-you' | 'working' | 'up-next' | 'drafts' | 'landed' | 'stopped';

/** Most urgent first; a stack sits in the first one any member reaches. */
export const STACK_SECTIONS: readonly { id: StackSectionId; label: string }[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'up-next', label: 'Up next' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'landed', label: 'Landed' },
  { id: 'stopped', label: 'Stopped' },
];

/** The inbox kinds that put a task under "Needs you" (blocked split parents and stale drafts do not). */
export const STACK_NEED_KINDS = ['question', 'approval', 'attention', 'review', 'failed'] as const;
export type StackNeed = (typeof STACK_NEED_KINDS)[number];

export interface StackMember {
  task: Task;
  section: StackSectionId;
  /** why it needs the human (its most urgent inbox kind), else null */
  need: StackNeed | null;
  /** depth in the group tree as shown (0 = a top member of the stack) */
  depth: number;
}

export interface StackGroup {
  kind: 'stack';
  key: string;
  groupId: string;
  label: string;
  /** `--tm-group-<slot>` */
  slot: number;
  section: StackSectionId;
  /** run order: the tree in pre-order, siblings by `sortOrder` */
  members: StackMember[];
  /** the most urgent member — the card's "now:" line */
  now: StackMember;
  /** done + published */
  landed: number;
}

export interface StackSingle {
  kind: 'task';
  key: string;
  member: StackMember;
  /** the task's group when the board holds two or more of it (flat mode's dot + name) */
  group: { groupId: string; label: string; slot: number } | null;
}

export type StackItem = StackGroup | StackSingle;

export interface StackSection {
  id: StackSectionId;
  label: string;
  items: StackItem[];
  /** tasks in the section (a stack counts all its members) */
  tasks: number;
}

export interface StacksInput {
  /** the board set: workspace scope applied, hidden tasks left out */
  tasks: readonly Task[];
  /** `buildInbox` over the same set — the one definition of what needs the human */
  inbox: readonly InboxItem[];
  /** stacks (default) or every task as its own row */
  mode?: 'stacks' | 'flat';
}

const RANK: Record<StackSectionId, number> = Object.fromEntries(STACK_SECTIONS.map((s, i) => [s.id, i])) as Record<StackSectionId, number>;

/** The section one task belongs in, given its inbox reading. */
export function stackSectionOf(t: Task, need: StackNeed | null): StackSectionId {
  if (need) return 'needs-you';
  switch (t.status) {
    case 'running':
    case 'waiting':
      return 'working';
    // not in the inbox: the verify round is still open (the machine is on it),
    // or Pause all suspended it (it resumes on Continue)
    case 'review':
      return verifyOpen(t) ? 'working' : 'up-next';
    case 'queued':
    case 'blocked':
      return 'up-next';
    case 'draft':
      return 'drafts';
    case 'done':
    case 'published':
      return 'landed';
    // failed past the inbox's window, or cancelled
    default:
      return 'stopped';
  }
}

/** The inbox read per task: its most urgent need kind and the item's position (decision order). */
export function stackNeeds(inbox: readonly InboxItem[]): Map<string, { need: StackNeed; at: number }> {
  const out = new Map<string, { need: StackNeed; at: number }>();
  const kinds = new Set<string>(STACK_NEED_KINDS);
  inbox.forEach((item, at) => {
    if (!kinds.has(item.kind)) return;
    const task = 'task' in item ? item.task : null;
    if (task && !out.has(task.id)) out.set(task.id, { need: item.kind as StackNeed, at });
  });
  return out;
}

/** Run order for a group's members: pre-order over the tree shown, siblings by `sortOrder`. */
function runOrder(members: readonly Task[]): { task: Task; depth: number }[] {
  const ids = new Set(members.map((t) => t.id));
  const kids = new Map<string | null, Task[]>();
  for (const t of members) {
    const p = t.parentId && ids.has(t.parentId) ? t.parentId : null;
    const list = kids.get(p);
    if (list) list.push(t);
    else kids.set(p, [t]);
  }
  const bySort = (a: Task, b: Task) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const out: { task: Task; depth: number }[] = [];
  const walk = (p: string | null, depth: number) => {
    for (const t of (kids.get(p) ?? []).sort(bySort)) {
      out.push({ task: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * The board, sorted by what needs the human. Within a section: Needs you in
 * the inbox's decision order; Working, Up next and Drafts in queue order
 * (priority, then the group root's position, then the task's own — the
 * claim's order); Landed and Stopped newest first.
 */
export function buildStacks({ tasks, inbox, mode = 'stacks' }: StacksInput): StackSection[] {
  const needs = stackNeeds(inbox);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memberOf = (t: Task, depth = 0): StackMember => {
    const n = needs.get(t.id);
    return { task: t, need: n?.need ?? null, section: stackSectionOf(t, n?.need ?? null), depth };
  };

  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = groups.get(t.groupId);
    if (list) list.push(t);
    else groups.set(t.groupId, [t]);
  }
  const groupInfo = (groupId: string, members: readonly Task[]) => {
    const root = byId.get(groupId);
    return { groupId, label: groupLabel(root, runOrder(members)[0]?.task.title ?? 'group'), slot: groupColorSlot(root, groupId) };
  };

  const items: StackItem[] = [];
  for (const [groupId, members] of groups) {
    const info = members.length > 1 ? groupInfo(groupId, members) : null;
    if (mode === 'stacks' && info) {
      const ordered = runOrder(members).map(({ task, depth }) => memberOf(task, depth));
      // most urgent: section, then the inbox's order, then a member that can
      // move before a blocked split parent waiting on it, then run order
      const rankOf = (m: StackMember) => [RANK[m.section], needs.get(m.task.id)?.at ?? 0, m.task.status === 'blocked' ? 1 : 0];
      let now = ordered[0];
      for (const m of ordered.slice(1)) {
        const a = rankOf(m);
        const b = rankOf(now);
        if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) now = m;
      }
      items.push({
        kind: 'stack',
        key: `stack:${groupId}`,
        ...info,
        section: now.section,
        members: ordered,
        now,
        landed: members.filter((t) => t.status === 'done' || t.status === 'published').length,
      });
      continue;
    }
    for (const t of members) items.push({ kind: 'task', key: `task:${t.id}`, member: memberOf(t), group: info });
  }

  const head = (i: StackItem) => (i.kind === 'stack' ? i.now : i.member);
  const sectionOf = (i: StackItem) => (i.kind === 'stack' ? i.section : i.member.section);
  const queueKey = (t: Task): [number, number, number] => [-t.priority, byId.get(t.groupId)?.sortOrder ?? t.sortOrder, t.sortOrder];
  const newest = (i: StackItem) =>
    i.kind === 'stack' ? i.members.reduce((m, x) => (x.task.updatedAt > m ? x.task.updatedAt : m), '') : i.member.task.updatedAt;
  const compare = (section: StackSectionId) => (a: StackItem, b: StackItem): number => {
    if (section === 'needs-you') return (needs.get(head(a).task.id)?.at ?? 0) - (needs.get(head(b).task.id)?.at ?? 0);
    if (section === 'landed' || section === 'stopped') return newest(b).localeCompare(newest(a)) || a.key.localeCompare(b.key);
    const ka = queueKey(head(a).task);
    const kb = queueKey(head(b).task);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || head(a).task.createdAt.localeCompare(head(b).task.createdAt) || a.key.localeCompare(b.key);
  };

  return STACK_SECTIONS.map(({ id, label }) => {
    const list = items.filter((i) => sectionOf(i) === id).sort(compare(id));
    return { id, label, items: list, tasks: list.reduce((n, i) => n + (i.kind === 'stack' ? i.members.length : 1), 0) };
  }).filter((s) => s.items.length > 0);
}
