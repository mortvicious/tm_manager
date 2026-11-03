// The Config page's state and its ONE save path (docs/settings-versions.md §
// Shared behaviour). Every settings version — the frozen original included —
// reads and writes through this hook, so "Save sends only the keys this page
// changed" is written once.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type SentryTokenStatus } from '@tm/shared';
import { api } from './api.ts';
import { useApp } from './state.tsx';

export type SettingKey = keyof AppSettings;

/** Machine-owned switches: toggled by their own routes (header, Pause all), never by Save. */
export const NEVER_SAVED: readonly SettingKey[] = ['orchestrator.enabled', 'orchestrator.paused'];

const RECENT_KEY = 'tm.settings.recent';
const RECENT_MAX = 8;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The value a key shows: a server that predates the key reads as its default. */
export function valueOf<K extends SettingKey>(cfg: AppSettings, k: K): AppSettings[K] {
  return (cfg[k] ?? DEFAULT_SETTINGS[k]) as AppSettings[K];
}

/** Whether a key differs from `DEFAULT_SETTINGS` (the "changed from default" marker). */
export function changedFromDefault(cfg: AppSettings, k: SettingKey): boolean {
  return k in DEFAULT_SETTINGS && !same(valueOf(cfg, k), DEFAULT_SETTINGS[k]);
}

function readRecent(): SettingKey[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((k): k is SettingKey => typeof k === 'string' && k in DEFAULT_SETTINGS) : [];
  } catch {
    return [];
  }
}

function writeRecent(keys: SettingKey[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(keys));
  } catch {
    // blocked storage: the list is a convenience
  }
}

export interface SettingsForm {
  /** null until the first GET lands */
  cfg: AppSettings | null;
  err: string | null;
  setErr: (e: string | null) => void;
  /** true for ~1.6 s after a save */
  saved: boolean;
  set: <K extends SettingKey>(k: K, v: AppSettings[K]) => void;
  /** set a key back to DEFAULT_SETTINGS (still needs Save, like any edit) */
  reset: (k: SettingKey) => void;
  /** keys edited since the last load/save — exactly what Save will send */
  dirty: ReadonlySet<SettingKey>;
  /** dirty keys or a typed Sentry token */
  hasChanges: boolean;
  save: () => Promise<void>;
  /** drop every unsaved edit (and a typed token) */
  discard: () => void;
  /** keys saved from this device, newest first (the palette's "recently changed") */
  recent: readonly SettingKey[];
  sentry: {
    status: SentryTokenStatus | null;
    draft: string;
    setDraft: (v: string) => void;
    clear: () => Promise<void>;
    syncing: boolean;
    syncMsg: string | null;
    /** saves first, then pulls issues */
    sync: () => Promise<void>;
  };
}

export function useSettingsForm(): SettingsForm {
  const [cfg, setCfg] = useState<AppSettings | null>(null);
  // what the server last said — the diff base for Save
  const [snapshot, setSnapshot] = useState<AppSettings | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const { refresh } = useApp();
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<SettingKey[]>(readRecent);
  // The Sentry token is never read back (it lives in data/config.json): the
  // page knows set/not set + last 4, and writes only a value typed here.
  const [tokenStatus, setTokenStatus] = useState<SentryTokenStatus | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');

  useEffect(() => {
    api.sentryToken().then(setTokenStatus).catch(() => {});
  }, []);

  useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setCfg(c);
        setSnapshot(c);
      })
      .catch((e) => setErr(e.message));
  }, []);

  const set = useCallback(<K extends SettingKey>(k: K, v: AppSettings[K]) => {
    setCfg((c) => (c ? { ...c, [k]: v } : c));
  }, []);

  const reset = useCallback(
    (k: SettingKey) => {
      set(k, DEFAULT_SETTINGS[k]);
    },
    [set],
  );

  // Only the keys this page changed — never machine-owned state like
  // orchestrator.enabled or stray DB keys (review R11). A key a server lacks
  // compares `undefined` with what was typed, so it is sent once touched.
  const dirty = useMemo(() => {
    const out = new Set<SettingKey>();
    if (!cfg || !snapshot) return out;
    for (const k of Object.keys(cfg) as SettingKey[]) {
      if (!NEVER_SAVED.includes(k) && !same(cfg[k], snapshot[k])) out.add(k);
    }
    return out;
  }, [cfg, snapshot]);

  const save = async () => {
    if (!cfg) return;
    setErr(null);
    setSaved(false);
    try {
      const diff: Partial<AppSettings> = {};
      for (const k of dirty) (diff as Record<string, unknown>)[k] = cfg[k];
      const next = await api.putConfig(diff);
      setCfg(next);
      setSnapshot(next);
      if (dirty.size) {
        const keys = [...dirty, ...recent.filter((k) => !dirty.has(k))].slice(0, RECENT_MAX);
        setRecent(keys);
        writeRecent(keys);
      }
      if (tokenDraft.trim()) {
        setTokenStatus(await api.putSentryToken(tokenDraft.trim()));
        setTokenDraft('');
      }
      // the app state carries settings the UI reacts to (board.groupColors)
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const discard = () => {
    setCfg(snapshot);
    setTokenDraft('');
    setErr(null);
  };

  const clear = async () => {
    setErr(null);
    try {
      setTokenStatus(await api.putSentryToken(''));
      setTokenDraft('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const sync = async () => {
    setErr(null);
    setSyncMsg(null);
    setSyncing(true);
    try {
      await save();
      const r = await api.sentrySync();
      setSyncMsg(`fetched ${r.fetched} · created ${r.created} task(s) · ${r.skipped} already known`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return {
    cfg,
    err,
    setErr,
    saved,
    set,
    reset,
    dirty,
    hasChanges: dirty.size > 0 || tokenDraft.trim() !== '',
    save,
    discard,
    recent,
    sentry: {
      status: tokenStatus,
      draft: tokenDraft,
      setDraft: setTokenDraft,
      clear,
      syncing,
      syncMsg,
      sync,
    },
  };
}
