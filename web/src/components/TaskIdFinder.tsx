import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task } from '@tm/shared';
import { MIN_TASK_ID_PREFIX, findTaskById, type TaskIdMatch } from '../taskId.ts';

/**
 * "Find by id" on the Board (docs/handbook.md § Finding a task by id): a full
 * id or a unique prefix opens that task's panel, whatever the board's filters
 * hide. Desktop shows the outcome in a popover under the field; the phone's
 * Filters sheet (`inline`) shows it in flow.
 */
export function TaskIdFinder({
  tasks,
  onOpenTask,
  inline,
}: {
  tasks: readonly Task[];
  onOpenTask: (id: string) => void;
  inline?: boolean;
}) {
  const [value, setValue] = useState('');
  // the outcome of the last submit; null once the field is edited or dismissed
  const [miss, setMiss] = useState<Exclude<TaskIdMatch, { kind: 'found' } | { kind: 'empty' }> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // a click anywhere else dismisses the popover
  useEffect(() => {
    if (!miss || inline) return;
    const onDown = (e: PointerEvent) => {
      if (!formRef.current?.contains(e.target as Node)) setMiss(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [miss, inline]);

  const open = (id: string) => {
    setValue('');
    setMiss(null);
    onOpenTask(id);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const m = findTaskById(tasks, value);
    if (m.kind === 'empty') return setMiss(null);
    if (m.kind === 'found') return open(m.task.id);
    setMiss(m);
  };

  return (
    <form ref={formRef} className={`id-find ${inline ? 'inline' : ''}`} role="search" onSubmit={submit}>
      <input
        className="field mono"
        type="search"
        aria-label="Find task by id"
        placeholder="Task id…"
        title={`Open a task by its id or its first ${MIN_TASK_ID_PREFIX}+ characters`}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setMiss(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && miss) {
            e.stopPropagation();
            setMiss(null);
          }
        }}
      />
      {miss && (
        <div className="id-find-out" role="status">
          {miss.kind === 'too-short' && (
            <span className="muted">Type at least {MIN_TASK_ID_PREFIX} characters of the id.</span>
          )}
          {miss.kind === 'none' && <span className="warn-text">No task id starts with “{miss.query}”.</span>}
          {miss.kind === 'ambiguous' && (
            <>
              <span className="muted">
                {miss.candidates.length + miss.more} tasks start with “{miss.query}”
                {miss.more > 0 ? ` — showing the newest ${miss.candidates.length}, type more of the id` : ''}:
              </span>
              {miss.candidates.map((t) => (
                <button key={t.id} type="button" className="id-find-hit" onClick={() => open(t.id)}>
                  <span className="mono">{t.id.slice(0, Math.max(8, miss.query.length + 4))}</span>
                  <span className="title">{t.title}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </form>
  );
}
