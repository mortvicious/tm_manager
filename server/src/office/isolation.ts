// Where an office keeps text from OUTSIDE this server, and the deny rules that
// keep it out of a trusted shift (docs/office.md § Isolation). These two
// functions are THE layout resolvers: notes, deliverables, briefs, the
// roadmap, messages and the scaffold reach untrusted storage only through
// `untrustedPath`, and a trusted shift's `--settings` deny list only through
// `trustedShiftDenies` — never a hard-coded `untrusted/`. Measured on the
// real CLI (2.1.318, decisions.md 2026-11-05): a `permissions.deny`
// `Read(//abs/dir/**)` rule holds against Read, Grep, Glob, an @-mention and
// a subagent, so the storage stays INSIDE the office folder. Should a later
// CLI stop honouring it, moving it out is a change to this file alone.
import fs from 'node:fs';
import path from 'node:path';
import type { Office } from '@tm/shared';
import { isInside, realPathDeep } from '../folder-guard.ts';

/** The untrusted storage's directory, relative to the office folder. Private: callers resolve through `untrustedPath`. */
const UNTRUSTED_DIR = 'untrusted';

/**
 * Characters a permission rule would read as syntax (gitignore-style globs,
 * the rule's own parentheses, escapes) or that cannot sit in a one-line rule.
 * A path holding one cannot be denied exactly, so it is refused, never
 * approximated: a rule that silently matches nothing is an open door.
 */
const RULE_UNSAFE = /[*?[\]{}()\\!\u0000-\u001f\u007f]/;

/** Why `abs` cannot be written into a deny rule, or null when it can. */
export function denyRuleRefusal(abs: string): string | null {
  return RULE_UNSAFE.test(abs) ? 'path contains a character a permission rule cannot match literally (* ? [ ] { } ( ) \\ ! or a control character)' : null;
}

function folderRoot(office: Pick<Office, 'folderPath'>): string {
  if (!path.isAbsolute(office.folderPath)) throw new Error('office folder: path must be absolute');
  return path.resolve(office.folderPath);
}

/**
 * The absolute path of `relPath` inside the office's untrusted storage
 * (`''` = the storage root itself). `relPath` is relative and may not climb
 * out (`..`) — a resolver that could point anywhere would be no boundary.
 */
export function untrustedPath(office: Pick<Office, 'folderPath'>, relPath: string): string {
  if (path.isAbsolute(relPath)) throw new Error(`untrusted path must be relative: ${relPath}`);
  const root = path.join(folderRoot(office), UNTRUSTED_DIR);
  const p = path.resolve(root, relPath);
  if (!isInside(p, root)) throw new Error(`untrusted path escapes the untrusted storage: ${relPath}`);
  return p;
}

/** `Read(//abs)` — the CLI's absolute-path form (a single leading `/` would be relative to the settings file). */
function readRule(abs: string, recursive: boolean): string {
  const refusal = denyRuleRefusal(abs);
  if (refusal) throw new Error(`office isolation: ${abs}: ${refusal}`);
  return `Read(/${abs}${recursive ? '/**' : ''})`;
}

/**
 * The `permissions.deny` rules a TRUSTED shift is spawned with: the whole
 * untrusted storage, plus each tainted file (`taintedPaths`, relative to the
 * office folder; a directory is denied recursively — e.g. the notes of a role a tainted shift wrote; they stay
 * where they are, the rule is what keeps them out). Each target is denied
 * on its lexical AND its real path, so a symlinked folder or file is covered
 * whichever spelling the session uses. Throws (the shift must not spawn) on a
 * path that escapes the folder or cannot be written as a rule.
 *
 * The rules bind the Read-family tools only (Read, Grep, Glob, @-mentions,
 * subagents — measured). A shift has no Bash (`SHIFT_TOOL_ALLOWLIST`), which
 * is what makes that enough.
 */
export function trustedShiftDenies(office: Pick<Office, 'folderPath'>, taintedPaths: readonly string[]): string[] {
  const root = folderRoot(office);
  const rules: string[] = [];
  const add = (abs: string, recursive: boolean) => {
    for (const p of [abs, realPathDeep(abs)]) {
      const r = readRule(p, recursive);
      if (!rules.includes(r)) rules.push(r);
    }
  };
  add(untrustedPath(office, ''), true);
  for (const rel of taintedPaths) {
    if (path.isAbsolute(rel)) throw new Error(`office isolation: tainted path must be relative to the office folder: ${rel}`);
    const abs = path.resolve(root, rel);
    if (abs === root || !isInside(abs, root)) throw new Error(`office isolation: tainted path escapes the office folder: ${rel}`);
    // a tainted DIRECTORY is denied with everything under it
    add(abs, fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false);
  }
  return rules;
}
