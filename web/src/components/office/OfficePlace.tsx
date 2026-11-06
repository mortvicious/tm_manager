// The office as a place (docs/office.md § The view): the theme-agnostic frame
// around a skin — it reads `useOfficeView` (THE seam), picks the skin from the
// `OFFICE_THEMES` registry, and owns everything a skin must not: the avatar
// card (a side card on desktop, a <Sheet> on a phone), the history feed and
// the selection that lights a feed item's roles and edge on the floor.
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { OFFICE_THEME_LABELS, officeThemeId, type Office, type OfficeFeedItem, type OfficeRole, type OfficeViewAvatar } from '@tm/shared';
import { api } from '../../api.ts';
import { OFFICE_THEMES, OFFICE_THEMES_SWITCHABLE, setOfficeThemePick, useOfficeSkin, useOfficeThemePick } from '../../officeThemes.ts';
import { useOfficeView } from '../../officeView.ts';
import { toastDone, toastError } from '../../toast.ts';
import { Sheet } from '../Sheet.tsx';
import { fmtAgo, useNow } from '../TimeAgo.tsx';
import { OfficeFeed } from './OfficeFeed.tsx';

type Props = {
  officeId: string;
  mobile: boolean;
  onOpenTask: (id: string) => void;
  onOpenTerminal: (runId: string) => void;
  onOpenBrief: (id: string) => void;
  onEditRole: (roleId: string) => void;
};

/** rooms per floor row from the frame's width: a narrow frame stacks them */
function columnsFor(width: number, mobile: boolean): number {
  if (mobile || (width > 0 && width < 560)) return 1;
  if (width > 0 && width < 900) return 2;
  return 3;
}

export function OfficePlace({ officeId, mobile, onOpenTask, onOpenTerminal, onOpenBrief, onEditRole }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns = columnsFor(width, mobile);
  const { detail, layout, error } = useOfficeView(officeId, columns);
  const skin = useOfficeSkin(detail?.office.theme);
  const [selected, setSelected] = useState<string | null>(null);
  const [feedItem, setFeedItem] = useState<OfficeFeedItem | null>(null);

  // a selected avatar whose role was deleted closes its card
  useEffect(() => {
    if (selected && layout && !layout.avatars.some((a) => a.roleId === selected)) setSelected(null);
  }, [layout, selected]);

  const highlight = useMemo(
    () => (feedItem ? { roleIds: new Set(feedItem.roleIds), edgeId: feedItem.edgeId ?? null } : null),
    [feedItem],
  );
  const avatar = selected && layout ? (layout.avatars.find((a) => a.roleId === selected) ?? null) : null;
  const Skin = skin.component;
  // on a phone the card is a <Sheet>: leaving it for another surface (the brief
  // viewer, the editor, the terminal) closes it first, never two sheets stacked
  const leave = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    if (mobile) setSelected(null);
    fn(...a);
  };

  const card = avatar && detail && (
    <AvatarCard
      office={detail.office}
      role={detail.roles.find((r) => r.id === avatar.roleId) ?? null}
      avatar={avatar}
      inSheet={mobile}
      onClose={() => setSelected(null)}
      onOpenTerminal={leave(onOpenTerminal)}
      onOpenBrief={leave(onOpenBrief)}
      onEdit={leave(() => onEditRole(avatar.roleId))}
    />
  );
  const feed = layout && detail && (
    <OfficeFeed
      items={layout.feed}
      roles={detail.roles}
      selectedId={feedItem?.id ?? null}
      onSelect={setFeedItem}
      onOpenTask={onOpenTask}
      onOpenTerminal={onOpenTerminal}
      onOpenBrief={onOpenBrief}
    />
  );

  return (
    <div className={`ov-place${mobile ? ' phone' : ''}`}>
      <div className="ov-stage panel">
        {OFFICE_THEMES_SWITCHABLE && detail && <SkinPicker office={detail.office} />}
        <div className="ov-frame" ref={frame}>
          {!layout ? (
            <div className="muted office-pad">{error ?? 'Loading…'}</div>
          ) : (
            <Suspense fallback={<div className="muted office-pad">Loading…</div>}>
              <Skin
                layout={layout}
                mobile={mobile}
                selectedRoleId={selected}
                highlight={highlight}
                onAvatar={(id) => setSelected((cur) => (cur === id ? null : id))}
              />
            </Suspense>
          )}
        </div>
        {layout && layout.avatars.length === 0 && <div className="muted office-pad">No roles yet — switch to the list to add one from a preset.</div>}
      </div>
      <aside className="ov-side">
        {!mobile && card && <div className="panel ov-card-panel">{card}</div>}
        <div className="panel ov-feed-panel">
          <div className="office-section-title">
            History {feedItem && (
              <button type="button" className="btn ghost ov-feed-clear" onClick={() => setFeedItem(null)}>
                Clear highlight
              </button>
            )}
          </div>
          {feed}
        </div>
      </aside>
      {mobile && card && avatar && (
        <Sheet label={`${avatar.name}, ${avatar.title}`} title={`${avatar.avatar} ${avatar.name}`} onClose={() => setSelected(null)}>
          {card}
        </Sheet>
      )}
    </div>
  );
}

