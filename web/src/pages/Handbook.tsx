import { useEffect, useState } from 'react';
import { marked } from 'marked';

export function HandbookPage() {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/handbook')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => setHtml(marked.parse(j.markdown, { async: false }) as string))
      .catch((e) => setErr(`Could not load the handbook (${e.message}).`));
  }, []);

  if (err) return <div className="warn-text">{err}</div>;
  if (html === null) return <div className="muted">Loading…</div>;
  // Trusted content: served from our own docs/handbook.md, never user input.
  return (
    <div className="handbook">
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
