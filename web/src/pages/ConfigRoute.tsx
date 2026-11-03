import { Suspense } from 'react';
import { SettingsVersionsControl, SettingsVersionsSetting } from '../components/SettingsKit.tsx';
import { useSettingsVersion } from '../settingsVersions.ts';
import { ConfigPage } from './Config.tsx';

/**
 * The /config route (docs/settings-versions.md § Registry): the frozen
 * original Config page for `original` — with the Versions control in its head
 * (desktop) or at its top (phone) — and the device's chosen version otherwise.
 */
export function ConfigRoute() {
  const version = useSettingsVersion();
  const Version = version.component;
  if (!Version) return <ConfigPage headSlot={<SettingsVersionsControl />} topSlot={<SettingsVersionsSetting />} />;
  return (
    <Suspense fallback={<div className="cfg-page" aria-busy="true" />}>
      <Version />
    </Suspense>
  );
}
