import type { Office } from '@tm/shared';
import { autonomousOfficeTasks } from '../office/autonomy.ts';
import { setKillSwitch } from '../office/kill-switch.ts';
import type { Storage } from '../storage/types.ts';
import { escapeHtml } from './api.ts';
import type { InlineKeyboardButton } from './types.ts';

// The office kill switch on the phone (docs/office.md § Autonomous opt-in,
// docs/telegram.md § Office kill switch). `ks:<officeId>:1|0` — its own
// namespace, parsed BEFORE the stateless action codec like `op:`/`rt:`. A
// press sets the switch in-process as `telegram` through `setKillSwitch`, the
// REST route's own function (whose `office.kill-switch` row is the audit);
// pressing it again in the same state changes nothing. Shown under `/autonomy`
// and under every briefing document.

export interface KillSwitchButton {
  officeId: string;
  on: boolean;
}

export function encodeKillSwitchButton(officeId: string, on: boolean): string {
  return `ks:${officeId}:${on ? '1' : '0'}`;
}

export function parseKillSwitchData(data: string): KillSwitchButton | null {
  const m = /^ks:([\w-]{1,48}):([01])$/.exec(data);
  if (!m) return null;
  return { officeId: m[1], on: m[2] === '1' };
}

/** The one button for an office's current state: engage while off, release while on. */
export function killSwitchButton(office: Pick<Office, 'id' | 'killSwitch'>): InlineKeyboardButton {
  return office.killSwitch
    ? { text: '▶️ Release kill switch', callback_data: encodeKillSwitchButton(office.id, false) }
    : { text: '🛑 Kill switch — no autonomy', callback_data: encodeKillSwitchButton(office.id, true) };
}

/** Run a press. `toast` is the callback answer, `html` the line sent after it. */
export async function runKillSwitchButton(
  storage: Storage,
  button: KillSwitchButton,
  actor: string,
): Promise<{ ok: boolean; changed: boolean; toast: string; html: string }> {
  const r = await setKillSwitch(storage, button.officeId, button.on, actor);
  if (!r.ok) return { ok: false, changed: false, toast: r.code === 404 ? 'Gone' : r.error.slice(0, 180), html: `⚠ ${escapeHtml(r.error)}` };
  const name = (await storage.getWorkspace(r.office.workspaceId).catch(() => null))?.name ?? r.office.id.slice(0, 8);
  if (!r.changed) {
    return { ok: true, changed: false, toast: button.on ? 'Already on' : 'Already off', html: '' };
  }
  return {
    ok: true,
    changed: true,
    toast: button.on ? '🛑 Kill switch on' : '▶️ Kill switch off',
    html: button.on
      ? `🛑 Офис <b>${escapeHtml(name)}</b>: kill switch включён — every office task lands supervised and no push is auto-approved${r.dropped.length ? ` (${r.dropped.length} task${r.dropped.length === 1 ? '' : 's'} dropped back)` : ''}.`
      : `▶️ Офис <b>${escapeHtml(name)}</b>: kill switch выключен — the autonomy opt-in applies again where its conditions hold.`,
  };
}

/** `/autonomy`: every office's level, kill switch, opted-in repos and tasks landing autonomously, one button each. */
export async function autonomyMessage(storage: Storage): Promise<{ html: string; keyboard: { inline_keyboard: InlineKeyboardButton[][] } | undefined }> {
  const offices = await storage.listOffices();
  if (!offices.length) return { html: 'No office yet — create one on the /office page.', keyboard: undefined };
  const [repos, workspaces, autonomous] = await Promise.all([storage.listRepos(), storage.listWorkspaces(), autonomousOfficeTasks(storage).catch(() => [])]);
  const lines = ['🤖 <b>Office autonomy</b>'];
  const rows: InlineKeyboardButton[][] = [];
  for (const o of offices) {
    const ws = workspaces.find((w) => w.id === o.workspaceId);
    const optedIn = repos.filter((r) => r.officeAutonomyOptin && ws?.repoIds.includes(r.id)).map((r) => r.name);
    const n = autonomous.filter((t) => t.officeId === o.id).length;
    lines.push(
      '',
      `<b>${escapeHtml(ws?.name ?? o.id.slice(0, 8))}</b> · ${escapeHtml(o.autonomy)}${o.enabled ? '' : ' · off'}${o.pausedAt ? ' · paused' : ''}`,
      o.killSwitch ? '🛑 kill switch ON — everything lands supervised' : `kill switch off · opted-in repos: ${optedIn.length ? escapeHtml(optedIn.join(', ')) : 'none'}`,
      `landing autonomously now: ${n}`,
    );
    rows.push([killSwitchButton(o)]);
  }
  return { html: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}
