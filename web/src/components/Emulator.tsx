import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.tsx';
import { IconExternal, IconPhone, IconRefresh, IconX } from './Icons.tsx';

/** Mobile only, on purpose: the browser tab already IS the desktop viewport —
 *  what a worker's change can't be checked against without switching tabs is
 *  the phone one. Desktop/tablet presets can join this list later. */
const DEVICES = [
  { id: 'iphone-se', label: 'iPhone SE', w: 375, h: 667 },
  { id: 'iphone-14', label: 'iPhone 14', w: 390, h: 844 },
  { id: 'iphone-max', label: 'iPhone 14 Max', w: 430, h: 932 },
  { id: 'pixel-7', label: 'Pixel 7', w: 412, h: 915 },
  { id: 'galaxy-s8', label: 'Galaxy S8', w: 360, h: 740 },
] as const;

const ZOOMS = [1, 0.9, 0.8, 0.67, 0.5];
const DEFAULT_DEVICE = 'iphone-14';
const STORE_KEY = 'tm.emulator';
const MARGIN = 8;

interface Persisted {
  open: boolean;
  repoId: string | null;
  deviceId: string;
  zoom: number;
  path: string;
  x: number | null;
  y: number | null;
}

const BLANK: Persisted = { open: false, repoId: null, deviceId: DEFAULT_DEVICE, zoom: 1, path: '/', x: null, y: null };

function loadState(): Persisted {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return BLANK;
    const v = JSON.parse(raw) as Partial<Persisted>;
    return {
      open: v.open === true,
      repoId: typeof v.repoId === 'string' ? v.repoId : null,
      // an id/zoom written by an older build must not wedge the window
      deviceId: DEVICES.some((d) => d.id === v.deviceId) ? (v.deviceId as string) : DEFAULT_DEVICE,
      zoom: typeof v.zoom === 'number' && ZOOMS.includes(v.zoom) ? v.zoom : 1,
      path: typeof v.path === 'string' ? v.path : '/',
      x: typeof v.x === 'number' && Number.isFinite(v.x) ? v.x : null,
      y: typeof v.y === 'number' && Number.isFinite(v.y) ? v.y : null,
    };
  } catch {
    return BLANK;
  }
}

/** Same scheme pin as the server's `normalizePreviewUrl` — an iframe `src` is
 *  never built from a stored string without re-checking it here (a row could
 *  predate the validation, or have been edited straight in the DB). */
function frameSrc(base: string | null, path: string): string | null {
  if (!base) return null;
  try {
    const u = new URL(path.trim() || '/', base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Header button + the floating window it owns. Self-contained so the Layout
 *  header only has to render one element. */
export function EmulatorLauncher() {
  const [open, setOpen] = useState(() => loadState().open);
  const persistOpen = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadState(), open: next }));
    } catch {
      /* private mode / quota — the window still works, it just won't reopen */
    }
  };
  return (
    <>
      <button
        className={`btn ghost ${open ? 'on' : ''}`}
        title="Mobile emulator — frame a repo's dev server in a floating phone window"
        aria-pressed={open}
        onClick={() => persistOpen(!open)}
      >
        <IconPhone />
      </button>
      {open && <EmulatorWindow onClose={() => persistOpen(false)} />}
    </>
  );
}

