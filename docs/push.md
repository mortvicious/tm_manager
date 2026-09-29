# Web Push — notifications on the Home Screen app

The phone's Home Screen app (Safari → Share → Add to Home Screen, opened over the
tailnet, `docs/remote-access.md`) gets system notifications. It is pinged for
questions, agents stuck on a prompt, review verdicts, failures and the rest of what
the Telegram bot announces, even with the app closed. The bot keeps working
unchanged. Push is a second, independent surface, and each device chooses what it
hears.

## Turning it on (iPhone)

1. Open `https://<remote.hostname>` in Safari on the tailnet, then Share → **Add to
   Home Screen**. iOS (16.4+) delivers Web Push **only** to a Home Screen web app.
   A Safari tab has no `PushManager` at all.
2. Open Task Manager **from the Home Screen** → Config → **Notifications** →
   **Turn on** → Allow.
3. **Send test**. It should arrive within seconds. Pick the kinds you want below
   it. They save on click and are per device, separate from the page's Save.

If the prompt was denied once, iOS never asks again. Go to Settings → Notifications →
Task Manager → Allow Notifications. Removing the app from the Home Screen kills its
subscription. The next send gets `410` and the server forgets the device.

Web Push needs a **secure context**. It works over the tailnet name (HTTPS via
`tailscale serve`) and on `localhost`, and **not** over LAN mode's plain
`http://192.168.…`, where the panel says so. A desktop Chrome/Firefox/Safari on the
Mac can subscribe as well (`localhost:5176`).

## What pings

The same triggers and re-checks as the Telegram notifier (`telegram/notifications.ts`,
`docs/telegram.md`), in `server/src/push/notifier.ts`. The two share nothing at
runtime, so push works with the bot off. They do share `reviewClause()`, so both
state a review verdict the same way.

| kind | when | tap opens |
|---|---|---|
| `question` | an agent's `AskUserQuestion` is pending (immediately, `Urgency: high`) | `/?task=<id>`, where the question modal pops |
| `attention` | the run is still flagged at the 5s flush (running, not idle) | `/?task=<id>` |
| `review` | the task is in `review` AND the review settled: one verdict per change. Also a "Review now" verdict on a non-review task | `/?task=<id>` |
| `done` | `running`/`waiting` → `done` (auto-complete). A human's Mark done is silent | `/?task=<id>` |
| `failed` / `blocked` / `published` | the transition, re-read at flush | `/?task=<id>` |
| `started` | `queued` → `running` (**off by default**) | `/?task=<id>` |
| `proposal` | a pending proposal (once per id) | its task, or `/` |
| `feature` | a plan is ready to approve (`proposed`), or the feature `paused` | `/features/<id>` |
| `chat` | claude replied in a chat whose last message was typed in the **browser**. A phone-typed turn is already answered in Telegram | `/chat/<id>` |
| `report` | a client report became `ready` or `failed` | `/reports` |
| `queue` | queue drained: nothing queued, running or waiting (TTL 1h) | `/` |

The kinds and their defaults live in ONE list, `PUSH_KINDS` in `shared/`. The
server's validation, the defaults for a new device and the SPA toggles all read it.

**Coalescing.** Task news is merged per task for 5s and re-read from the row at
flush, exactly like the bot. Status pings share the tag `task-<id>`, so the lock
screen keeps the task's latest state instead of a stack. The same string, cut to
32 URL-safe characters, is the RFC 8030 `Topic`, so a phone that was offline
receives only the newest message for that task. Attention (`attention-<id>`),
questions (`question-<id>`) and the rest have their own tags.

**No "never mind" pushes.** iOS must show a notification for every push it receives,
and a worker that shows nothing gets its subscription revoked. So an answered or
expired question is never pushed. Instead the open app closes stale question
banners (`PushBridge`): on open and on every return to the foreground against
`GET /api/questions?status=pending`, and while it is open as questions leave the
pending set. For the same reason `sw.js` draws a notification even for an
unreadable payload.

## Opening a notification

`web/public/sw.js` handles `notificationclick`. If an app window exists, it is
focused and sent `{type:'tm-navigate', url}`. `PushBridge` (mounted in `App.tsx`)
routes it through react-router, so the open terminal and scroll position survive.
Otherwise `clients.openWindow(url)`. Only same-origin paths are followed. The deep
link **`/?task=<id>`** is new and general: any page with `?task=` opens that task's
panel, then the parameter is dropped (`replace`), so Back and reload do not reopen
it.

## The service worker

`web/public/sw.js` → `/sw.js` (Vite copies `public/` to the dist root, and the front
door serves it with `no-cache`), scope `/`. It handles push, notificationclick,
pushsubscriptionchange, and nothing else. **There is deliberately no `fetch`
handler and no cache.** A stale shell must never outlive a deploy, and `/api` and
`/ws` must never be cached (`docs/remote-access.md` Phase 3). `pushsubscriptionchange`
(Chrome/Firefox; Safari does not fire it) re-subscribes with the old key and POSTs
`replaces: <old endpoint>`, so the device keeps its label and kinds. The page
registers the worker on every load, so a subscribed device always has one.

