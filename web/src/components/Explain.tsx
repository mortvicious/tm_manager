import { useState, type MouseEvent, type ReactNode } from 'react';
import { useIsMobile } from './Layout.tsx';
import { Sheet, SheetAction } from './Sheet.tsx';

/**
 * Tap-to-explain (docs/mobile.md § Tap to explain). A desktop explains a badge
 * or a chip in a hover tooltip; a phone cannot hover, so the same text opens in
 * a small sheet when the thing is tapped. `what` says what is happening, `todo`
 * what the human can do about it. Both are the strings the tooltip shows.
 */
export interface Explanation {
  title: string;
  what: string;
  todo?: string;
}

/** the one-line tooltip a desktop shows for an explanation */
export function explainTitle(e: Explanation): string {
  return e.todo ? `${e.what} — ${e.todo}` : e.what;
}

/** above every other sheet: it is opened FROM them (the task sheet, the Inbox) */
const EXPLAIN_Z = 38;

export function ExplainSheet({
  explain,
  lead,
  action,
  onClose,
}: {
  explain: Explanation;
  /** the badge or chip itself, repeated at the top so the sheet says what it explains */
  lead?: ReactNode;
  /** the one thing the explained control did on a desktop click (open the reviewer…) */
  action?: { label: string; run: () => void };
  onClose: () => void;
}) {
  return (
    <Sheet label={explain.title} onClose={onClose} zIndex={EXPLAIN_Z}>
      <div className="explain">
        {lead && <div className="explain-lead">{lead}</div>}
        <p className="explain-what">{explain.what}</p>
        {explain.todo && <p className="explain-todo">{explain.todo}</p>}
      </div>
      {action && (
        <div className="explain-acts">
          <SheetAction
            label={action.label}
            tone="primary"
            onClick={() => {
              onClose();
              action.run();
            }}
          />
        </div>
      )}
    </Sheet>
  );
}

/**
 * A span with a tooltip on a desktop; on a phone a button that opens the
 * explanation instead of letting the tap fall through to the row under it.
 * `off` (a row in select mode) gives the tap back to the row.
 */
export function Explainable({
  explain,
  className,
  children,
  off = false,
  lead,
}: {
  explain: Explanation;
  className: string;
  children: ReactNode;
  off?: boolean;
  /** what heads the sheet; the control itself when unset */
  lead?: ReactNode;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  if (!mobile || off) {
    return (
      <span className={className} title={explainTitle(explain)}>
        {children}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`${className} explain-tap`}
        aria-label={`${explain.title} — what does this mean?`}
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {children}
      </button>
      {open && <ExplainSheet explain={explain} lead={lead ?? <span className={className}>{children}</span>} onClose={() => setOpen(false)} />}
    </>
  );
}
