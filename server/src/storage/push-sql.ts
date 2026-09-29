import type { PushKind } from '@tm/shared';
import { PUSH_KINDS } from '@tm/shared';
import type { PushDeviceRecord } from './types.ts';

/**
 * Web Push devices (docs/push.md): SQL shared VERBATIM by both drivers, like
 * space-sql.ts. `ON CONFLICT … DO UPDATE` and `RETURNING` read the same in
 * SQLite (3.35+) and Postgres.
 */
export const PUSH_UPSERT_SQL = `INSERT INTO tm_push_devices
  (id, endpoint, p256dh, auth, label, kinds, created_at, updated_at, last_ok_at, last_error, fail_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
  ON CONFLICT (endpoint) DO UPDATE SET
    p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, kinds = excluded.kinds,
    updated_at = excluded.updated_at, last_error = NULL, fail_count = 0
  RETURNING *`;

export const PUSH_RESULT_OK_SQL = `UPDATE tm_push_devices SET last_ok_at = ?, last_error = NULL, fail_count = 0 WHERE id = ?`;
export const PUSH_RESULT_FAIL_SQL = `UPDATE tm_push_devices SET last_error = ?, fail_count = fail_count + 1 WHERE id = ?`;

const KNOWN = new Set<string>(PUSH_KINDS.map((k) => k.kind));

export function rowToPushDevice(r: any): PushDeviceRecord {
  let service = '';
  try {
    service = new URL(r.endpoint).hostname;
  } catch {
    // stored endpoints were validated at insert; a bad one just shows blank
  }
  let kinds: PushKind[] = [];
  try {
    const parsed = JSON.parse(r.kinds);
    // a kind dropped from PUSH_KINDS in a later version reads as absent
    if (Array.isArray(parsed)) kinds = parsed.filter((k): k is PushKind => KNOWN.has(k));
  } catch {
    // unreadable → no kinds: the device stays registered but silent
  }
  return {
    id: r.id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    service,
    label: r.label,
    kinds,
    createdAt: r.created_at,
    lastOkAt: r.last_ok_at ?? null,
    lastError: r.last_error ?? null,
    failCount: Number(r.fail_count ?? 0),
  };
}
