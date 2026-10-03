import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { groupAncestors, groupColorSlot, groupLabel, type Task } from '@tm/shared';
import { IconChevron } from './Icons.tsx';

// Choosing a task's group (docs/grouping.md § Choosing a group). Replaces a
// flat <select> of every task title, which gave no hint of which titles were
// groups and grew unusable past a few dozen tasks. Instead: one search box over
// three kinds of choice.
//   No group                       stand alone (`ungroup`)
//   <group>                        append to the end of that group (`group`)
//     └ under <member>             nest under one specific member (`child`)
//   Start a group with <task>      a lone task becomes this one's parent (`child`)
// The value is still just a parentId; `place` tells a caller that moves an
// EXISTING task which API move to make.

export type GroupChoicePlace = 'ungroup' | 'group' | 'child';

interface Option {
  key: string;
  parentId: string | null;
  place: GroupChoicePlace;
  label: string;
  meta?: string;
  depth: number;
  slot?: number;
  /** a group row that can be expanded to its members */
  groupId?: string;
}

/** Lone tasks shown before the search narrows them — a backlog is long. */
const LONE_LIMIT = 12;

export function GroupPicker({
  tasks,
  task,
  repoId,
  value,
  valuePlace,
  onChange,
  repoName,
}: {
  tasks: Task[];
  /** the task being edited; absent when creating one (which has no subtree) */
  task?: Task;
  /** groups in this repo are listed first */
  repoId?: string | null;
  /** the chosen parent id, null = no group */
  value: string | null;
  /** how `value` was chosen — tells "append to the group" from "under its root" */
  valuePlace?: GroupChoicePlace;
  onChange: (parentId: string | null, place: GroupChoicePlace) => void;
  repoName?: (id: string | null) => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // A task cannot be parented under itself or anything beneath it — the
  // server's 400, applied to the list instead of to the save.
  const allowed = (t: Task) => !task || (t.id !== task.id && !groupAncestors(t).includes(task.id));

  const groups = useMemo(() => {
    const out = new Map<string, Task[]>();
    for (const t of tasks) {
      const cur = out.get(t.groupId);
      if (cur) cur.push(t);
      else out.set(t.groupId, [t]);
    }
    return out;
  }, [tasks]);

  const current = value ? byId.get(value) : undefined;
  const currentRoot = current ? byId.get(current.groupId) : undefined;
  const currentSize = current ? (groups.get(current.groupId)?.length ?? 1) : 0;
  const summary = !current
    ? 'No group'
    : currentSize === 1 && current.id !== task?.parentId
      ? `new group with “${current.title}”`
      : current.id === current.groupId && valuePlace !== 'child'
        ? groupLabel(currentRoot, current.title)
        : `${groupLabel(currentRoot, current.title)} › under “${current.title}”`;
  const summarySlot = current ? groupColorSlot(currentRoot, current.groupId) : undefined;

  const options = useMemo((): Option[] => {
    const q = query.trim().toLowerCase();
    const hit = (s: string) => !q || s.toLowerCase().includes(q);
    const out: Option[] = [{ key: 'none', parentId: null, place: 'ungroup', label: 'No group', depth: 0 }];
    const multi = [...groups.entries()].filter(([, m]) => m.length > 1);
    const sameRepoFirst = (a: Task | undefined, b: Task | undefined) =>
      Number(b?.repoId === repoId && !!repoId) - Number(a?.repoId === repoId && !!repoId);
    multi.sort(([a], [b]) => {
      const ra = byId.get(a);
      const rb = byId.get(b);
      return sameRepoFirst(ra, rb) || groupLabel(ra, '').localeCompare(groupLabel(rb, ''));
    });
    for (const [gid, members] of multi) {
      const root = byId.get(gid);
      const label = groupLabel(root, members[0].title);
      const matched = members.filter((m) => hit(m.title));
      if (!hit(label) && matched.length === 0) continue;
      const slot = groupColorSlot(root, gid);
      const rootOk = !!root && allowed(root);
      const inner = members.filter((m) => m.id !== gid && allowed(m));
      if (!rootOk && inner.length === 0) continue;
      if (rootOk) {
        out.push({
          key: `g:${gid}`,
          parentId: gid,
          place: 'group',
          label,
          meta: `${members.length} tasks${root?.repoId ? ` · ${repoName?.(root.repoId) ?? ''}` : ''}`,
          depth: 0,
          slot,
          groupId: gid,
        });
      }
      // a search that matched a member opens its group, so the match is visible
      const open = expanded.has(gid) || (!!q && matched.length > 0 && !hit(label)) || !rootOk;
      if (!open) continue;
      const list = [...(rootOk ? [root!] : []), ...inner].sort(
        (a, b) =>
          groupAncestors(a).length - groupAncestors(b).length || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
      );
      for (const m of list) {
        if (q && !hit(m.title) && !hit(label)) continue;
        out.push({
          key: `m:${m.id}`,
          parentId: m.id,
          place: 'child',
          label: `under “${m.title}”`,
          depth: 1 + groupAncestors(m).length,
          slot,
        });
      }
    }
    const lone = [...groups.values()]
      .filter((m) => m.length === 1 && allowed(m[0]) && hit(m[0].title))
      .map((m) => m[0])
      .sort((a, b) => sameRepoFirst(a, b) || a.title.localeCompare(b.title));
    for (const t of q ? lone : lone.slice(0, LONE_LIMIT)) {
      out.push({
        key: `l:${t.id}`,
        parentId: t.id,
        place: 'child',
        label: `start a group with “${t.title}”`,
        meta: repoName?.(t.repoId),
        depth: 0,
      });
    }
    return out;
    // `allowed` depends on `task` only
  }, [groups, byId, query, expanded, repoId, task, repoName]);

  const loneHidden = !query.trim() && [...groups.values()].filter((m) => m.length === 1).length > LONE_LIMIT;

  const pick = (o: Option) => {
    onChange(o.parentId, o.place);
    setOpen(false);
    setQuery('');
  };

  const toggle = (gid: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(gid)) next.add(gid);
      return next;
    });

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const move = (i: number) => {
      const n = Math.max(0, Math.min(options.length - 1, i));
      setActive(n);
      listRef.current?.querySelector<HTMLElement>(`[data-index="${n}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(active - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const gid = options[active]?.groupId;
      if (gid && expanded.has(gid) === (e.key === 'ArrowLeft')) {
        e.preventDefault();
        toggle(gid);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="group-picker">
      <button
        type="button"
        className="field group-picker-value"
        aria-expanded={open}
        style={summarySlot ? ({ '--tm-group': `var(--tm-group-${summarySlot})` } as CSSProperties) : undefined}
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
      >
        <span className={`dot ${current ? '' : 'none'}`} aria-hidden="true" />
        <span className="text">{summary}</span>
        <span className={`caret ${open ? '' : 'closed'}`}>
          <IconChevron />
        </span>
      </button>
      {open && (
        <div className="group-picker-pop">
          <input
            className="field"
            autoFocus
            placeholder="Search groups and tasks…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="tm-group-picker-list"
          />
          <div className="group-picker-list" id="tm-group-picker-list" role="listbox" ref={listRef}>
            {options.map((o, i) => {
              const selected = o.parentId === value && (!value || !valuePlace || o.place === valuePlace);
              return (
                <div
                  key={o.key}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  className={`group-picker-opt ${i === active ? 'active' : ''} ${selected ? 'selected' : ''} ${o.place}`}
                  style={
                    {
                      '--tm-depth': o.depth,
                      ...(o.slot ? { '--tm-group': `var(--tm-group-${o.slot})` } : {}),
                    } as CSSProperties
                  }
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                >
                  {o.groupId ? (
                    <button
                      type="button"
                      className={`expand caret ${expanded.has(o.groupId) ? '' : 'closed'}`}
                      aria-label={expanded.has(o.groupId) ? 'Hide members' : 'Show members to nest under one'}
                      title={expanded.has(o.groupId) ? 'Hide members' : 'Nest under a specific member'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(o.groupId!);
                      }}
                    >
                      <IconChevron />
                    </button>
                  ) : (
                    <span className="expand" aria-hidden="true" />
                  )}
                  {o.place !== 'ungroup' && <span className={`dot ${o.slot ? '' : 'none'}`} aria-hidden="true" />}
                  <span className="text">{o.place === 'group' ? `append to “${o.label}”` : o.label}</span>
                  {o.meta && <span className="meta">{o.meta}</span>}
                </div>
              );
            })}
            {options.length === 1 && query.trim() && <div className="hint group-picker-empty">nothing matches “{query.trim()}”</div>}
            {loneHidden && <div className="hint group-picker-empty">type to find more tasks</div>}
          </div>
        </div>
      )}
    </div>
  );
}