function EmulatorWindow({ onClose }: { onClose: () => void }) {
  const { repos } = useApp();
  // read once, lazily — loadState() touches localStorage
  const initialRef = useRef<Persisted | null>(null);
  if (initialRef.current === null) initialRef.current = loadState();
  const initial = initialRef.current;

  const previewable = useMemo(() => repos.filter((r) => !!r.previewUrl), [repos]);
  const [repoId, setRepoId] = useState<string | null>(initial.repoId);
  const [deviceId, setDeviceId] = useState<string>(initial.deviceId);
  const [zoom, setZoom] = useState<number>(initial.zoom);
  const [path, setPath] = useState<string>(initial.path);
  const [pathDraft, setPathDraft] = useState<string>(initial.path);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(
    initial.x !== null && initial.y !== null ? { x: initial.x, y: initial.y } : null,
  );
  const [nonce, setNonce] = useState(0);
  const [dragging, setDragging] = useState(false);

  const winRef = useRef<HTMLDivElement | null>(null);
  const dragOff = useRef<{ dx: number; dy: number } | null>(null);
  // read inside layout effects that must not re-run when the zoom changes
  const zoomRef = useRef(zoom);

  const device = DEVICES.find((d) => d.id === deviceId) ?? DEVICES.find((d) => d.id === DEFAULT_DEVICE)!;
  const repo = previewable.find((r) => r.id === repoId) ?? null;
  const src = frameSrc(repo?.previewUrl ?? null, path);

  // The remembered repo can lose its preview URL (or be deleted) while the
  // window is shut — fall back to whatever is previewable rather than blanking.
  useEffect(() => {
    if (previewable.length === 0) return;
    if (previewable.some((r) => r.id === repoId)) return;
    setRepoId(previewable[0].id);
    // a path from the previous repo means nothing on this one
    setPath('/');
    setPathDraft('/');
  }, [previewable, repoId]);

  const clamp = useCallback((x: number, y: number) => {
    const el = winRef.current;
    const w = el?.offsetWidth ?? 420;
    const h = el?.offsetHeight ?? 500;
    // Max() keeps the min bound winning when the window is bigger than the
    // viewport — otherwise a tall phone at 100% would clamp to a negative x.
    const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
    return { x: Math.min(Math.max(x, MARGIN), maxX), y: Math.min(Math.max(y, MARGIN), maxY) };
  }, []);

  // Declared BEFORE the auto-fit effect so the ref is current when it reads it.
  useLayoutEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // A 932px phone at 100% is taller than most laptop viewports, so on open (and
  // whenever the device changes) shrink to the largest preset that fits. Only
  // ever shrinks: an explicit zoom choice is never overridden.
  useLayoutEffect(() => {
    const el = winRef.current;
    if (!el) return;
    const chrome = el.offsetHeight - Math.round(device.h * zoomRef.current);
    const avail = window.innerHeight - chrome - 2 * MARGIN;
    const fits = ZOOMS.find((z) => device.h * z <= avail) ?? ZOOMS[ZOOMS.length - 1];
    if (fits < zoomRef.current) setZoom(fits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // First paint: park it at the right edge under the header (or re-clamp the
  // remembered spot, which may be off-screen on a smaller display now).
  useLayoutEffect(() => {
    setPos((p) => {
      const el = winRef.current;
      const w = el?.offsetWidth ?? 420;
      return clamp(p?.x ?? window.innerWidth - w - 24, p?.y ?? 72);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Size changes with device/zoom, so the position may need pulling back in.
  useLayoutEffect(() => {
    setPos((p) => (p ? clamp(p.x, p.y) : p));
  }, [deviceId, zoom, clamp]);

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ open: true, repoId, deviceId, zoom, path, x: pos?.x ?? null, y: pos?.y ?? null } satisfies Persisted),
      );
    } catch {
      /* ignore */
    }
  }, [repoId, deviceId, zoom, path, pos]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Controls in the bar keep their own click behaviour.
    if ((e.target as HTMLElement).closest('button, select, input, a')) return;
    const rect = winRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOff.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const off = dragOff.current;
    if (!off) return;
    setPos(clamp(e.clientX - off.dx, e.clientY - off.dy));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragOff.current) return;
    dragOff.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const commitPath = () => {
    const next = pathDraft.trim() || '/';
    setPathDraft(next);
    // Same path re-submitted = "reload", which is what pressing Enter means.
    if (next === path) setNonce((n) => n + 1);
    else setPath(next);
  };

  const selectRepo = (id: string) => {
    setRepoId(id);
    setPath('/');
    setPathDraft('/');
  };

  const bodyW = Math.round(device.w * zoom);
  const bodyH = Math.round(device.h * zoom);

  return (
    <div
      ref={winRef}
      className="emu"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label="Mobile emulator"
    >
      <div
        className={`emu-head ${dragging ? 'dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="emu-grip" aria-hidden="true">
          <IconPhone />
        </span>
        <select
          className="field emu-select grow"
          value={repo?.id ?? ''}
          disabled={previewable.length === 0}
          onChange={(e) => selectRepo(e.target.value)}
          title="Repo whose dev server is framed"
        >
          {previewable.length === 0 && <option value="">no preview URL set</option>}
          {previewable.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button className="btn ghost" title="Close emulator" onClick={onClose}>
          <IconX />
        </button>
      </div>

      <div
        className="emu-bar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <input
          className="field mono emu-path"
          value={pathDraft}
          placeholder="/"
          spellCheck={false}
          title="Path to load (the frame is cross-origin, so this is where it was SENT, not where it navigated to)"
          onChange={(e) => setPathDraft(e.target.value)}
          onBlur={commitPath}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitPath();
            if (e.key === 'Escape') setPathDraft(path);
          }}
        />
        <select
          className="field emu-select"
          value={device.id}
          onChange={(e) => setDeviceId(e.target.value)}
          title="Device viewport"
        >
          {DEVICES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <select
          className="field emu-select"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          title="Scale the phone down to fit — the page still renders at the device width"
        >
          {ZOOMS.map((z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>
        <button className="btn ghost" title="Reload the frame" disabled={!src} onClick={() => setNonce((n) => n + 1)}>
          <IconRefresh />
        </button>
        <a
          className={`btn ghost ${src ? '' : 'disabled'}`}
          href={src ?? undefined}
          target="_blank"
          rel="noreferrer"
          title="Open in a new tab"
          onClick={(e) => {
            if (!src) e.preventDefault();
          }}
        >
          <IconExternal />
        </a>
      </div>

      <div className="emu-body" style={{ width: bodyW, height: bodyH }}>
        {src ? (
          <iframe
            key={`${src}#${nonce}`}
            className="emu-frame"
            src={src}
            title="Mobile preview"
            style={{
              width: device.w,
              height: device.h,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              // A drag must not be swallowed by the framed page.
              pointerEvents: dragging ? 'none' : 'auto',
            }}
          />
        ) : (
          <div className="emu-empty">
            <div>
              {previewable.length === 0 ? (
                <>
                  No repo has a preview URL. Set one on the <b>Repos</b> page (e.g.{' '}
                  <span className="mono">localhost:5173</span>) and it shows up here.
                </>
              ) : (
                <>That preview URL can't be framed — it must be an http(s) address.</>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="emu-foot mono" title={src ?? undefined}>
        <span className="emu-url">{src ?? '—'}</span>
        <span className="emu-dims">
          {device.w}×{device.h}
        </span>
      </div>
    </div>
  );
}
