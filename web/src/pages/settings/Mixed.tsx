import { useEffect, useState } from 'react';
import { useIsMobile } from '../../components/Layout.tsx';
import {
  SearchResults,
  SectionCard,
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
  type SectionId,
  type SettingCtx,
  type SettingDescriptor,
  type SettingsSection,
} from '../../settingsRegistry.tsx';
import { PhoneList } from './Sidebar.tsx';

const TAB_KEY = 'tm.settingsMixTab';

function storedTab(): Intent {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return INTENTS.some((i) => i.id === v) ? (v as Intent) : 'agents';
  } catch {
    return 'agents';
  }
}

/** The sections an intent shows, each narrowed to its rows of that intent (C's split). */
function sectionsOf(intent: Intent): { sec: SettingsSection; rows: SettingDescriptor[] }[] {
  return SETTINGS_SECTIONS.flatMap((sec) => {
    if (sec.device) return sec.intent === intent ? [{ sec, rows: [] }] : [];
    const rows = SETTINGS.filter((s) => s.section === sec.id && intentOf(s) === intent);
    return rows.length ? [{ sec: sec.intent === intent ? sec : { ...sec, intro: undefined }, rows }] : [];
  });
}

const cardId = (id: SectionId) => `cfg-card-${id}`;

/**
 * The user's pick (docs/settings-versions.md § Decision): A's sheet list on a
 * phone; on desktop A's rail, grouped and paged by C's intents, over E's
 * summary cards. The rail names every intent with its sections; one intent is
 * on screen at a time; its sections are collapsed cards that expand in place;
 * a rail click opens the intent, expands the card and scrolls to it, and the
 * rail follows the scroll.
 */
export default function MixedSettings() {
  const form = useSettingsForm();
  const ctx = useSettingCtx(form);
  const mobile = useIsMobile();
  const [q, setQ] = useState('');
  const words = queryWords(q);
  return (
    <SettingsPage id="mix" form={form}>
      {ctx &&
        (mobile ? (
          <PhoneList ctx={ctx} form={form} q={q} setQ={setQ} words={words} />
        ) : (
          <DesktopMix ctx={ctx} q={q} setQ={setQ} words={words} />
        ))}
    </SettingsPage>
  );
}

function DesktopMix({
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
  const [tab, setTabState] = useState<Intent>(storedTab);
  const [open, setOpen] = useState<ReadonlySet<SectionId>>(new Set());
  const [active, setActive] = useState<SectionId | null>(null);
  const cards = sectionsOf(tab);

  const setTab = (t: Intent) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // the tab is a convenience
    }
  };

  // Scroll-spy over the open intent's cards.
  useEffect(() => {
    if (words.length) return;
    const nodes = cards.map((c) => document.getElementById(cardId(c.sec.id))).filter((n): n is HTMLElement => !!n);
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id.slice('cfg-card-'.length) as SectionId);
      },
      { rootMargin: '0px 0px -66% 0px' },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
    // the card set changes with the tab only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, words.length]);

  const flip = (id: SectionId) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const jump = (intent: Intent, id: SectionId) => {
    setQ('');
    setTab(intent);
    setActive(id);
    setOpen((s) => new Set(s).add(id));
    requestAnimationFrame(() => document.getElementById(cardId(id))?.scrollIntoView({ block: 'start' }));
  };

  const allOpen = cards.length > 0 && cards.every((c) => open.has(c.sec.id));

  return (
    <div className="cfg-split">
      <nav className="cfg-rail" aria-label="Settings sections">
        {INTENTS.map((intent) => {
          const secs = sectionsOf(intent.id);
          const n = changedKeys(ctx, secs.flatMap((c) => c.rows)).length;
          const on = !words.length && tab === intent.id;
          return (
            <div key={intent.id} className="cfg-rail-group">
              <button
                type="button"
                className={`cfg-rail-intent${on ? ' active' : ''}`}
                aria-current={on ? 'page' : undefined}
                onClick={() => {
                  setQ('');
                  setTab(intent.id);
                }}
              >
                <span>{intent.label}</span>
                {n > 0 && <span className="cfg-count">{n}</span>}
              </button>
              {secs.map(({ sec }) => (
                <button
                  key={sec.id}
                  type="button"
                  className={`cfg-rail-item${on && active === sec.id ? ' active' : ''}`}
                  onClick={() => jump(intent.id, sec.id)}
                >
                  <span>{sec.title}</span>
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
          <>
            <div className="cfg-mix-head">
              <h2>{INTENTS.find((i) => i.id === tab)!.label}</h2>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setOpen(allOpen ? new Set() : new Set(cards.map((c) => c.sec.id)))}
              >
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
            <div className="cfg-cards">
              {cards.map(({ sec, rows }) => (
                <SectionCard
                  key={sec.id}
                  id={cardId(sec.id)}
                  sec={sec}
                  ctx={ctx}
                  rows={sec.device ? [] : rows}
                  open={open.has(sec.id)}
                  onToggle={() => flip(sec.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
