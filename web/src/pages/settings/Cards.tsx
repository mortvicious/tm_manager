import { useState } from 'react';
import {
  SearchResults,
  SectionCard,
  SettingsPage,
  SettingsSearch,
  useSettingCtx,
} from '../../components/SettingsKit.tsx';
import { useSettingsForm } from '../../settingsForm.ts';
import { SETTINGS_SECTIONS, queryWords, type SectionId } from '../../settingsRegistry.tsx';

/**
 * Version E · Summary cards (docs/settings-versions.md § E): every section is
 * a collapsed card whose one line is its current value ("Opus 5.5 xhigh ·
 * auto"); a card expands in place to edit, several may be open at once.
 */
export default function CardsSettings() {
  const form = useSettingsForm();
  const ctx = useSettingCtx(form);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<ReadonlySet<SectionId>>(new Set());
  const words = queryWords(q);
  const flip = (id: SectionId) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <SettingsPage id="cards" form={form}>
      {ctx && (
        <>
          <SettingsSearch value={q} onChange={setQ} />
          {words.length ? (
            <SearchResults ctx={ctx} words={words} />
          ) : (
            <div className="cfg-cards">
              {SETTINGS_SECTIONS.map((sec) => (
                <SectionCard key={sec.id} sec={sec} ctx={ctx} open={open.has(sec.id)} onToggle={() => flip(sec.id)} />
              ))}
            </div>
          )}
        </>
      )}
    </SettingsPage>
  );
}
