// The office kill switch (docs/office.md § Autonomous opt-in, decisions.md
// 2026-11-07): the stakeholder takes the opt-in's two powers away from every
// task of one office at once. Called in-process by the REST route (Origin,
// actor `human`) and the Telegram button (actor `telegram`) — one write path.
//
// Nothing is rewritten on the tasks: every landing and every push-ref
// resolves its tier through `officeAutonomyRefusal`, which reads
// `kill_switch` fresh, so a queued or review task resolves `supervised` from
// the moment the row is written. A publish turn ALREADY under way is not
// interrupted (its push may be half done); nothing new starts.

import type { Office } from '@tm/shared';
import { broadcast } from '../events.ts';
import type { Storage } from '../storage/types.ts';
import { autonomousOfficeTasks } from './autonomy.ts';
import { officeStates } from './scheduler.ts';

export type KillSwitchResult =
  | { ok: true; office: Office; changed: boolean; dropped: string[] }
  | { ok: false; code: 404 | 409; error: string };

export async function setKillSwitch(storage: Storage, officeId: string, on: boolean, actor: string): Promise<KillSwitchResult> {
  const cur = await storage.getOffice(officeId);
  if (!cur) return { ok: false, code: 404, error: 'office not found' };
  if (cur.killSwitch === on) return { ok: true, office: cur, changed: false, dropped: [] };
  // what the switch takes away, for the audit row (a reading; empty when off → on found nothing)
  const before = on ? (await autonomousOfficeTasks(storage).catch(() => [])).filter((t) => t.officeId === officeId).map((t) => t.taskId) : [];
  const row = await storage.setOfficeKillSwitch(officeId, on);
  if (!row) {
    const now = await storage.getOffice(officeId);
    if (!now) return { ok: false, code: 404, error: 'office not found' };
    if (now.killSwitch === on) return { ok: true, office: now, changed: false, dropped: [] };
    return { ok: false, code: 409, error: 'the kill switch changed elsewhere — read it again' };
  }
  await storage.appendEvent({
    kind: 'office.kill-switch',
    actor,
    data: { officeId, workspaceId: row.workspaceId, on, ...(on ? { dropped: before } : {}) },
  });
  broadcast({ type: 'office.updated', office: row, states: (await officeStates(storage, row.id).catch(() => null)) ?? undefined });
  return { ok: true, office: row, changed: true, dropped: before };
}
