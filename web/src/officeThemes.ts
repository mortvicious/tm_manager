// Office skins (docs/office.md § The view): a registry over ONE pure layout
// (`layoutOffice` in shared). Every skin is a component that draws the same
// `OfficeLayout` — rooms, desks, avatars, hand-off edges — in its own dress; the
// card, the feed and the data live outside it (OfficePlace), so a skin never
// fetches or decides anything.
//
// Which skin: the DEVICE's pick (`tm.officeTheme`, read and written like
// `tm.boardVersion`) when it names a listed skin, else the office's own
// `Office.theme` when listed, else the default (the first entry). Only
// implemented skins are listed, so an office themed `fantasy-guild` renders the
// default until that skin ships — no migration either way.
//
// The /office page's list/place switch (`tm.officeView`) is kept here too: the
// place is the default, the phase-2 list stays one tap away.

import { lazy, useSyncExternalStore, type ComponentType } from 'react';
import type { OfficeLayout, OfficeThemeId } from '@tm/shared';

export interface OfficeSkinProps {
  layout: OfficeLayout;
  mobile: boolean;
  /** the avatar whose card is open */
  selectedRoleId: string | null;
  /** a feed item's roles / edge, lit while it is selected */
  highlight: { roleIds: ReadonlySet<string>; edgeId: string | null } | null;
  onAvatar: (roleId: string) => void;
}

export interface OfficeSkin {
  id: OfficeThemeId;
  label: string;
  component: ComponentType<OfficeSkinProps>;
}

/**
 * THE list, in menu order; the first entry is the default. A skin task adds
 * its entry here, e.g.
 * `{ id: 'starship-bridge', label: 'Starship bridge', component: lazy(() => import('./pages/office/skins/StarshipBridge.tsx')) }`.
 */
export const OFFICE_THEMES: readonly OfficeSkin[] = [
  { id: 'pixel-office', label: 'Pixel office', component: lazy(() => import('./pages/office/skins/PixelOffice.tsx')) },
];

export const DEFAULT_OFFICE_SKIN: OfficeSkin = OFFICE_THEMES[0];

/** Whether there is a skin to switch to; the picker hides otherwise. */
export const OFFICE_THEMES_SWITCHABLE = OFFICE_THEMES.length > 1;

/** Pure: the device pick, else the office's theme, else the default — never an unlisted skin. */
export function resolveOfficeSkin(devicePick: string | null | undefined, officeTheme: string | null | undefined): OfficeSkin {
  return OFFICE_THEMES.find((s) => s.id === devicePick) ?? OFFICE_THEMES.find((s) => s.id === officeTheme) ?? DEFAULT_OFFICE_SKIN;
}

// ---- a per-device localStorage value with a same-tab fallback ----------------

function deviceValue(key: string) {
  let picked: string | null | undefined; // this tab's pick, survives blocked storage
  const listeners = new Set<() => void>();
  const read = (): string | null => {
    if (picked !== undefined) return picked;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  let current = read();
  const refresh = () => {
    const next = read();
    if (next === current) return;
    current = next;
    listeners.forEach((fn) => fn());
  };
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== key) return;
    picked = undefined;
    refresh();
  });
  return {
    get: () => current,
    set(v: string | null) {
      picked = v;
      try {
        if (v === null) localStorage.removeItem(key);
        else localStorage.setItem(key, v);
      } catch {
        // private mode / blocked storage: this tab keeps the pick in memory
      }
      refresh();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

const themePick = deviceValue('tm.officeTheme');
const viewPick = deviceValue('tm.officeView');

/** The skin to draw for an office with `officeTheme`. */
export function useOfficeSkin(officeTheme: string | null | undefined): OfficeSkin {
  const pick = useSyncExternalStore(themePick.subscribe, themePick.get);
  return resolveOfficeSkin(pick, officeTheme);
}

/** The device's raw pick (null = follow the office). */
export function useOfficeThemePick(): string | null {
  return useSyncExternalStore(themePick.subscribe, themePick.get);
}

/** Pick a skin for this device; null follows the office's theme again. */
export function setOfficeThemePick(id: OfficeThemeId | null): void {
  themePick.set(id);
}

export type OfficeViewMode = 'place' | 'list';

/** The /office page's view: the place (default) or the role list. */
export function useOfficeViewMode(): [OfficeViewMode, (m: OfficeViewMode) => void] {
  const v = useSyncExternalStore(viewPick.subscribe, viewPick.get);
  return [v === 'list' ? 'list' : 'place', (m) => viewPick.set(m)];
}
