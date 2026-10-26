import { useEffect, useMemo, useRef, useState } from 'react';
import type { InboxItem } from '@tm/shared';
import {
  InboxDetail,
  InboxItemSheet,
  InboxRowHead,
  InboxRows,
  useActRunner,
  useInbox,
  useInboxActs,
  type InboxNav,
} from '../components/Inbox.tsx';
import { useIsMobile } from '../components/Layout.tsx';

/**
 * The decide view (docs/inbox.md). Desktop: one list, the selected item
 * expanded in place, and the keyboard — j/k (or ↓/↑) move, `a` marks done /
 * approves / unblocks, `r` retries, `p` resumes a limit-stopped session,
 * `x` rejects a proposal, `t` opens a prompt's terminal, `o` (or Enter) opens the task. A decision that removes
 * the item leaves the selection on the same POSITION, so the next item is the
 * one under the cursor. Phone: the rows, and a row opens its own sheet.
 */
export function InboxPage({ onOpenTask, onOpenTerminal }: InboxNav) {
  const mobile = useIsMobile();
  const items = useInbox();
  const nav = useMemo(() => ({ onOpenTask, onOpenTerminal }), [onOpenTask, onOpenTerminal]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = items.find((i) => i.key === openKey) ?? null;

  return (
    <div className="inbox-page">
      <h1 className="page-title">
        Inbox
        <span className="inbox-count">{items.length ? `${items.length} waiting on you` : 'nothing waiting'}</span>
      </h1>
      {!mobile && items.length > 0 && (
        <div className="inbox-keys">
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> done / approve / unblock · <kbd>r</kbd> retry · <kbd>p</kbd> resume · <kbd>x</kbd>{' '}
          reject · <kbd>t</kbd> terminal · <kbd>o</kbd> open
        </div>
      )}
      {mobile ? (
        <>
          <InboxRows items={items} onPick={(i) => setOpenKey(i.key)} />
          {open && <InboxItemSheet item={open} nav={nav} onClose={() => setOpenKey(null)} />}
        </>
      ) : (
        <DeskList items={items} nav={nav} />
      )}
    </div>
  );
}

/** Keys are ignored while typing, in a terminal, or with any dialog/panel open over the page. */
function keyIsOurs(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest('.xterm, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false;
  // Enter on a focused button is that button's click, not "open"
  if (e.key === 'Enter' && el?.closest('button, a')) return false;
  if (document.querySelector('[aria-modal="true"], .qmodal, .slideover, .bs-pop')) return false;
  return true;
}

function DeskList({ items, nav }: { items: InboxItem[]; nav: InboxNav }) {
  const actsFor = useInboxActs(nav);
  const { busy, err, run } = useActRunner();
  const [selKey, setSelKey] = useState<string | null>(null);
  const lastIndex = useRef(0);
  // The selected item, or — when it just left the list — whatever now sits at its position.
  let index = items.findIndex((i) => i.key === selKey);
  if (index < 0) index = Math.min(lastIndex.current, items.length - 1);
  const sel = index >= 0 ? items[index] : null;
  lastIndex.current = Math.max(0, index);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sel && sel.key !== selKey) setSelKey(sel.key);
  }, [sel, selKey]);

  useEffect(() => {
    listRef.current?.querySelector('.inbox-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel?.key]);

  const state = useRef({ items, index, sel, actsFor, run });
  state.current = { items, index, sel, actsFor, run };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!keyIsOurs(e)) return;
      const { items, index, sel, actsFor, run } = state.current;
      const k = e.key === 'Enter' ? 'o' : e.key;
      if (k === 'j' || k === 'ArrowDown' || k === 'k' || k === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        const next = Math.max(0, Math.min(items.length - 1, index + (k === 'j' || k === 'ArrowDown' ? 1 : -1)));
        setSelKey(items[next].key);
        return;
      }
      if (!sel) return;
      const act = actsFor(sel).find((a) => a.key === k);
      if (!act) return;
      e.preventDefault();
      void run(sel.key, act);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!items.length) return <div className="inbox-empty">Nothing is waiting on you.</div>;
  return (
    <div className="inbox-desk" ref={listRef} role="list" aria-label="Waiting on you">
      {items.map((i) => {
        const on = i.key === sel?.key;
        return (
          <div
            key={i.key}
            className={`panel inbox-item${on ? ' sel' : ''}`}
            role="listitem"
            aria-current={on || undefined}
            onClick={() => setSelKey(i.key)}
          >
            <div className="inbox-item-head">
              <InboxRowHead item={i} />
            </div>
            {on && (
              <>
                <InboxDetail item={i} />
                {err?.key === i.key && <div className="warn-text inbox-err">{err.text}</div>}
                <div className="inbox-acts">
                  {actsFor(i).map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      className={`btn${a.tone === 'primary' ? ' primary' : a.tone === 'danger' ? ' danger' : ''}`}
                      disabled={a.disabled || busy !== null}
                      title={a.hint}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(i.key, a);
                      }}
                    >
                      {a.label} <kbd>{a.key}</kbd>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
