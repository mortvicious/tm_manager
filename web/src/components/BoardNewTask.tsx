import { useState } from 'react';
import { useApp } from '../state.tsx';
import { NewTaskForm, useNewTaskHotkey } from '../pages/Board.tsx';
import { IconPlus } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';

/**
 * New task on every board version (docs/board-versions.md § New task): the
 * original Board's own button, form and N hotkey, reused verbatim — one per
 * version page, in its `.board-tools` beside the Versions control. The
 * original board keeps its own and never mounts this.
 */
export function BoardNewTask() {
  const mobile = useIsMobile();
  const { refresh } = useApp();
  const [open, setOpen] = useState(false);
  useNewTaskHotkey(() => setOpen(true), !mobile && !open);
  return (
    <>
      {mobile ? (
        <button type="button" className="btn primary new-task-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          <IconPlus /> New
        </button>
      ) : (
        <button
          type="button"
          className="btn primary new-task-open"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="New task (N)"
          onClick={() => setOpen(true)}
        >
          <IconPlus /> New task
          <kbd className="nt-key" aria-hidden="true">
            N
          </kbd>
        </button>
      )}
      <NewTaskForm open={open} onOpenChange={setOpen} onCreated={refresh} mobile={mobile} />
    </>
  );
}
