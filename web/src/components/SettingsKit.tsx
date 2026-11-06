// What every settings version shares (docs/settings-versions.md § Shared
// behaviour): the Versions control, the search box, one control row with its
// "changed from default" marker and reset, the page head with Save, the
// unsaved-changes bar and the search results list. A version is a layout over
// these and the registry, never a copy of a control.

import { Fragment, type ReactNode } from 'react';
import { useLook } from '../appearance.ts';
import { changedFromDefault, defaultOf, type SettingKey, type SettingsForm } from '../settingsForm.ts';
import {
  SETTINGS,
  SETTINGS_SECTIONS,
  isSettingKey,
  settingsIn,
  matchesDevice,
  matchesSetting,
  type SettingCtx,
  type SettingDescriptor,
  type SettingsSection,
} from '../settingsRegistry.tsx';
import {
  SETTINGS_VERSIONS,
  SETTINGS_VERSIONS_SWITCHABLE,
  setSettingsVersion,
  useSettingsVersion,
  type SettingsVersionId,
} from '../settingsVersions.ts';
import { useApp } from '../state.tsx';
import { useWorkspace } from '../workspace.ts';
import { AppearanceSettings } from './AppearanceSettings.tsx';
import { IconChevron } from './Icons.tsx';
import { useIsMobile } from './Layout.tsx';

// ---------- the Versions control ----------

function VersionSelect({ className }: { className?: string }) {
  const current = useSettingsVersion();
  return (
    <select
      className={`field${className ? ` ${className}` : ''}`}
      aria-label="Settings version"
      title="Settings layout, on this device only"
      value={current.id}
      onChange={(e) => setSettingsVersion(e.target.value as SettingsVersionId)}
    >
      {SETTINGS_VERSIONS.map((v) => (
        <option key={v.id} value={v.id}>
          {`version: ${v.label}`}
        </option>
      ))}
    </select>
  );
}

/** Desktop: a compact menu in the page head. Nothing on a phone (see SettingsVersionsSetting). */
export function SettingsVersionsControl() {
  const mobile = useIsMobile();
  if (!SETTINGS_VERSIONS_SWITCHABLE || mobile) return null;
  return <VersionSelect className="settings-version-select" />;
}

/** Phone: a row at the top of the page. Nothing on desktop. */
export function SettingsVersionsSetting() {
  const mobile = useIsMobile();
  const current = useSettingsVersion();
  if (!SETTINGS_VERSIONS_SWITCHABLE || !mobile) return null;
  return (
    <div className="panel cfg-group settings-version-row">
      <div className="cfg-row">
        <div>
          <div>Settings layout</div>
          <div className="hint">{`${current.label}, on this device only`}</div>
        </div>
        <VersionSelect />
      </div>
    </div>
  );
}

// ---------- context ----------

/** The render context every registry control reads; null until the settings load. */
export function useSettingCtx(form: SettingsForm): SettingCtx | null {
  const { repos, orch } = useApp();
  const look = useLook();
  const { wsHref } = useWorkspace();
  if (!form.cfg) return null;
  return { form, cfg: form.cfg, repos, orch, look, wsHref };
}

// ---------- search ----------

export function SettingsSearch({
  value,
  onChange,
  autoFocus,
  big,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  big?: boolean;
}) {
  return (
    <div className={`cfg-search${big ? ' big' : ''}`}>
      <input
        className="field"
        type="search"
        aria-label="Search settings"
        placeholder="Search settings — label, key or help"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
      />
    </div>
  );
}

// ---------- one control ----------

function fmtDefault(k: SettingKey): string {
  const v = defaultOf(k);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (Array.isArray(v)) return v.length ? `${v.length} item(s)` : 'none';
  if (v === '') return 'blank';
  return String(v);
}

/** Changed-from-default keys among these rows (an `x:` row never counts). */
export function changedKeys(ctx: SettingCtx, rows: readonly SettingDescriptor[]): SettingKey[] {
  return rows.flatMap((s) => (isSettingKey(s.key) && changedFromDefault(ctx.cfg, s.key) ? [s.key] : []));
}

/**
 * One control: label, the "changed from default" marker with a per-key reset,
 * the help, a value-dependent note, the control. `showKey` prints the settings
 * key under the label (search results, so a key search shows what it hit).
 */
export function SettingRow({ s, ctx, showKey }: { s: SettingDescriptor; ctx: SettingCtx; showKey?: boolean }) {
  const key = isSettingKey(s.key) ? s.key : null;
  const changed = key !== null && changedFromDefault(ctx.cfg, key);
  const unsaved = key !== null && ctx.form.dirty.has(key);
  return (
    <div className={`cfg-row${s.wide ? ' cfg-wide' : ''}`} data-setting={s.key}>
      <div className="cfg-label">
        <div className="cfg-label-line">
          <span>{s.label}</span>
          {unsaved && <span className="cfg-dot unsaved" title="edited, not saved yet" aria-label="unsaved" />}
          {changed && (
            <span className="cfg-changed">
              <span className="cfg-dot" aria-hidden />
              <span className="hint">{`changed · default ${fmtDefault(key)}`}</span>
              <button type="button" className="btn ghost cfg-reset" onClick={() => ctx.form.reset(key)}>
                Reset
              </button>
            </span>
          )}
        </div>
        {showKey && key && <div className="hint mono">{key}</div>}
        <div className="hint">{s.help}</div>
        {s.note?.(ctx)}
      </div>
      <div className="cfg-control">{s.render(ctx)}</div>
    </div>
  );
}

