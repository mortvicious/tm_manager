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
import { SETTINGS_SECTIONS, queryWords, settingsIn, type SectionId } from '../../settingsRegistry.tsx';

/**
 * Version B · Basic / Advanced (docs/settings-versions.md § B): one page that
 * shows only the everyday controls (descriptors without `advanced`), with a
 * "Show advanced" toggle per section. A section whose controls are all
 * advanced folds to its heading. Search always searches everything; a
 * section holding a key changed from default says so even while folded.
 */
export default function BasicSettings() {
  const form = useSettingsForm();
  const ctx = useSettingCtx(form);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState<ReadonlySet<SectionId>>(new Set());
  const words = queryWords(q);
  const flip = (id: SectionId) =>
    setShown((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <SettingsPage id="basic" form={form}>
      {ctx && (
        <>
          <SettingsSearch value={q} onChange={setQ} />
          {words.length ? (
            <SearchResults ctx={ctx} words={words} />
          ) : (
            SETTINGS_SECTIONS.map((sec) => {
              if (sec.device) return <SectionPanel key={sec.id} sec={sec} ctx={ctx} rows={[]} />;
              const all = settingsIn(sec.id);
              const advanced = all.filter((s) => s.advanced);
              const open = shown.has(sec.id);
              const rows = open ? all : all.filter((s) => !s.advanced);
              const hiddenChanged = open ? 0 : changedKeys(ctx, advanced).length;
              return (
                <SectionPanel
                  key={sec.id}
                  sec={{ ...sec, intro: rows.length ? sec.intro : undefined }}
                  ctx={ctx}
                  rows={rows}
                  footer={
                    advanced.length > 0 && (
                      <button
                        type="button"
                        className="btn ghost cfg-more"
                        aria-expanded={open}
                        onClick={() => flip(sec.id)}
                      >
                        {open
                          ? 'Hide advanced'
                          : `Show advanced (${advanced.length})${hiddenChanged ? ` · ${hiddenChanged} changed` : ''}`}
                      </button>
                    )
                  }
                />
              );
            })
          )}
        </>
      )}
    </SettingsPage>
  );
}
