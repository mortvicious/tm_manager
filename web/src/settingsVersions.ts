// Settings versions (docs/settings-versions.md § Registry): the frozen
// original Config page plus alternative layouts, picked PER DEVICE under
// `tm.settingsVersion` — the twin of boardVersions.ts (this tab's pick
// survives blocked storage; other tabs follow the `storage` event). Every
// version reads and writes through useSettingsForm() and renders its controls
// from settingsRegistry.tsx.
//
// An unknown or unlisted stored value reads as `original`, so a device that
// picked a version a later build drops falls back without a migration.

import { lazy, useSyncExternalStore, type ComponentType } from 'react';

export type SettingsVersionId = 'original' | 'mix' | 'sidebar' | 'basic' | 'tabs' | 'palette' | 'cards';

export interface SettingsVersion {
  id: SettingsVersionId;
  label: string;
  /** lazy for every version but `original`, which ConfigRoute mounts directly */
  component: ComponentType | null;
}

/** THE list, in menu order; each module's default export is the page. */
export const SETTINGS_VERSIONS: readonly SettingsVersion[] = [
  { id: 'original', label: 'Original', component: null },
  // the user's pick (docs/settings-versions.md § Decision): A on a phone, E + A + C on desktop
  { id: 'mix', label: 'Picked · cards + rail + intents', component: lazy(() => import('./pages/settings/Mixed.tsx')) },
  { id: 'sidebar', label: 'A · Sidebar sections', component: lazy(() => import('./pages/settings/Sidebar.tsx')) },
  { id: 'basic', label: 'B · Basic / Advanced', component: lazy(() => import('./pages/settings/Basic.tsx')) },
  { id: 'tabs', label: 'C · Tabs by intent', component: lazy(() => import('./pages/settings/Tabs.tsx')) },
  { id: 'palette', label: 'D · Search first', component: lazy(() => import('./pages/settings/Palette.tsx')) },
  { id: 'cards', label: 'E · Summary cards', component: lazy(() => import('./pages/settings/Cards.tsx')) },
];

const KEY = 'tm.settingsVersion';
const ORIGINAL: SettingsVersion = SETTINGS_VERSIONS[0];

let picked: string | null | undefined; // this tab's pick, survives blocked storage
function stored(): string | null {
  if (picked !== undefined) return picked;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function resolve(): SettingsVersion {
  const id = stored();
  return SETTINGS_VERSIONS.find((v) => v.id === id) ?? ORIGINAL;
}

let current = resolve();
const listeners = new Set<() => void>();

function refresh() {
  const next = resolve();
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => fn());
}

export function setSettingsVersion(id: SettingsVersionId) {
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

/** The device's settings version; never an unlisted one. */
export function useSettingsVersion(): SettingsVersion {
  return useSyncExternalStore(subscribe, () => current);
}

/** Whether there is anything to switch between; the Versions control hides otherwise. */
export const SETTINGS_VERSIONS_SWITCHABLE = SETTINGS_VERSIONS.length > 1;

window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== KEY) return;
  picked = undefined;
  refresh();
});
