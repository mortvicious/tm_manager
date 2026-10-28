import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { NavLink } from 'react-router-dom';
import { groupColorSlot, type Workspace } from '@tm/shared';
import { useApp } from '../state.tsx';
import { useWorkspace } from '../workspace.ts';
import { IconCheck, IconChevron } from './Icons.tsx';
import { Sheet } from './Sheet.tsx';

/** A workspace's palette slot; uncoloured ones take a stable slot from the id, like groups. */
function wsDot(ws: Workspace | null): CSSProperties | undefined {
  if (!ws) return undefined;
  const slot = groupColorSlot({ groupId: ws.id, groupColor: ws.color });
  return { '--tm-ws': `var(--tm-group-${slot})` } as CSSProperties;
}

const repoCount = (n: number) => `${n} repo${n === 1 ? '' : 's'}`;

/**
 * The current-workspace switcher (docs/workspaces.md § Switcher): on a desktop
 * a compact control in the header with a menu; on a phone the header's title
 * (the `brand-mini` slot), which opens a sheet with the same list.
 */
export function WorkspaceSwitcher({ mobile }: { mobile: boolean }) {
  const { workspaces } = useApp();
  const { workspace, setWorkspace, wsHref } = useWorkspace();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // desktop menu: an outside press or Escape closes it (the sheet does its own)
  useEffect(() => {
    if (!open || mobile) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, mobile]);
  // a breakpoint change swaps the menu for the sheet: start closed
  useEffect(() => setOpen(false), [mobile]);

  const pick = (slug: string | null) => {
    setOpen(false);
    setWorkspace(slug);
  };
  const current = workspace?.slug ?? null;
  const options = [null, ...workspaces].map((ws) => {
    const on = (ws?.slug ?? null) === current;
    return (
      <button
        key={ws?.id ?? 'all'}
        type="button"
        role="menuitemradio"
        aria-checked={on}
        className={`ws-opt${on ? ' on' : ''}${mobile ? ' nav-link' : ''}${mobile && on ? ' active' : ''}`}
        onClick={() => pick(ws?.slug ?? null)}
      >
        <span className={`ws-dot${ws ? '' : ' all'}`} style={wsDot(ws)} aria-hidden="true" />
        <span className="ws-opt-name">{ws?.name ?? 'All repos'}</span>
        {ws && <span className="ws-opt-count">{repoCount(ws.repoIds.length)}</span>}
        {on && !mobile && (
          <span className="ws-opt-check" aria-hidden="true">
            <IconCheck />
          </span>
        )}
      </button>
    );
  });
  const manage = (
    <NavLink
      to={wsHref('/repos#workspaces')}
      role="menuitem"
      className={`ws-opt ws-manage${mobile ? ' nav-link' : ''}`}
      onClick={() => setOpen(false)}
    >
      Manage…
    </NavLink>
  );

  if (mobile) {
    return (
      <>
        <button
          type="button"
          className="brand-mini ws-title"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Workspace: ${workspace?.name ?? 'All repos'}`}
          onClick={() => setOpen(true)}
        >
          {workspace ? (
            <>
              <span className="ws-dot" style={wsDot(workspace)} aria-hidden="true" />
              <span className="ws-title-name">{workspace.name}</span>
            </>
          ) : (
            <>
              <span className="ws-title-brand">
                <span className="tm">tm_</span>manager
              </span>
              <span className="ws-title-all">All repos</span>
            </>
          )}
          <span className="ws-caret" aria-hidden="true">
            <IconChevron />
          </span>
        </button>
        {open && (
          <Sheet label="Workspace" title="Workspace" onClose={() => setOpen(false)}>
            <div className="sheet-nav ws-sheet-nav" role="menu" aria-label="Workspaces">
              {options}
              {manage}
            </div>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <span className="ws-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn ghost ws-switch${open ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Workspace: which repos the pages show"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`ws-dot${workspace ? '' : ' all'}`} style={wsDot(workspace)} aria-hidden="true" />
        <span className="ws-switch-name">{workspace?.name ?? 'All repos'}</span>
        <span className="ws-caret" aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {open && (
        <div className="ws-pop" role="menu" aria-label="Workspaces">
          {options}
          <div className="ws-pop-sep" role="separator" />
          {manage}
        </div>
      )}
    </span>
  );
}
