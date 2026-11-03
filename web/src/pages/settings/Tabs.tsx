import { useState } from 'react';
import {
  SearchResults,
  SectionPanel,
  SettingsPage,
  SettingsSearch,
  changedKeys,
  useSettingCtx,
} from '../../components/SettingsKit.tsx';
import { useSettingsForm } from '../../settingsForm.ts';
import {
  INTENTS,
  SETTINGS,
  SETTINGS_SECTIONS,
  intentOf,
  queryWords,
  type Intent,
} from '../../settingsRegistry.tsx';

const TAB_KEY = 'tm.settingsTab';

function storedTab(): Intent {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return INTENTS.some((i) => i.id === v) ? (v as Intent) : 'agents';
  } catch {
    return 'agents';
  }
}

/**
 * Version C · Tabs by intent (docs/settings-versions.md § C): Running agents ·
 * Notifications & alerts · Look & feel · Content · Integrations. A section's
 * controls follow their own intent (the anomaly alerts sit with
 * notifications), so one section can appear, split, under two tabs. Search
 * leaves the tabs and searches everything.
 */
export default function TabsSettings() {
  const form = useSettingsForm();
  const ctx = useSettingCtx(form);
  const [q, setQ] = useState('');
  const [tab, setTabState] = useState<Intent>(storedTab);
  const words = queryWords(q);
  const setTab = (t: Intent) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // the tab is a convenience
    }
  };
  return (
    <SettingsPage id="tabs" form={form}>
      {ctx && (
        <>
          <SettingsSearch value={q} onChange={setQ} />
          {!words.length && (
            <div className="cfg-tabs" role="tablist" aria-label="Settings">
              {INTENTS.map((i) => {
                const n = changedKeys(
                  ctx,
                  SETTINGS.filter((s) => intentOf(s) === i.id),
                ).length;
                return (
                  <button
                    key={i.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === i.id}
                    className={`cfg-tab${tab === i.id ? ' active' : ''}`}
                    onClick={() => setTab(i.id)}
                  >
                    {i.label}
                    {n > 0 && <span className="cfg-count">{n}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {words.length ? (
            <SearchResults ctx={ctx} words={words} />
          ) : (
            <div role="tabpanel">
              {SETTINGS_SECTIONS.map((sec) => {
                if (sec.device) return sec.intent === tab ? <SectionPanel key={sec.id} sec={sec} ctx={ctx} rows={[]} /> : null;
                const rows = SETTINGS.filter((s) => s.section === sec.id && intentOf(s) === tab);
                if (!rows.length) return null;
                return (
                  <SectionPanel
                    key={sec.id}
                    sec={sec.intent === tab ? sec : { ...sec, intro: undefined }}
                    ctx={ctx}
                    rows={rows}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </SettingsPage>
  );
}
