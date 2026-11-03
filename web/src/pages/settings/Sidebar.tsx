import { useEffect, useState } from 'react';
import { useIsMobile } from '../../components/Layout.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { IconChevron, IconX } from '../../components/Icons.tsx';
import {
  SearchResults,
  SectionPanel,
  SettingsPage,
  SettingsSearch,
  changedKeys,
  useSettingCtx,
} from '../../components/SettingsKit.tsx';
import { useSettingsForm, type SettingsForm } from '../../settingsForm.ts';
import {
  INTENTS,
  SETTINGS_SECTIONS,
  queryWords,
  settingsIn,
  type SectionId,
  type SettingCtx,
  type SettingsSection,
} from '../../settingsRegistry.tsx';

/**
 * Version A · Sidebar sections (docs/settings-versions.md § A). Desktop: a
 * rail of sections beside the page, following the scroll (scroll-spy); a
 * click jumps to the section. Phone: an iOS-Settings list of sections, each
 * opening as a sheet.
 */
export default function SidebarSettings() {
  const form = useSettingsForm();
  const ctx = useSettingCtx(form);
  const mobile = useIsMobile();
  const [q, setQ] = useState('');
  const words = queryWords(q);
  return (
    <SettingsPage id="sidebar" form={form}>
      {ctx &&
        (mobile ? (
          <PhoneList ctx={ctx} form={form} q={q} setQ={setQ} words={words} />
        ) : (
          <DesktopRail ctx={ctx} q={q} setQ={setQ} words={words} />
        ))}
    </SettingsPage>
  );
}

function badge(ctx: SettingCtx, sec: SettingsSection) {
  const n = changedKeys(ctx, settingsIn(sec.id)).length;
  return n ? <span className="cfg-count" title={`${n} changed from default`}>{n}</span> : null;
}

function DesktopRail({
  ctx,
  q,
  setQ,
  words,
}: {
  ctx: SettingCtx;
  q: string;
  setQ: (v: string) => void;
  words: string[];
}) {
  const [active, setActive] = useState<SectionId>(SETTINGS_SECTIONS[0].id);

  // Scroll-spy: the topmost section crossing the upper third of the viewport.
  useEffect(() => {
    if (words.length) return;
    const nodes = SETTINGS_SECTIONS.map((s) => document.getElementById(`cfg-sec-${s.id}`)).filter(
      (n): n is HTMLElement => !!n,
    );
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id.slice('cfg-sec-'.length) as SectionId);
      },
      { rootMargin: '0px 0px -66% 0px' },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [words.length]);

  const jump = (id: SectionId) => {
    setQ('');
    setActive(id);
    // after a search clears, the sections are back on the next frame
    requestAnimationFrame(() => document.getElementById(`cfg-sec-${id}`)?.scrollIntoView({ block: 'start' }));
  };

  return (
    <div className="cfg-split">
      <nav className="cfg-rail" aria-label="Settings sections">
        {INTENTS.map((intent) => {
          const secs = SETTINGS_SECTIONS.filter((s) => s.intent === intent.id);
          return (
            <div key={intent.id} className="cfg-rail-group">
              <div className="cfg-rail-head">{intent.label}</div>
              {secs.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`cfg-rail-item${!words.length && active === s.id ? ' active' : ''}`}
                  aria-current={!words.length && active === s.id ? 'true' : undefined}
                  onClick={() => jump(s.id)}
                >
                  <span>{s.title}</span>
                  {badge(ctx, s)}
                </button>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="cfg-split-body">
        <SettingsSearch value={q} onChange={setQ} />
        {words.length ? (
          <SearchResults ctx={ctx} words={words} />
        ) : (
          SETTINGS_SECTIONS.map((s) => (
            <section key={s.id} id={`cfg-sec-${s.id}`} className="cfg-anchor">
              <SectionPanel sec={s} ctx={ctx} rows={settingsIn(s.id)} />
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** A's phone layout, also the mix's (docs/settings-versions.md § Mix). */
export function PhoneList({
  ctx,
  form,
  q,
  setQ,
  words,
}: {
  ctx: SettingCtx;
  form: SettingsForm;
  q: string;
  setQ: (v: string) => void;
  words: string[];
}) {
  const [open, setOpen] = useState<SectionId | null>(null);
  const sec = open ? SETTINGS_SECTIONS.find((s) => s.id === open)! : null;
  return (
    <>
      <SettingsSearch value={q} onChange={setQ} />
      {words.length ? (
        <SearchResults ctx={ctx} words={words} />
      ) : (
        INTENTS.map((intent) => (
          <div key={intent.id} className="cfg-ios-group">
            <div className="cfg-ios-head">{intent.label}</div>
            <div className="panel cfg-ios-list">
              {SETTINGS_SECTIONS.filter((s) => s.intent === intent.id).map((s) => (
                <button key={s.id} type="button" className="cfg-ios-row" onClick={() => setOpen(s.id)}>
                  <span className="cfg-ios-text">
                    <span>{s.title}</span>
                    <span className="hint">{s.summary(ctx)}</span>
                  </span>
                  {badge(ctx, s)}
                  <span className="cfg-ios-chev" aria-hidden>
                    <IconChevron />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))
      )}
      {sec && (
        <Sheet
          label={sec.title}
          tall
          className="full-sheet"
          bodyClassName="full-sheet-body cfg-sheet-body"
          onClose={() => setOpen(null)}
          head={(close) => (
            <div className="full-sheet-head">
              <span className="full-sheet-title">{sec.title}</span>
              {form.hasChanges && (
                <button type="button" className="btn primary" onClick={form.save}>
                  {`Save (${form.dirty.size + (form.sentry.draft.trim() ? 1 : 0)})`}
                </button>
              )}
              <button type="button" className="btn ghost" aria-label="Close" onClick={close}>
                <IconX />
              </button>
            </div>
          )}
        >
          {form.saved && <div className="hint cfg-saved">Saved ✓</div>}
          {form.err && <div className="warn-text">{form.err}</div>}
          <SectionPanel sec={sec} ctx={ctx} rows={settingsIn(sec.id)} heading={false} />
        </Sheet>
      )}
    </>
  );
}