/** A section's panel: heading, intro, its rows — or the per-device block as its own component. */
export function SectionPanel({
  sec,
  ctx,
  rows,
  showKey,
  heading = true,
  footer,
}: {
  sec: SettingsSection;
  ctx: SettingCtx;
  rows: readonly SettingDescriptor[];
  showKey?: boolean;
  heading?: boolean;
  footer?: ReactNode;
}) {
  if (sec.device) {
    const Device = sec.device;
    return <Device />;
  }
  return (
    <div className="panel cfg-group" data-section={sec.id}>
      {heading && <h3>{sec.title}</h3>}
      {sec.intro && <div className="hint cfg-intro">{sec.intro}</div>}
      {rows.map((s) => (
        <SettingRow key={s.key} s={s} ctx={ctx} showKey={showKey} />
      ))}
      {footer}
    </div>
  );
}

/**
 * Search results, grouped by section in page order. Device blocks match on
 * their title and keywords and come whole; key matches show the key.
 */
export function SearchResults({ ctx, words }: { ctx: SettingCtx; words: string[] }) {
  const groups = SETTINGS_SECTIONS.map((sec) => ({
    sec,
    rows: sec.device ? [] : SETTINGS.filter((s) => s.section === sec.id && matchesSetting(s, words)),
    device: matchesDevice(sec, words),
  })).filter((g) => g.rows.length || (g.sec.device && g.device));
  if (!groups.length) return <div className="muted cfg-empty">Nothing matches — try a key like “review.” or a word from the help.</div>;
  return (
    <>
      {groups.map(({ sec, rows }) => (
        <Fragment key={sec.id}>
          <SectionPanel sec={sec} ctx={ctx} rows={rows} showKey />
        </Fragment>
      ))}
    </>
  );
}

/**
 * A collapsed section card (versions E and the mix): title, its current value
 * as one line, the changed count; expands in place to edit. `rows` narrows it
 * to part of the section (the mix's intent split); default = all of it.
 */
export function SectionCard({
  sec,
  ctx,
  open,
  onToggle,
  rows = settingsIn(sec.id),
  id,
}: {
  sec: SettingsSection;
  ctx: SettingCtx;
  open: boolean;
  onToggle: () => void;
  rows?: readonly SettingDescriptor[];
  id?: string;
}) {
  const changed = changedKeys(ctx, rows).length;
  const unsaved = rows.some((s) => isSettingKey(s.key) && ctx.form.dirty.has(s.key));
  return (
    <div id={id} className={`panel cfg-card${open ? ' open' : ''}`}>
      <button type="button" className="cfg-card-head" aria-expanded={open} onClick={onToggle}>
        <span className="cfg-card-text">
          <span className="cfg-card-title">
            {sec.title}
            {unsaved && <span className="cfg-dot unsaved" aria-label="unsaved" />}
          </span>
          <span className="hint">{sec.summary(ctx)}</span>
        </span>
        {changed > 0 && (
          <span className="cfg-count" title={`${changed} changed from default`}>
            {changed}
          </span>
        )}
        <span className="cfg-card-chev" aria-hidden>
          <IconChevron />
        </span>
      </button>
      {open && (
        <div className="cfg-card-body">
          <SectionPanel sec={sec} ctx={ctx} rows={rows} heading={false} />
        </div>
      )}
    </div>
  );
}

// ---------- head and save ----------

/** The page head: title, the Versions control, Save. The phone's Versions row and the error follow it. */
export function SettingsHead({ form, title = 'Config' }: { form: SettingsForm; title?: string }) {
  return (
    <>
      <h1 className="page-title">
        {title}
        <SettingsVersionsControl />
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={form.save} disabled={!form.cfg}>
          {form.saved ? 'Saved ✓' : form.dirty.size ? `Save (${form.dirty.size})` : 'Save'}
        </button>
      </h1>
      <SettingsVersionsSetting />
      {form.cfg && form.err && <div className="warn-text cfg-err">{form.err}</div>}
    </>
  );
}

/**
 * The unsaved-changes bar: pinned to the bottom of the page (above the phone's
 * tab bar) while anything is edited, so Save is never a scroll away.
 */
export function SaveBar({ form }: { form: SettingsForm }) {
  if (!form.hasChanges) return null;
  const n = form.dirty.size + (form.sentry.draft.trim() ? 1 : 0);
  return (
    <div className="cfg-savebar" role="region" aria-label="Unsaved changes">
      <span className="cfg-savebar-text">{`${n} unsaved change${n === 1 ? '' : 's'}`}</span>
      <button type="button" className="btn" onClick={form.discard}>
        Discard
      </button>
      <button type="button" className="btn primary" onClick={form.save}>
        Save
      </button>
    </div>
  );
}

/** Loading / API down: the per-device look is still reachable, like the original. */
export function SettingsLoading({ form }: { form: SettingsForm }) {
  return (
    <>
      <AppearanceSettings />
      <div className="muted">{form.err ?? 'Loading…'}</div>
    </>
  );
}

/** Each version's page frame. */
export function SettingsPage({ id, form, children }: { id: string; form: SettingsForm; children: ReactNode }) {
  return (
    <div className={`cfg-page cfg-v-${id}`}>
      <SettingsHead form={form} />
      {form.cfg ? children : <SettingsLoading form={form} />}
      <SaveBar form={form} />
    </div>
  );
}

