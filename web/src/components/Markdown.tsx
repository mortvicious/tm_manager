import { useMemo, useState } from 'react';
import { marked } from 'marked';

/** A markdown block with a Rendered ⇄ Raw toggle. Content is trusted
 *  (agent output from our own server), so raw HTML from marked is fine here. */
export function Markdown({ label, text }: { label: string; text: string }) {
  const [raw, setRaw] = useState(false);
  const html = useMemo(() => (raw ? '' : (marked.parse(text, { async: false }) as string)), [text, raw]);
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <div className="label" style={{ margin: 0 }}>{label}</div>
        <span style={{ flex: 1 }} />
        <button
          className="btn ghost"
          style={{ padding: '1px 9px', fontSize: 'var(--tm-text-xs)' }}
          onClick={() => setRaw((r) => !r)}
          title={raw ? 'show rendered markdown' : 'show raw markdown'}
        >
          {raw ? 'Rendered' : 'Raw'}
        </button>
      </div>
      {raw ? (
        <pre
          className="mono"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontSize: 'var(--tm-text-xs)' }}
        >
          {text}
        </pre>
      ) : (
        <div className="handbook" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
