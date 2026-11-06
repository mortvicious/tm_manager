// Group decisions for non-human filings (docs/grouping.md § Agent filings).
// Pure: the vocabulary, the name normaliser and the candidate picker the
// storage composite `createTaskInNamedGroup` runs INSIDE its transaction.

/** Agent joins stop here (the Stacks pip cap, docs/board-versions.md § Stacks). */
export const AGENT_GROUP_MAX_MEMBERS = 40;
/** Same bound as a human group name (PATCH groupName). */
export const GROUP_NAME_MAX = 80;

/** What `POST /api/agent/tasks` accepts as `group` — exactly one form. */
export type GroupRequest = { join: string } | { new: string } | { ungrouped: string };

/** Why a decision was made for the filer (rule names of the omitted-group default). */
export type GroupDefaultRule = 'previous-filing' | 'own-group' | 'ungrouped';

/**
 * The decision as audited on `agent.create` / `task.created` (`data.group`).
 * `decision` is what HAPPENED; `requested` what was asked for, when it differs.
 */
export interface GroupDecisionRecord {
  decision: 'joined' | 'new' | 'ungrouped';
  groupId?: string;
  name?: string | null;
  /** a `new` whose name matched an open group joined it instead */
  joinedExisting?: boolean;
  /** omitted `group`: which default rule decided */
  defaulted?: GroupDefaultRule;
  /** an `ungrouped` filing's one-line why (agent-given or the server's) */
  reason?: string;
  /** the server replaced what was asked for, and why */
  downgraded?: string;
  /** which non-agent creator decided (job, office, shared-note, feature) */
  by?: string;
  via?: 'linkToParent';
}

/**
 * Case, whitespace and punctuation insensitive key for name dedup. Fuzzy
 * matching is the agent's job (it sees `GET /api/agent/groups`).
 */
export function normalizeGroupName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One named root a `new` could dedup onto, as read inside the transaction. */
export interface NamedGroupCandidate {
  rootId: string;
  name: string;
  /** the root's own status / wait — a blocked split root (`blocked`, no wait) takes no agent members */
  rootStatus: string;
  rootWaiting: boolean;
  members: number;
  /** non-terminal members */
  open: number;
  /** members whose filing chain is tainted/sentry/job (`untrustedWalk`) */
  untrusted: number;
  createdAt: string;
}

/**
 * The open group a `new` named `key` joins, or null to mint one. Skipped:
 * finished groups (follow-up work starts fresh), a blocked split root, a full
 * group, and any group whose members' trust differs from the filer's (a join
 * never mixes untrusted with trusted tasks — docs/grouping.md § Reach and taint).
 * The oldest match wins, so concurrent filers converge on one group.
 */
export function pickNamedGroup(
  candidates: NamedGroupCandidate[],
  key: string,
  filerUntrusted: boolean,
  maxMembers = AGENT_GROUP_MAX_MEMBERS,
): NamedGroupCandidate | null {
  const ok = candidates.filter(
    (c) =>
      normalizeGroupName(c.name) === key &&
      c.open > 0 &&
      !(c.rootStatus === 'blocked' && !c.rootWaiting) &&
      c.members < maxMembers &&
      trustCompatible(filerUntrusted, c.members, c.untrusted),
  );
  ok.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.rootId.localeCompare(b.rootId));
  return ok[0] ?? null;
}

/** May a filer of this trust join a group with `members`, `untrusted` of them untrusted? */
export function trustCompatible(filerUntrusted: boolean, members: number, untrusted: number): boolean {
  return filerUntrusted ? untrusted === members : untrusted === 0;
}

/** A group as `GET /api/agent/groups` lists it. */
export interface AgentGroupSummary {
  id: string;
  name: string;
  /** an explicit group name (else the label is the root's title) */
  named: boolean;
  repos: string[];
  members: number;
  open: number;
  rootStatus: string;
  lastActivity: string;
  /** null = an agent could join it; else why not */
  joinRefusal: string | null;
}

/**
 * Is `child` one of `parent`'s SPLIT pieces — what a `blocked` split parent
 * waits on? A feature's plan cards all sit in one group under its first card
 * (docs/grouping.md § Agent filings → Feature approval), so a split of that
 * card has its feature's other cards as children too. Those are group members,
 * never split pieces (a split child is `source: 'auto'` / an agent's
 * linkToParent sibling). JS twin of `RESOLVING_CHILDREN_SQL`
 * (server/src/storage/group-filing-sql.ts) — edit together.
 */
export function isSplitChild(
  child: { source: string; featureId: string | null },
  parent: { featureId: string | null },
): boolean {
  return !(child.source === 'feature' && child.featureId != null && child.featureId === parent.featureId);
}
