// Role-tagged work (docs/office.md § Role-tagged work): a task an office role
// filed (`tm_tasks.role_id`) carries the role's identity and its working notes
// into a FRESH worker prompt, at the very top — the same placement as the
// shared-space block. A resume carries nothing (the session already has it)
// and the publish turn never does. Pure apart from reading the notes file.

import type { Office, OfficeRole, Task } from '@tm/shared';
import { untrustedPath } from './isolation.ts';
import { officeRel, roleNotesRel, SHIFT_NOTES_MAX_CHARS } from './shift-result.ts';
import { readOfficeText } from './shift.ts';

/** Same read bound as a shift's own notes read. */
const NOTES_READ_MAX_BYTES = SHIFT_NOTES_MAX_CHARS * 4;

export const ROLE_NOTES_WITHHELD =
  "The role's notes are withheld: a tainted shift (one that read untrusted content) wrote them and a human has not reviewed them yet. Work from the task description alone.";

/**
 * The notes text a worker on `task` may read, or `withheld`. Untainted notes
 * are always readable; tainted notes only by a task that is itself tainted —
 * it already carries untrusted input, so the notes add no new exposure. A
 * tainted read prefers the untrusted twin (where a tainted shift writes), as
 * the shift runner does.
 */
export function roleNotesFor(
  office: Pick<Office, 'folderPath'>,
  role: Pick<OfficeRole, 'key' | 'notesTaintedAt'>,
  task: Pick<Task, 'taintedAt'>,
): { withheld: true } | { withheld: false; rel: string; text: string } {
  const trusted = roleNotesRel(role);
  if (role.notesTaintedAt === null) {
    return { withheld: false, rel: trusted, text: readOfficeText(office, trusted, NOTES_READ_MAX_BYTES) ?? '' };
  }
  if (task.taintedAt === null) return { withheld: true };
  const twin = officeRel(office, untrustedPath(office, trusted));
  const t = readOfficeText(office, twin, NOTES_READ_MAX_BYTES);
  if (t !== null) return { withheld: false, rel: twin, text: t };
  return { withheld: false, rel: trusted, text: readOfficeText(office, trusted, NOTES_READ_MAX_BYTES) ?? '' };
}

/** The block that leads a fresh worker prompt of a role-tagged task. */
export function roleContextBlock(
  office: Pick<Office, 'folderPath'>,
  role: Pick<OfficeRole, 'key' | 'name' | 'title' | 'prompt' | 'notesTaintedAt'>,
  task: Pick<Task, 'taintedAt'>,
): string {
  const notes = roleNotesFor(office, role, task);
  return [
    `## Office role: ${role.name} — ${role.title}`,
    '',
    `This task was filed by the office role "${role.name}". Do the task as that role would want it done; the task description is still the instruction.`,
    '',
    '### Role brief',
    role.prompt.trim() || '(none)',
    '',
    notes.withheld ? '### Role notes' : `### Role notes (${notes.rel})`,
    notes.withheld ? ROLE_NOTES_WITHHELD : notes.text.trim() || '(empty)',
  ].join('\n');
}
