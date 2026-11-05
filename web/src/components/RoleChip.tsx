// The office role a task belongs to (docs/office.md § Role-tagged work):
// avatar + name, on TaskRow, the task panel head, the board versions and the
// timeline tooltip. Reads the store's `officeRoles` slice; renders nothing for
// a task without a role, or while the role is unknown (deleted, not loaded).
import type { OfficeRole, Task } from '@tm/shared';
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
function avatarGlyph(role: Pick<OfficeRole, 'avatar' | 'name'>): string {
  const a = role.avatar.trim();
  if (a && !/^[\w-]+$/.test(a)) return a;
  return role.name.trim().charAt(0).toUpperCase() || '?';
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
