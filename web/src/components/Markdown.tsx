import { useMemo, useState } from 'react';
import { Marked, marked } from 'marked';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * For files from a shared space folder (docs/shared-spaces.md): anything may
 * have been copied in there, so raw HTML is shown as text and only
 * http(s)/relative/anchor/mailto links stay links.
 */
const safeMarked = new Marked({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:|#|\/|\.{0,2}\/|[\w.-]+(\/|$))/i.test(href)) return inner;
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} rel="noreferrer noopener" target="_blank">${inner}</a>`;
    },
  },
});

/** A markdown block with a Rendered ⇄ Raw toggle. Content is trusted
 *  (agent output from our own server), so raw HTML from marked is fine here —
 *  except with `safe`, for text read from a folder on disk. */
export function Markdown({ label, text, safe = false }: { label: string; text: string; safe?: boolean }) {
  const [raw, setRaw] = useState(false);
  const html = useMemo(
    () => (raw ? '' : ((safe ? safeMarked : marked).parse(text, { async: false }) as string)),
    [text, raw, safe],
  );
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
