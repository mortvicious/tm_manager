import type { OfficeRating, OfficeRatingSubjectKind, OfficeRatingValue } from '@tm/shared';

// Stakeholder ratings (docs/office.md § Ratings, migration 64), SQL shared
// verbatim by both drivers (`?` placeholders; the pg driver rewrites them).
// One row per subject: the upsert keys on the unique (subject_kind, subject_id).

export interface NewOfficeRating {
  officeId: string;
  roleId: string;
  subjectKind: OfficeRatingSubjectKind;
  subjectId: string;
  value: OfficeRatingValue;
  comment: string | null;
}

export interface OfficeRatingFilter {
  officeId?: string;
  subjectKind?: OfficeRatingSubjectKind;
  /** an EMPTY array matches nothing */
  subjectIds?: readonly string[];
  limit?: number;
}

export const OFFICE_RATING_GET_SQL = `SELECT * FROM tm_office_ratings WHERE subject_kind = ? AND subject_id = ?`;
export const OFFICE_RATINGS_DELETE_SQL = `DELETE FROM tm_office_ratings WHERE office_id = ?`;

/** Insert, or update the subject's row in place (id and created_at kept). */
export const OFFICE_RATING_UPSERT_SQL = `INSERT INTO tm_office_ratings (id, office_id, role_id, subject_kind, subject_id, value, comment, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (subject_kind, subject_id) DO UPDATE SET
    office_id = excluded.office_id, role_id = excluded.role_id, value = excluded.value,
    comment = excluded.comment, updated_at = excluded.updated_at
  RETURNING *`;

export function officeRatingUpsertParams(id: string, r: NewOfficeRating, at: string): unknown[] {
  return [id, r.officeId, r.roleId, r.subjectKind, r.subjectId, r.value, r.comment, at, at];
}

/** Newest first. */
export function officeRatingListSql(f: OfficeRatingFilter = {}): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.officeId) {
    where.push('office_id = ?');
    params.push(f.officeId);
  }
  if (f.subjectKind) {
    where.push('subject_kind = ?');
    params.push(f.subjectKind);
  }
  if (f.subjectIds) {
    if (f.subjectIds.length === 0) where.push('1 = 0');
    else {
      where.push(`subject_id IN (${f.subjectIds.map(() => '?').join(', ')})`);
      params.push(...f.subjectIds);
    }
  }
  const limit = Math.max(1, Math.min(2000, Math.floor(f.limit ?? 500)));
  return {
    sql: `SELECT * FROM tm_office_ratings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`,
    params,
  };
}

export function rowToOfficeRating(r: any): OfficeRating {
  return {
    id: r.id,
    officeId: r.office_id,
    roleId: r.role_id,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    value: Number(r.value) === 1 ? 1 : -1,
    comment: r.comment ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
