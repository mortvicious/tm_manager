// The "a knowledge folder lives OUTSIDE every repo" rule, shared by shared
// spaces (docs/shared-spaces.md) and office folders (docs/office.md § Folder).
// Inside a repo the folder would be committed into that repo's history (and be
// invisible to the others' git); a folder that CONTAINS a repo would hand
// agents a write-scope over whole working trees via `--add-dir`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** `child` is `parent` or below it (lexically). */
export const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The real path of `x`; a path that does not exist yet resolves through its
 * deepest existing ancestor, so `link-to-repo/new/dir` is still inside.
 */
export function realPathDeep(x: string): string {
  let head = x;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return x;
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

/**
 * Validate a dedicated folder: absolute (or `~/…`), not `/` or the home
 * directory, and neither inside nor containing any of `repos` — compared on
 * both the lexical and the real path, so a symlink cannot smuggle the folder
 * into (or around) a repo. Returns the resolved path or the refusal.
 */
export function validateDedicatedFolder(
  raw: string,
  repos: readonly { name: string; path: string }[],
): { path: string } | { error: string } {
  const t = raw.trim();
  // `~user/…` is not expanded — only the caller's own home.
  if (!path.isAbsolute(t) && t !== '~' && !t.startsWith('~/')) {
    return { error: 'path must be absolute (or start with ~/)' };
  }
  const p = path.resolve(expandHome(t));
  const rp0 = realPathDeep(p);
  if (p === path.parse(p).root || rp0 === path.parse(rp0).root || p === os.homedir() || rp0 === realPathDeep(os.homedir())) {
    return { error: 'pick a dedicated folder, not / or your home' };
  }
  for (const r of repos) {
    for (const rp of new Set([path.resolve(r.path), realPathDeep(r.path)])) {
      for (const sp of new Set([p, rp0])) {
        if (isInside(sp, rp)) return { error: `the folder is inside repo "${r.name}" — pick one outside every repo` };
        if (isInside(rp, sp)) return { error: `the folder contains repo "${r.name}" — pick a dedicated folder` };
      }
    }
  }
  return { path: p };
}
