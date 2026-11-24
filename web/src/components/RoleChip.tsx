// The office role a task belongs to (docs/office.md § Role-tagged work):
// avatar + name, on TaskRow, the task panel head, the board versions and the
// timeline tooltip. Reads the store's `officeRoles` slice; renders nothing for
// a task without a role, or while the role is unknown (deleted, not loaded).
import type { CSSProperties } from 'react';
import { officeHash, type OfficeRole, type Task } from '@tm/shared';
import { useApp } from '../state.tsx';

/** The role a task's `roleId` names, from the store; null when none/unknown. */
export function useTaskRole(task: Pick<Task, 'roleId'>): OfficeRole | null {
  const { officeRoles } = useApp();
  if (!task.roleId) return null;
  return officeRoles.find((r) => r.id === task.roleId) ?? null;
}

/**
 * An avatar is an emoji, or an image id for a later phase; an id (plain
 * letters/digits) is shown as the name's initial instead of as text.
 */
export function avatarGlyph(role: Pick<OfficeRole, 'avatar' | 'name'>): string {
  const a = role.avatar.trim();
  if (a && !/^[\w-]+$/.test(a)) return a;
  return role.name.trim().charAt(0).toUpperCase() || '?';
}

/**
 * The role's hue as `--role-hue: var(--tm-group-<n>)` — the same stable slot
 * its body wears in the office view (`layoutOffice` `colorSlot`). Read only
 * by the design layers (Magma rings a messenger avatar in it, docs/magma.md
 * § 13); an unknown role gets none.
 */
export function roleHueStyle(role: Pick<OfficeRole, 'id'> | null): CSSProperties | undefined {
  if (!role) return undefined;
  return { '--role-hue': `var(--tm-group-${(officeHash(role.id) % 7) + 1})` } as CSSProperties;
}

export function RoleChip({ task }: { task: Pick<Task, 'roleId'> }) {
  const role = useTaskRole(task);
  if (!role) return null;
  return (
    <span className="chip role-chip" title={`office role: ${role.name} — ${role.title}`}>
      <span className="role-chip-avatar" aria-hidden="true">
        {avatarGlyph(role)}
      </span>
      <span className="role-chip-name">{role.name}</span>
    </span>
  );
}

/**
 * Up to three role avatars, overlapped — a conversation-list row's picture
 * (docs/office.md § Conversation list). An unknown id (a deleted role) is a
 * `?`; no ids renders `fallback` (the channel's `#`).
 */
export function RoleAvatars({ roleIds, roles, fallback = '#' }: { roleIds: string[]; roles: OfficeRole[]; fallback?: string }) {
  const shown = roleIds.slice(0, 3);
  const named = shown.map((id) => roles.find((r) => r.id === id) ?? null);
  const label = named.map((r) => (r ? r.name : 'a deleted role')).join(', ');
  return (
    <span className="role-avatars" role="img" aria-label={label || undefined} aria-hidden={label ? undefined : true} title={label || undefined}>
      {shown.length === 0 ? (
        <span className="role-chip-avatar">{fallback}</span>
      ) : (
        named.map((r, i) => (
          <span key={shown[i]} className="role-chip-avatar" style={roleHueStyle(r)}>
            {r ? avatarGlyph(r) : '?'}
          </span>
        ))
      )}
    </span>
  );
}
