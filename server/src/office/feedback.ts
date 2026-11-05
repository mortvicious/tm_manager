// A role's FEEDBACK file (docs/office.md § Shifts at run time → Notes and
// feedback): `roles/<key>.feedback.md`, everything the SERVER adds about a
// role (proposal decisions, ratings, taint clears). The role's own notes are
// `roles/<key>.md`, which its shift's `notes` section replaces whole; no shift
// section can target this file, so a line appended while a shift runs
// survives that shift. Written only through `appendRoleFeedback`:
// serialized per file in-process, opened O_APPEND (never rewritten, never
// truncated) and O_NOFOLLOW (a symlink planted there is refused, not
// followed). The last `ROLE_FEEDBACK_PROMPT_ENTRIES` entries go into every
// shift's prompt as trusted text.
import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_ROLE_KEY_RE, type Office, type OfficeRole } from '@tm/shared';
import { isInside, realPathDeep } from '../folder-guard.ts';

/** Entries a shift's prompt carries, newest last. */
export const ROLE_FEEDBACK_PROMPT_ENTRIES = 50;
/** One entry's text, after newlines are folded. */
export const ROLE_FEEDBACK_MAX_LINE = 2_000;
/** How much of the file's tail a read looks at — enough for far more than 50 capped entries. */
const READ_TAIL_BYTES = 256 * 1024;

export function roleFeedbackRel(key: string): string {
  if (!OFFICE_ROLE_KEY_RE.test(key)) throw new Error(`office folder: bad role key "${key}"`);
  return `roles/${key}.feedback.md`;
}

/** The file's absolute path, with `roles/` checked to resolve inside the folder. */
function feedbackFile(office: Pick<Office, 'folderPath'>, key: string, create: boolean): string {
  const rel = roleFeedbackRel(key);
  if (!path.isAbsolute(office.folderPath)) throw new Error('office folder: path must be absolute');
  const root = path.resolve(office.folderPath);
  const dir = path.join(root, 'roles');
  if (create) fs.mkdirSync(dir, { recursive: true });
  if (!isInside(realPathDeep(dir), realPathDeep(root))) throw new Error('office folder: roles/ points outside the folder');
  return path.join(root, rel);
}

/** One entry: `- <ISO time> — <text>`, a single line however many the caller passed. */
export function feedbackEntry(line: string, at: Date): string {
  const text = line.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('feedback: empty line');
  const capped = text.length > ROLE_FEEDBACK_MAX_LINE ? `${text.slice(0, ROLE_FEEDBACK_MAX_LINE)}…` : text;
  return `- ${at.toISOString()} — ${capped}\n`;
}

const header = (key: string) =>
  `# Feedback on role \`${key}\`\n\nWritten by the Task Manager, append-only (docs/office.md § Shifts at run time). Shifts read it; no shift writes it.\n\n`;

/** Per-file write chains: one append at a time per file in this process. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Append one line to the role's feedback file. Resolves with the entry as
 * written. Writers of the same file are serialized in this process; the file
 * is opened `O_APPEND | O_CREAT | O_NOFOLLOW`, so it is never rewritten and a
 * symlink in its place fails the write.
 */
export function appendRoleFeedback(
  office: Pick<Office, 'folderPath'>,
  role: Pick<OfficeRole, 'key'>,
  line: string,
  at: Date = new Date(),
): Promise<string> {
  // Validate before queueing, so a bad call fails on its own and never poisons the chain.
  let entry: string;
  let file: string;
  try {
    entry = feedbackEntry(line, at);
    file = path.join(path.resolve(office.folderPath), roleFeedbackRel(role.key));
  } catch (e) {
    return Promise.reject(e);
  }
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const abs = feedbackFile(office, role.key, true);
      const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
      const fh = await fs.promises.open(abs, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o644);
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new Error('feedback: not a regular file');
        await fh.write(st.size === 0 ? header(role.key) + entry : entry);
      } finally {
        await fh.close();
      }
      return entry;
    });
  chains.set(file, next);
  void next.finally(() => {
    if (chains.get(file) === next) chains.delete(file);
  }).catch(() => undefined);
  return next;
}

/** Wait for every append queued so far on this role's file (tests, and a reader that must see them). */
export async function feedbackSettled(office: Pick<Office, 'folderPath'>, role: Pick<OfficeRole, 'key'>): Promise<void> {
  const file = path.join(path.resolve(office.folderPath), roleFeedbackRel(role.key));
  await chains.get(file)?.catch(() => undefined);
}

/**
 * The last `limit` entries (lines starting with `- `), oldest first. A missing
 * file is no feedback; a symlink or a non-file is refused (empty).
 */
export async function readRoleFeedback(
  office: Pick<Office, 'folderPath'>,
  role: Pick<OfficeRole, 'key'>,
  limit = ROLE_FEEDBACK_PROMPT_ENTRIES,
): Promise<string[]> {
  let abs: string;
  try {
    abs = feedbackFile(office, role.key, false);
  } catch {
    return [];
  }
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return [];
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return [];
    const len = Math.min(st.size, READ_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    let lines = buf.toString('utf8').split('\n');
    // a cut first line is a partial entry, not one to show
    if (len < st.size) lines = lines.slice(1);
    const entries = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    return entries.slice(-Math.max(0, limit));
  } finally {
    await fh.close();
  }
}
