import { useCallback, useEffect, useState } from 'react';
import { PUSH_KINDS, type PushDevice, type PushKind, type PushStatus } from '@tm/shared';
import { isIOS, pushApi, pushSupport, subscribe, syncSubscription, unsubscribe } from '../push.ts';

/**
 * Settings → Notifications (docs/push.md § Turning it on). Per DEVICE, and
 * saved as it is clicked — not part of the page's Save, which writes
 * `tm_config` for every browser at once.
 */
export function PushSettings() {
  const support = pushSupport();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [me, setMe] = useState<PushDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const permission = typeof Notification === 'undefined' ? null : Notification.permission;

  const load = useCallback(async () => {
    try {
      const s = await pushApi.status();
      setStatus(s);
      if (s.publicKey && support === 'ok') {
        const d = await syncSubscription(s.publicKey);
        setMe(d);
        // the sync may have just (re)created this device's row
        if (d && !s.devices.some((x) => x.id === d.id)) setStatus(await pushApi.status());
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [support]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // NOT wrapped in anything that awaits first: the permission prompt inside
  // subscribe() must run while Safari still counts this as the user's tap.
  const enable = () =>
    run(async () => {
      if (!status?.publicKey) throw new Error('push is disabled on the server');
      setMe(await subscribe(status.publicKey));
      setStatus(await pushApi.status());
    });

  const disable = () =>
    run(async () => {
      await unsubscribe(me?.id ?? null);
      setMe(null);
      setStatus(await pushApi.status());
    });

  const test = () =>
    run(async () => {
      if (!me) return;
      const r = await pushApi.test(me.id);
      if (!r.ok) throw new Error(r.error ?? 'the push service refused it');
      setNote('Sent — it should arrive in a few seconds.');
    });

  const toggleKind = (kind: PushKind, on: boolean) =>
    run(async () => {
      if (!me) return;
      const kinds = on ? [...me.kinds, kind] : me.kinds.filter((k) => k !== kind);
      setMe(await pushApi.update(me.id, { kinds }));
    });

  const remove = (d: PushDevice) =>
    run(async () => {
      await pushApi.remove(d.id);
      if (d.id === me?.id) {
        await unsubscribe(null);
        setMe(null);
      }
      setStatus(await pushApi.status());
    });

  const others = (status?.devices ?? []).filter((d) => d.id !== me?.id);

  let blocker: string | null = null;
  if (status && !status.enabled) blocker = 'Push is turned off on the server (push.enabled in data/config.json).';
  else if (support === 'needs-install')
    blocker = 'On iPhone and iPad, notifications work only in the Home Screen app: Share → Add to Home Screen, open Task Manager from the Home Screen, then turn them on here.';
  else if (support === 'insecure')
    blocker = 'Notifications need HTTPS: open Task Manager at its tailnet address (https://…) or on localhost.';
  else if (support === 'unsupported')
    blocker = isIOS() ? 'This iOS version has no Web Push (it needs iOS 16.4 or later).' : 'This browser does not support Web Push.';
  else if (permission === 'denied' && !me)
    blocker = isIOS()
      ? 'Notifications are blocked for this app: Settings → Notifications → Task Manager → Allow Notifications, then reopen it.'
      : 'Notifications are blocked for this site in the browser settings.';

  return (
    <div className="panel cfg-group">
      <h3>Notifications</h3>
      <div className="cfg-row">
        <div>
          <div>This device</div>
          <div className="hint">
            {me
              ? `On — ${me.label}${me.lastError ? ` · last send failed: ${me.lastError}` : ''}`
              : 'Push notifications for questions, reviews, failures and the rest — even with the app closed.'}
          </div>
        </div>
        {me ? (
          <span style={{ display: 'flex', gap: 'var(--tm-space-2)' }}>
            <button className="btn" disabled={busy} onClick={test}>
              Send test
            </button>
            <button className="btn ghost" disabled={busy} onClick={disable}>
              Turn off
            </button>
          </span>
        ) : (
          <button className="btn primary" disabled={busy || !!blocker || !status} onClick={enable}>
            Turn on
          </button>
        )}
      </div>
      {blocker && !me && <div className="hint">{blocker}</div>}
      {err && <div className="warn-text">{err}</div>}
      {note && <div className="hint">{note}</div>}

      {me &&
        PUSH_KINDS.map((k) => {
          const on = me.kinds.includes(k.kind);
          return (
            <div className="cfg-row" key={k.kind}>
              <div>
                <div>{k.label}</div>
                <div className="hint">{k.hint}</div>
              </div>
              <div
                className={`switch ${on ? 'on' : ''}`}
                onClick={() => !busy && toggleKind(k.kind, !on)}
                role="switch"
                aria-checked={on}
                aria-label={k.label}
              >
                <span className="track">
                  <span className="knob" />
                </span>
              </div>
            </div>
          );
        })}

      {others.length > 0 && (
        <>
          <div className="hint" style={{ marginTop: 'var(--tm-space-2)' }}>
            Other devices
          </div>
          {others.map((d) => (
            <div className="cfg-row" key={d.id}>
              <div>
                <div>{d.label}</div>
                <div className="hint">
                  {d.service} · {d.kinds.length} kind(s)
                  {d.lastOkAt ? ` · last delivered ${new Date(d.lastOkAt).toLocaleString()}` : ''}
                  {d.lastError ? ` · failing (${d.failCount}×): ${d.lastError}` : ''}
                </div>
              </div>
              <button className="btn ghost" disabled={busy} onClick={() => remove(d)}>
                Remove
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
