import { useState } from 'react';
import { useIsMobile } from '../../components/Layout.tsx';
import {
  SearchResults,
  SectionPanel,
  SettingRow,
  SettingsPage,
  SettingsSearch,
  changedKeys,
  useSettingCtx,
} from '../../components/SettingsKit.tsx';
import { useSettingsForm } from '../../settingsForm.ts';
import {
  SETTINGS,
  SETTINGS_SECTIONS,
  queryWords,
  sectionById,
  settingsIn,
  type SectionId,
  type SettingCtx,
  type SettingDescriptor,
} from '../../settingsRegistry.tsx';

function List({ title, rows, ctx, empty }: { title: string; rows: SettingDescriptor[]; ctx: SettingCtx; empty?: string }) {
  return (
    <div className="panel cfg-group">
      <h3>{title}</h3>
      {rows.length ? (
        rows.map((s) => (
          <div key={s.key} className="cfg-found">
            <div className="hint cfg-found-sec">{sectionById(s.section).title}</div>
            <SettingRow s={s} ctx={ctx} showKey />
          </div>
        ))
      ) : (
        <div className="hint">{empty}</div>
      )}
    </div>
  );
}

/**
 * Version D · Search first (docs/settings-versions.md § D): the page is the
 * search box. Empty, it lists what is edited, what this device changed
 * recently and every key changed from default, plus one chip per section to
 * browse; each control renders inline wherever it is listed.
 */
export default function PaletteSettings() {
  const form = useSettingsForm();
  const ctx = useSettingCtx(form);
  const mobile = useIsMobile();
  const [q, setQ] = useState('');
  const [browse, setBrowse] = useState<SectionId | null>(null);
  const words = queryWords(q);
  const byKey = (keys: readonly string[]) =>
    keys.flatMap((k) => SETTINGS.filter((s) => s.key === k));
  return (
    <SettingsPage id="palette" form={form}>
      {ctx && (
        <>
          <SettingsSearch
            big
            value={q}
            onChange={(v) => {
              setQ(v);
              setBrowse(null);
            }}
            autoFocus={!mobile}
          />
          <div className="cfg-chips" role="group" aria-label="Browse a section">
            {SETTINGS_SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={browse === s.id}
                className={`btn${browse === s.id ? ' primary' : ''}`}
                onClick={() => {
                  setQ('');
                  setBrowse(browse === s.id ? null : s.id);
                }}
              >
                {s.title}
              </button>
            ))}
          </div>
          {words.length ? (
            <SearchResults ctx={ctx} words={words} />
          ) : browse ? (
            <SectionPanel sec={sectionById(browse)} ctx={ctx} rows={settingsIn(browse)} />
          ) : (
            <>
              {form.dirty.size > 0 && <List title="Edited, not saved" rows={byKey([...form.dirty])} ctx={ctx} />}
              <List
                title="Recently changed"
                rows={byKey(form.recent.filter((k) => !form.dirty.has(k)))}
                ctx={ctx}
                empty="nothing saved from this device yet"
              />
              <List
                title="Changed from default"
                rows={byKey(changedKeys(ctx, SETTINGS))}
                ctx={ctx}
                empty="every setting is at its default"
              />
            </>
          )}
        </>
      )}
    </SettingsPage>
  );
}