/** The device's skin over the office's theme (only when there is more than one skin). */
function SkinPicker({ office }: { office: Office }) {
  const pick = useOfficeThemePick();
  const officeLabel = OFFICE_THEME_LABELS[officeThemeId(office.theme)];
  return (
    <label className="ov-skin-picker">
      <span className="muted">Skin</span>
      <select value={OFFICE_THEMES.some((s) => s.id === pick) ? (pick ?? '') : ''} onChange={(e) => setOfficeThemePick((e.target.value || null) as never)}>
        <option value="">Office default ({officeLabel})</option>
        {OFFICE_THEMES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What an avatar tap opens: role, state, last brief, the shift terminal, Wake now. */
function AvatarCard({
  office,
  role,
  avatar,
  inSheet,
  onClose,
  onOpenTerminal,
  onOpenBrief,
  onEdit,
}: {
  office: Office;
  role: OfficeRole | null;
  avatar: OfficeViewAvatar;
  inSheet: boolean;
  onClose: () => void;
  onOpenTerminal: (runId: string) => void;
  onOpenBrief: (id: string) => void;
  onEdit: () => void;
}) {
  const now = useNow();
  const [waking, setWaking] = useState(false);
  const next = avatar.nextSlotAt ? Date.parse(avatar.nextSlotAt) : NaN;
  const shift = avatar.liveShift ?? avatar.lastShift;
  const wake = () => {
    setWaking(true);
    api
      .wakeOfficeRole(office.id, avatar.roleId)
      .then(() => toastDone(`wake-${avatar.roleId}`, `${avatar.name} is starting a shift`))
      .catch((e) => toastError(e, `Could not wake ${avatar.name}`))
      .finally(() => setWaking(false));
  };
  return (
    <div className="ov-card" aria-label={`${avatar.name} card`}>
      {!inSheet && (
        <div className="ov-card-head">
          <span className="office-avatar" aria-hidden>
            {avatar.avatar}
          </span>
          <div className="ov-card-who">
            <div className="ov-card-name">{avatar.name}</div>
            <div className="muted">{avatar.title}</div>
          </div>
          <button type="button" className="btn ghost" aria-label="Close card" onClick={onClose}>
            ×
          </button>
        </div>
      )}
      {inSheet && <div className="muted">{avatar.title}</div>}
      <div className="ov-card-state">
        <span className={`chip office-state s-${avatar.state}`}>{avatar.state.replace(/-/g, ' ')}</span>
        {avatar.detail && <span className="muted">{avatar.detail}</span>}
      </div>
      <div className="ov-card-facts muted">
        <span>today ${avatar.spentTodayUsd.toFixed(2)}</span>
        {Number.isFinite(next) && <span>next in {fmtAgo(Math.max(0, next - now))}</span>}
        {avatar.huddleId && <span>in a huddle</span>}
        {avatar.notesTainted && <span className="chip office-taint">notes untrusted</span>}
      </div>
      <div className="ov-card-brief">
        <div className="ov-card-label">Last brief</div>
        {avatar.lastBrief ? (
          <button type="button" className="ov-card-brief-btn" onClick={() => onOpenBrief(avatar.lastBrief!.id)}>
            {avatar.lastBrief.tainted && <span className="chip office-taint">untrusted</span>} {avatar.lastBrief.summary || '(no summary)'}
            <span className="muted"> · {fmtAgo(Math.max(0, now - Date.parse(avatar.lastBrief.createdAt)))} ago</span>
          </button>
        ) : (
          <span className="muted">none yet</span>
        )}
      </div>
      <div className="ov-card-actions">
        {shift?.runId && (
          <button type="button" className="btn" onClick={() => onOpenTerminal(shift.runId!)}>
            {avatar.liveShift ? 'Live shift terminal' : 'Last shift terminal'}
          </button>
        )}
        <button type="button" className="btn primary" disabled={waking || !avatar.enabled || !office.enabled || !!avatar.liveShift} onClick={wake}>
          {waking ? 'Waking…' : 'Wake now'}
        </button>
        {role && (
          <button type="button" className="btn ghost" onClick={onEdit}>
            Edit role
          </button>
        )}
      </div>
    </div>
  );
}
