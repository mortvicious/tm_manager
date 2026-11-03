/// <reference types="vite/client" />
// Board versions (docs/board-versions.md § Versions control): the frozen
// original Board plus alternative layouts, picked PER DEVICE under
// `tm.boardVersion` — read and written like `tm.design` in appearance.ts
// (this tab's pick survives blocked storage; other tabs follow the `storage`
// event). A version is a page component with the BoardPage props; it reads the
// same store slices, respects useWorkspace() and opens the ordinary task panel.
//
// Only implemented versions are listed. An unknown or unlisted stored value
// reads as `original`, so a device that picked a version a later build drops
// falls back without a migration.

import { lazy, useSyncExternalStore, type ComponentType } from 'react';

export type BoardVersionId = 'original' | 'stacks' | 'swimlanes' | 'relation-map' | 'metro';

export interface BoardVersionProps {
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
}

export interface BoardVersion {
  /** a `BoardVersionId`, or a dev-only `dev-*` id that a production build never lists */
  id: BoardVersionId | `dev-${string}`;
  label: string;
  /** lazy for every version but `original`, which BoardRoute mounts directly */
  component: ComponentType<BoardVersionProps> | null;
}

/**
 * THE list, in menu order. A version task adds its entry here, e.g.
 * `{ id: 'stacks', label: 'Stacks', component: lazy(() => import('./pages/board/Stacks.tsx')) }`
 * (the module's default export is the page).
 */
export const BOARD_VERSIONS: readonly BoardVersion[] = [
  { id: 'original', label: 'Original', component: null },
  { id: 'stacks', label: 'Stacks', component: lazy(() => import('./pages/board/Stacks.tsx')) },
  { id: 'swimlanes', label: 'Swimlanes', component: lazy(() => import('./pages/board/Swimlanes.tsx')) },
  { id: 'relation-map', label: 'Relation map', component: lazy(() => import('./pages/board/RelationMap.tsx')) },
  { id: 'metro', label: 'Metro', component: lazy(() => import('./pages/board/Metro.tsx')) },
  // A dev-only exercise of the focus layer; Vite drops the branch (and the
  // chunk) from a production build, so it is never listed there.
  ...(import.meta.env.DEV
    ? [
        {
          id: 'dev-focus' as const,
          label: 'Focus test (dev)',
          component: lazy(() => import('./pages/board/DevFocusBoard.tsx')),
        },
      ]
    : []),
];

const KEY = 'tm.boardVersion';
const ORIGINAL: BoardVersion = BOARD_VERSIONS[0];

let picked: string | null | undefined; // this tab's pick, survives blocked storage
function stored(): string | null {
  if (picked !== undefined) return picked;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function resolve(): BoardVersion {
  const id = stored();
  return BOARD_VERSIONS.find((v) => v.id === id) ?? ORIGINAL;
}

let current = resolve();
const listeners = new Set<() => void>();

function refresh() {
  const next = resolve();
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => fn());
}

export function setBoardVersion(id: BoardVersion['id']) {
  picked = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // private mode / blocked storage: this tab keeps the pick in memory
  }
  refresh();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The device's board version; never an unlisted one. */
export function useBoardVersion(): BoardVersion {
  return useSyncExternalStore(subscribe, () => current);
}

/** Whether there is anything to switch between; the Versions control hides otherwise. */
export const BOARD_VERSIONS_SWITCHABLE = BOARD_VERSIONS.length > 1;

window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== KEY) return;
  picked = undefined;
  refresh();
});