## Protocol

`server/src/push/webpush.ts`, on `node:crypto` only (no `web-push` dependency; the
whole protocol is about 150 lines):

- **Encryption:** RFC 8291 `aes128gcm`, one record, `rs` 4096. It is checked
  byte-for-byte against the RFC's Appendix A test vector (the fixed salt and
  sender key are injectable for exactly that).
- **VAPID** (RFC 8292): ES256 JWT, `aud` = the push service's origin, `exp` 12h
  (Apple rejects anything over 24h), `sub` = `push.subject`, cached per origin
  until an hour before expiry. `Authorization: vapid t=…, k=…`.
- **Verified against Apple's live service** with a fake device token. Our JWT gets
  `400 BadDeviceToken`, meaning auth passed and only the token is wrong. A JWT
  signed by a different key gets `403 BadJwtToken`.
- **Results:** 2xx → `last_ok_at`, failure count reset. `404`/`410`, or Apple's
  `400 BadDeviceToken` → the device row is deleted (it never comes back). Anything
  else → `last_error` + `fail_count`, shown in Settings. Sends time out at 15s and
  never throw into the notifier.
- **Endpoint allowlist:** the server POSTs to whatever endpoint a subscription
  names, so only the browser vendors' push services are accepted: `*.push.apple.com`,
  `fcm.googleapis.com`, `android.googleapis.com`, `*.push.services.mozilla.com`,
  `*.notify.windows.com`, https on 443 only. Anything else is refused at subscribe
  (400) and never sent to. Otherwise a subscription would make this process a
  request forwarder into the LAN.
- **Payload:** `PushMessage` JSON `{title, body, tag, url, kind}`, title ≤120 and
  body ≤900 characters (Apple caps the encrypted payload at 4 KiB). TTL is 24h by
  default and 1h for queue-drained. `Urgency` is `high` for questions and attention.

## Config and keys

`data/config.json`:

```json
"push": { "enabled": true, "subject": "mailto:task-manager@example.com", "vapidPublicKey": "…", "vapidPrivateKey": "…" }
```

- **The private key is a secret**, so it lives in this file, never in `tm_config`
  (which `GET /api/config` dumps). Both keys are **generated on the first boot**
  with push enabled and written back by `savePushVapid` (a re-read-and-patch of
  one key, like `saveTelegramNotify`).
- Every subscription is bound to the public key. Changing or deleting the pair
  orphans every device. The SPA notices (`options.applicationServerKey` differs)
  and re-subscribes when you press Turn on again on each device.
- Boot refuses a half pair, a pair that does not belong together (the public key
  is re-derived from the private one), and a `subject` that is not `mailto:`/
  `https:`. Apple refuses a `localhost` subject.
- `enabled: false` → no keys are generated, nothing is sent,
  `POST /api/push/devices` answers 409, and the panel says so.

## Storage and API

Migration 32 adds `tm_push_devices`: FK-less, `endpoint UNIQUE`, keys, `label`,
`kinds` (JSON), `last_ok_at`, `last_error`, `fail_count`. The upsert SQL and the row
mapper are shared verbatim by both drivers (`storage/push-sql.ts`).

| route | |
|---|---|
| `GET /api/push` | `{enabled, publicKey, devices}` (never the endpoints or keys) |
| `POST /api/push/devices` | `{subscription, label?, kinds?, replaces?}`. Upsert on the endpoint. Absent label/kinds keep the row's (or take the defaults), so re-sending an existing subscription is a **sync** that returns this device's row. The SPA does that on every Settings visit, which also heals a device the server dropped |
| `PATCH /api/push/devices/:id` | `{label?, kinds?}` |
| `DELETE /api/push/devices/:id` | forget it (Settings → Other devices → Remove). That browser re-registers if it opens Settings while still subscribed, so turn it off ON the device to stop it for good |
| `POST /api/push/devices/:id/test` | one test push, whatever the kinds |

**Every write requires `Origin`**, like the question answer route. A worker knows
`$TM_CALLBACK_URL`, and curl sends no Origin, while a browser always sends one on
a POST. Over the tailnet the front door's gate has already checked Origin against
the remote name and rewritten it to loopback (`docs/remote-access.md`), so these
routes need no remote-specific code.

## What it deliberately does not do

- **No actions on the notification** (Answer/Publish buttons): iOS Web Push does
  not support notification actions. A tap opens the app at the right place, and
  answering happens in the question modal.
- **No app badge count.** A stale badge would need a push to clear it, and every
  push draws a banner.
- **No server-side "already seen in the open app" suppression.** The server cannot
  know which device is looking, and iOS requires a banner per push anyway.
