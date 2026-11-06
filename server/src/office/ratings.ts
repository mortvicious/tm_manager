// Stakeholder ratings (docs/office.md § Ratings): one 👍/👎 per subject — a
// role's brief, proposal, role-tagged task or channel message — stored once
// and updated on change (`tm_office_ratings`, unique on the subject). Every
// change appends ONE line to the role's append-only FEEDBACK file through
// `appendRoleFeedback`, never to the role-owned notes file, so a shift running
// at that moment (whose `notes` section replaces the notes whole) cannot
// overwrite it; the next shift's prompt carries it. The comment is the
// stakeholder's, so it is trusted text; the subject label is server-built and
// names a title only when that title did not come from a tainted shift.
// Called in-process by the route ('human') and the Telegram buttons ('telegram').
import {
  cleanRatingComment,
  officeDay,
  ratingFeedbackLine,
  type Office,
  type OfficeRatingResult,
  type OfficeRatingSubjectKind,
  type OfficeRatingValue,
} from '@tm/shared';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { appendRoleFeedback } from './feedback.ts';

export type RateOutcome = ({ ok: true; feedback: string | null } & OfficeRatingResult) | { ok: false; code: 400 | 404 | 409; error: string };

export interface RateInput {
  kind: OfficeRatingSubjectKind;
  id: string;
  value: OfficeRatingValue;
  /** undefined keeps the stored comment; null/empty clears it */
  comment?: string | null;
}

interface Subject {
  officeId: string;
  roleId: string;
  /** the feedback line's subject, without the emoji */
  label: (office: Office) => string;
  repoId: string | null;
  taskId: string | null;
}

const id8 = (id: string) => id.slice(0, 8);
const TITLE_MAX = 120;
const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
};
/** A title is shown only when no tainted shift wrote it (like a rejected tainted proposal's feedback line). */
const named = (what: string, id: string, title: string, tainted: boolean) =>
  tainted ? `${what} ${id8(id)} (from a tainted shift — title withheld)` : `${what} ${id8(id)} “${clip(title)}”`;

async function resolveSubject(storage: Storage, kind: OfficeRatingSubjectKind, id: string): Promise<Subject | { code: 400 | 404; error: string }> {
  switch (kind) {
    case 'brief': {
      const b = await storage.getBrief(id);
      if (!b) return { code: 404, error: 'no such brief' };
      return {
        officeId: b.officeId,
        roleId: b.roleId,
        label: (o) => `${b.kind === 'standup' ? 'stand-up' : 'brief'} ${officeDay(Date.parse(b.createdAt), o.timezone)}`,
        repoId: null,
        taskId: null,
      };
    }
    case 'proposal': {
      const p = await storage.getOfficeProposal(id);
      if (!p) return { code: 404, error: 'no such proposal' };
      return { officeId: p.officeId, roleId: p.roleId, label: () => named('proposal', p.id, p.title, p.taintedAt !== null), repoId: p.repoId, taskId: null };
    }
    case 'task': {
      const t = await storage.getTask(id);
      if (!t) return { code: 404, error: 'no such task' };
      if (!t.officeId || !t.roleId) return { code: 400, error: 'only an office role’s task can be rated' };
      return {
        officeId: t.officeId,
        roleId: t.roleId,
        label: () => named('task', t.id, t.title, t.taintedAt !== null),
        repoId: t.repoId,
        taskId: t.id,
      };
    }
    case 'message': {
      const m = await storage.getOfficeMessage(id);
      if (!m) return { code: 404, error: 'no such message' };
      if (!m.fromRoleId) return { code: 400, error: 'only a role’s message can be rated (this one is the stakeholder’s)' };
      return { officeId: m.officeId, roleId: m.fromRoleId, label: () => `message ${id8(m.id)} (${m.kind})`, repoId: null, taskId: null };
    }
  }
}

/**
 * Rate a subject. Same value and comment as stored → `changed: false` and
 * nothing else happens. Otherwise the row is upserted, the feedback line
 * appended (a failed append is logged and reported as `feedback: null`, the
 * rating stands), an `office.rated` row audited and `office-rating.updated`
 * broadcast.
 */
export async function rateOfficeSubject(storage: Storage, input: RateInput, actor: string): Promise<RateOutcome> {
  const s = await resolveSubject(storage, input.kind, input.id);
  if ('error' in s) return { ok: false, ...s };
  const office = await storage.getOffice(s.officeId);
  if (!office) return { ok: false, code: 404, error: 'the office is gone' };
  const role = await storage.getOfficeRole(s.roleId);
  if (!role || role.officeId !== office.id) return { ok: false, code: 409, error: 'the role that did this work is gone' };
  const prev = await storage.getOfficeRating(input.kind, input.id);
  const comment = input.comment === undefined ? (prev?.comment ?? null) : cleanRatingComment(input.comment);
  if (prev && prev.value === input.value && prev.comment === comment) {
    return { ok: true, rating: prev, changed: false, feedback: null };
  }
  const rating = await storage.upsertOfficeRating({
    officeId: office.id,
    roleId: role.id,
    subjectKind: input.kind,
    subjectId: input.id,
    value: input.value,
    comment,
  });
  let feedback: string | null = null;
  try {
    feedback = await appendRoleFeedback(office, role, ratingFeedbackLine(input.value, s.label(office), comment, prev?.value ?? null));
  } catch (e) {
    console.warn(`[office] rating feedback for role ${role.key} not written: ${(e as Error).message}`);
  }
  await storage.appendEvent({
    kind: 'office.rated',
    actor,
    taskId: s.taskId,
    repoId: s.repoId,
    data: {
      officeId: office.id,
      roleId: role.id,
      subject: { kind: input.kind, id: input.id },
      value: input.value,
      previous: prev?.value ?? null,
      feedback: feedback !== null,
      ...(comment ? { comment } : {}),
    },
  });
  broadcast({ type: 'office-rating.updated', rating });
  return { ok: true, rating, changed: true, feedback };
}
