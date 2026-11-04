// DEV ONLY (listed in boardVersions.ts under import.meta.env.DEV): a bare
// board version that exercises the registry, the Versions control and the
// focus layer before any real version exists. Not a design.

import { useMemo } from 'react';
import { TERMINAL_TASK_STATUSES, groupDepth } from '@tm/shared';
import type { BoardVersionProps } from '../../boardVersions.ts';
import { BoardFocusCard, BoardFocusProvider, BoardFocusScope, useBoardFocus, useBoardTasks } from '../../boardFocus.tsx';
import { BoardVersionsControl } from '../../components/BoardVersions.tsx';
import { BoardNewTask } from '../../components/BoardNewTask.tsx';
import { StatusBadge } from '../../components/StatusBadge.tsx';

function Nodes() {
  const { tasks, focusedId, neighbourhood, itemProps, toggle } = useBoardFocus();
  // the live tasks, plus any landed one the focused task is related to
  const shown = useMemo(
    () =>
      tasks
        .filter((t) => !TERMINAL_TASK_STATUSES.includes(t.status) || t.id === focusedId || neighbourhood?.ids.has(t.id))
        .sort((a, b) => a.groupId.localeCompare(b.groupId) || a.groupPath.length - b.groupPath.length || a.sortOrder - b.sortOrder),
    [tasks, focusedId, neighbourhood],
  );
  if (!shown.length) return <p className="bf-empty">No live tasks in this workspace.</p>;
  return (
    <ul className="bf-dev-list">
      {shown.map((t) => (
        <li key={t.id} style={{ paddingLeft: `calc(${groupDepth(t)} * var(--tm-space-5))` }}>
          <button type="button" className="bf-dev-node" aria-pressed={t.id === focusedId} {...itemProps(t.id)} onClick={() => toggle(t.id)}>
            <span className="bf-rel-title">{t.title}</span>
            <StatusBadge status={t.status} reviewState={t.reviewState} checkState={t.checkState} loopState={t.loopState} explain={false} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function DevFocusBoard({ onOpenTask }: BoardVersionProps) {
  const tasks = useBoardTasks();
  return (
    <div className="board">
      <div className="board-head">
        <h1 className="page-title">Board</h1>
        <div className="board-tools">
          <BoardVersionsControl />
          <BoardNewTask />
        </div>
      </div>
      <BoardFocusProvider tasks={tasks}>
        <BoardFocusScope>
          <Nodes />
        </BoardFocusScope>
        <BoardFocusCard onOpenTask={onOpenTask} />
      </BoardFocusProvider>
    </div>
  );
}
