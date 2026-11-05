// Where a cross-repo office feature is planned (docs/office.md § Director
// features). A feature a Director filed is planned from the OFFICE FOLDER, like
// the shift that filed it, with every workspace repo as an `--add-dir`, and
// each plan card names the repo it runs in. This module resolves that context
// once for the pipeline (claude/feature-analysis.ts), whoever started it: the
// `feature` shift section, or a human's Re-analyze.
//
// Isolation is the shift's: an UNTAINTED feature's planning sessions get the
// trusted shift's read denies (the untrusted storage plus every role's notes a
// tainted shift wrote), so a trusted plan never reads untrusted text; a
// tainted feature's sessions are tainted already and its cards are held as
// drafts for a human.
import fs from 'node:fs';
import path from 'node:path';
import type { Feature, Office, Repo } from '@tm/shared';
import type { PlanWorkspace } from '../claude/feature-plan.ts';
import type { Storage } from '../storage/types.ts';
import { validateOfficeFolder } from './folder.ts';
import { trustedShiftDenies } from './isolation.ts';
import { roleNotesRel } from './shift-result.ts';

export interface OfficeFeatureContext {
  office: Office;
  /** the prompt's view: name, folder, repos */
  workspace: PlanWorkspace;
  repos: Repo[];
  repoIds: string[];
  tainted: boolean;
  /** the planning sessions' `permissions.deny` — null for a tainted feature */
  denies: string[] | null;
}

/** The workspace's repos that still exist, in the workspace's order. */
export async function officeWorkspaceRepos(storage: Storage, office: Pick<Office, 'workspaceId'>): Promise<{ name: string; repos: Repo[] } | null> {
  const ws = await storage.getWorkspace(office.workspaceId);
  if (!ws) return null;
  const repos = (await Promise.all(ws.repoIds.map((id) => storage.getRepo(id)))).filter((r): r is Repo => !!r);
  return { name: ws.name, repos };
}

/**
 * The planning context of an office feature. Throws with a readable reason
 * (the pipeline fails the feature with it) when the office, its folder or its
 * workspace's repos are gone.
 */
export async function officeFeatureContext(storage: Storage, feature: Pick<Feature, 'officeId' | 'taintedAt'>): Promise<OfficeFeatureContext> {
  if (!feature.officeId) throw new Error('not an office feature');
  const office = await storage.getOffice(feature.officeId);
  if (!office) throw new Error("the feature's office no longer exists");
  const ws = await officeWorkspaceRepos(storage, office);
  if (!ws) throw new Error("the office's workspace no longer exists");
  if (!ws.repos.length) throw new Error("the office's workspace has no repos");
  const folder = validateOfficeFolder(office.folderPath, await storage.listRepos());
  if ('error' in folder) throw new Error(`office folder: ${folder.error}`);
  const root = path.resolve(office.folderPath);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`office folder ${root} does not exist`);
  const tainted = feature.taintedAt != null;
  let denies: string[] | null = null;
  if (!tainted) {
    // fail closed, as a trusted shift: every role's notes a tainted shift wrote are denied where they stand
    const taintedNotes = (await storage.listOfficeRoles(office.id))
      .filter((r) => r.notesTaintedAt !== null)
      .map((r) => roleNotesRel(r))
      .filter((rel) => fs.existsSync(path.join(root, rel)));
    denies = trustedShiftDenies(office, taintedNotes);
  }
  return {
    office,
    workspace: {
      name: ws.name,
      folderPath: root,
      repos: ws.repos.map((r) => ({ id: r.id, name: r.name, path: r.path, role: r.role ?? null })),
    },
    repos: ws.repos,
    repoIds: ws.repos.map((r) => r.id),
    tainted,
    denies,
  };
}
