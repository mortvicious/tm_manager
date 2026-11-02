import { useEffect, useRef, useState } from 'react';
import { IconX } from './Icons.tsx';

/**
 * Files picked for a task that does not exist yet (the New task dialog,
 * docs/design.md § Attached files). They are held in memory and uploaded to
 * `POST /api/tasks/:id/files` right after the create, before the task is
 * queued or run, so a fresh agent finds them in `$TM_ARTIFACTS_DIR` and its
 * prompt names them. The panel's Files section is the same store afterwards.
 */

/** The server's multipart limits (server/src/index.ts): 10 files, 25 MB each. */
export const ATTACH_MAX_FILES = 10;
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * `prev` plus what was dropped/picked/pasted: an exact duplicate (name, size,
 * mtime) is ignored, an oversized file or one past the count is refused with a
 * readable reason — the rest still go in.
 */
export function mergeAttachments(prev: File[], incoming: File[]): { files: File[]; error: string | null } {
  const files = [...prev];
  const refused: string[] = [];
  for (const f of incoming) {
    if (files.some((p) => p.name === f.name && p.size === f.size && p.lastModified === f.lastModified)) continue;
    if (f.size > ATTACH_MAX_BYTES) refused.push(`${f.name} is over ${fmtBytes(ATTACH_MAX_BYTES)}`);
    else if (files.length >= ATTACH_MAX_FILES) refused.push(`${f.name}: at most ${ATTACH_MAX_FILES} files`);
    else files.push(f);
  }
  return { files, error: refused.length ? refused.join(' · ') : null };
}

/**
 * The files a paste carries — only a paste with no text in it (a screenshot,
 * a copied image), so pasting rich text that happens to ship a picture of
 * itself (a spreadsheet's cells) still pastes the text. A clipboard image is
 * always called "image.png", so it gets a time-stamped name instead.
 */
export function pastedFiles(data: DataTransfer | null): File[] {
  if (!data || data.files.length === 0 || data.types.includes('text/plain')) return [];
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
  return [...data.files].map((f, i) => {
    if (!/^image\.\w+$/.test(f.name)) return f;
    const ext = f.name.split('.').pop();
    return new File([f], `pasted-${stamp}${i ? `-${i + 1}` : ''}.${ext}`, { type: f.type, lastModified: f.lastModified });
  });
}

function Thumb({ file }: { file: File }) {
  // an object URL per image, made and revoked by the same effect (StrictMode
  // re-runs it, so a memoised URL would be revoked under the <img>)
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) {
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.slice(0, 4) : 'file';
    return (
      <span className="att-thumb att-ext mono" aria-hidden="true">
        {ext}
      </span>
    );
  }
  return (
    <span className="att-thumb" aria-hidden="true">
      <img src={url} alt="" />
    </span>
  );
}

export function AttachFiles({
  files,
  error,
  onAdd,
  onRemove,
  compact = false,
}: {
  files: File[];
  error: string | null;
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
  /** a phone: the picker is a button, there is nothing to drop from */
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = () => input.current?.click();
  const full = files.length >= ATTACH_MAX_FILES;
  return (
    <div className="att">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onAdd([...(e.target.files ?? [])]);
          // the same file picked again after a remove must fire again
          e.target.value = '';
        }}
      />
      {files.length > 0 && (
        <ul className="att-list">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${f.lastModified}`} className="att-item" title={`${f.name} · ${fmtBytes(f.size)}`}>
              <Thumb file={f} />
              <span className="att-name">{f.name}</span>
              <span className="att-size mono">{fmtBytes(f.size)}</span>
              <button type="button" className="att-remove" aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)}>
                <IconX />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <button
          type="button"
          className={`att-drop${over ? ' over' : ''}${files.length ? ' slim' : ''}`}
          onClick={pick}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            // the dialog-wide drop target must not add the same files again
            e.stopPropagation();
            setOver(false);
            onAdd([...e.dataTransfer.files]);
          }}
        >
          <span className="att-plus" aria-hidden="true">
            +
          </span>
          {compact ? (
            <span>Attach files or photos</span>
          ) : (
            <span>
              {files.length ? 'Add more' : 'Attach files'} — drop here, <u>browse</u>, or paste a screenshot into the
              description
            </span>
          )}
        </button>
      )}
      {error && <div className="warn-text att-err">{error}</div>}
    </div>
  );
}
