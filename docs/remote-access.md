# Remote access — the web UI from anywhere, safely

**Status (2026-09-29): phase 0 done, phase 1 built and verified** (the identity gate in the front door, § Phase 1). Remote access stays OFF until you add the `remote` block and run `tailscale serve` (§ Going live). Phase 2 (passkey, remote capability profile, secret redaction) is not built. This page is the research, the plan, and the record of what was built for using the full mobile web UI (terminal included) away from the Mac. The Telegram bot stays as the break-glass surface.

## TL;DR

Use **Tailscale**, a private WireGuard mesh, and put **`tailscale serve`** in front of the front door, which keeps binding `127.0.0.1`. Nothing listens on the internet, on the café Wi-Fi, or even on the home LAN. The iPhone joins the tailnet with the Tailscale app. It opens `https://<mac>.<tailnet>.ts.net`, which has a real Let's Encrypt certificate, and adds it to the Home Screen as the existing PWA.

The app itself gains one gate, **at the front door**: a request that addressed us by the tailnet name must carry a `Tailscale-User-Login` identity header on an allowlist, or it gets a 403. That header is stamped by `tailscaled` and cannot be forged from the tailnet. A passkey (Face ID) login for remote requests is phase 2, as defence in depth. A native iPhone app, a Telegram Mini App, Cloudflare Tunnel and ngrok are all rejected; see § Options.

## Why this needs care: reachability is root today

The measured current state, with the code references behind each point:

- **There is no user authentication.** There is no login, cookie, or password anywhere in `server/src`. The per-boot session token is handed to anyone who asks: `GET /api/session` → `{token}` (`server/src/index.ts:281`). REST `/api/*` carries no token at all. The only guard is the Host/Origin allowlist (`index.ts:144-156`, `server/src/net.ts:52-73`), and GETs are not Origin-checked.
- **The UI is remote code execution by design.** `/ws/terminal/:runId` writes keystrokes straight into claude PTYs. Repo commands spawn any argv (`POST /api/commands`). Repos register by any absolute path. `PUT /api/config` can switch agents to `bypassPermissions`. Chat `write` mode is `--dangerously-skip-permissions`. `/api/repos/:id/push` pushes. `/host/*` start/stop/restart the API, `force` included, with no auth. `GET /api/config` returns every DB setting, including the Sentry token.
- **LAN mode (`TM_LAN=1`) is not a remote-access mode.** It binds `::` on every interface and widens the allowlist to RFC1918, link-local and `*.local`, with **no extra auth**. Its own banner says "anyone on this network can run commands here" (`index.ts:424`). At home that means every IoT box and every guest on the Wi-Fi.
- **Tunnels and tailnets 403 today, and that is correct.** `isAllowedHost` requires the Host port to equal the listener port (a port-less Host counts as 80) and the name to be loopback or private. A `*.ts.net` name, a `100.64/10` address, or a public hostname on 443 all fail.

So any remote path has two jobs: make the Mac reachable **only** to your devices, and put **real identity** in front of the app, because the app has none. `docs/future/telegram-bot.md` § Tailscale suggests that "the one change is `net.ts`: add `100.64/10` and `.ts.net` to the private list behind `TM_LAN`". **This page supersedes that.** It would work, but it rides on LAN mode, which binds every interface with zero auth, and it trusts a whole address range instead of a person.

## Threat model

| # | Adversary | What they could do today if the port were reachable | Mitigated by |
|---|---|---|---|
| T1 | Internet scanner or bot | Full RCE on the Mac | Nothing listens publicly (tailnet only, no Funnel, no port forward) |
| T2 | Someone on the same Wi-Fi (home guests, café, hotel) | Full RCE (in LAN mode) | Keep binding `127.0.0.1`; `tailscale serve` is the only door, and only tailnet peers reach it |
| T3 | Malicious web page in the phone's or Mac's browser (CSRF, DNS rebinding) | Blind POSTs; rebinding reads | Exact-name Host allowlist + Origin check (existing pattern), `SameSite=Strict` cookie in phase 2 |
| T4 | Another device on your tailnet gets compromised (an old laptop, a shared node) | Reach the Mac like the phone does | Tailscale **grants/ACL**: only your user's phone → Mac `tcp:443`; the identity allowlist in the app |
| T5 | Lost or stolen iPhone | Whatever an unlocked phone can open | iOS passcode/Face ID; phase 2 passkey needs Face ID per session; remove the node in the Tailscale admin console from any browser; short phone key expiry |
| T6 | Your Tailscale login (Google/GitHub/Apple SSO) is phished | Add a new device to the tailnet | Passkey/hardware 2FA on that IdP; **Tailnet Lock** (a new node needs a signature from a trusted node); the app allowlist; phase 2 passkey is bound to the phone |
| T7 | The Tailscale coordination server is compromised | Inject a node | **Tailnet Lock** is designed for exactly this. Traffic is end-to-end WireGuard, and DERP relays see only ciphertext |
| T8 | Misconfiguration: someone runs `tailscale funnel` by accident | Public exposure | Funnel requests carry **no** identity headers → the app gate denies (fails closed); plus an ACL `nodeAttrs` that does not grant `funnel` |

Out of scope: an attacker who already runs code as your user on the Mac. They already own everything the app can do.

## Options considered

| Option | Exposure | Who sees plaintext | Identity | Verdict |
|---|---|---|---|---|
| **Tailscale + `tailscale serve`** | None public; tailnet peers only | Nobody but the two endpoints (TLS inside WireGuard) | Per-user, per-device; `Tailscale-User-Login` header stamped by `tailscaled` | **Recommended** |
| Headscale (self-hosted Tailscale control plane) | Same as Tailscale, but you run a public control server | Endpoints | Same | More ops, and a public server you must now defend. Tailnet Lock gets most of the "don't trust the vendor" benefit. Later, if ever |
| Plain WireGuard (router or Mac as the server) | One UDP port forwarded on the router (silent to unauthenticated packets) | Endpoints | Key per device, no user identity, no headers | Viable, but needs a port forward, dynamic DNS, a non-CGNAT ISP, and manual keys and TLS. No identity to gate on |
| Cloudflare Tunnel + Access | **Public hostname on the internet**, gated by an Access policy | **Cloudflare** terminates TLS and sees terminal I/O, code and tokens | IdP login (+ app must verify the `Cf-Access-Jwt-Assertion` JWT) | Rejected. One policy slip means internet-facing RCE, and a third party reads your work. This is the same reason Telegraph was dropped (2026-09-01: "public URLs, private work detail") |
| ngrok / localtunnel / similar | Public URL | The provider | Optional OAuth | Rejected, for the same reasons, only weaker |
| Tailscale **Funnel** | Public internet | Endpoints | **None** (no identity headers) | Rejected explicitly; guarded against in T8 |
| Telegram Mini App (UI inside Telegram) | The Mini App URL must be **public HTTPS** reachable by Telegram clients | The hosting path, plus Telegram's webview | Telegram `initData` HMAC | Rejected: it needs a public endpoint (Cloudflare-class exposure) to reach the same UI. The bot stays a chat surface |
| Native iPhone app | Still needs a transport (one of the above) | — | — | Not needed. The transport is the security; a native shell adds signing, TestFlight and a second front end, and buys nothing a PWA over HTTPS lacks. Revisit only for native push or background features |
| macOS Screen Sharing / SSH (Blink, Termius) over the tailnet | Tailnet only | Endpoints | macOS account / SSH key | Keep as **break-glass** fallbacks (`tailscale ssh` or plain sshd bound to the tailnet), not the daily UI |

### Why Tailscale specifically

- **Nothing inbound.** Both ends dial out and NAT traversal punches through. When it can't, DERP relays forward packets they cannot decrypt.
- **`tailscale serve`** listens only on the tailnet interface. It terminates HTTPS with an auto-renewed Let's Encrypt cert for the MagicDNS name, and reverse-proxies to `127.0.0.1:5176`. The app keeps its loopback-only bind, so T2 is closed by construction.
- **Identity headers.** For proxied serve requests `tailscaled` adds `Tailscale-User-Login`, `Tailscale-User-Name` and `Tailscale-User-Profile-Pic`. It **strips any incoming copies** first, so a tailnet peer cannot forge them. That gives us a real "who" at no auth-code cost. Funnel traffic does not get them, which is what makes T8 fail closed.
- **iOS app** with VPN On Demand: it connects automatically when you open the PWA away from home, and can stay off on trusted Wi-Fi.
- **Admin controls that map onto the threat model:** grants/ACLs (T4), key expiry (T5), Tailnet Lock (T6/T7), and node removal as a remote kill switch (T5).

Costs, stated plainly: the free Personal plan (6 users, unlimited user devices, Tailnet Lock included; device approval is Standard+, which is why § Phase 0 uses Tailnet Lock) covers this technically, but Tailscale limits it to **non-commercial use**. If this Mac does paid or client work, a paid plan is the honest choice. iOS allows **one active VPN at a time**, so Tailscale conflicts with a corporate or commercial VPN on the phone. You must trust Tailscale's client software; the control plane is covered by Tailnet Lock.

## Plan

Phases in order. Each phase is independently useful and gets an adversarial review before the next (CLAUDE.md rule).

### Phase 0 — tailnet hardening (no code, ~30 min, you do it)

1. Tailscale account: sign in through an IdP protected by a **passkey or hardware key**, not SMS.
2. Install Tailscale on the Mac (the standalone build is preferred over the App Store one: it runs as a system daemon and works with `tailscale serve` from the CLI) and on the iPhone.
3. **Mac key expiry: disable. Phone key expiry: keep** (≤ 90 days). Otherwise the Mac falls off the tailnet while you are away, with nobody at home to re-auth it.
4. **Tailnet Lock** on, with the Mac and the phone as signing nodes. Store the disablement secrets offline. It is mutually exclusive with device approval; for a one-person tailnet, Lock is the stronger choice.
5. **Grants/ACL**, replacing the default allow-all. Tag the Mac `tag:tm-host`. Allow only your user → `tag:tm-host:443` (plus `:22` if you want SSH break-glass). Deny everything else, including the Mac reaching other nodes. Grant **no** `funnel` node attribute.
6. macOS: firewall on with stealth mode; **leave LAN mode off** (`lan.enabled` absent, no `TM_LAN`).
7. Mac-as-a-server basics are already a workbook: `docs/telegram.md` § Connect (launchd KeepAlive, `caffeinate`, power settings, and the FileVault reboot wall; after an unattended reboot nothing runs until someone unlocks the disk).

**Done 2026-09-29**, except Tailnet Lock. The Mac is `tm-m`, tagged `tag:tm-host`. The policy applied is `tailscale-policy.hujson` in the task's artifacts: one grant, your user → `tag:tm-host` `tcp:443` + ICMP, no SSH, no `funnel` attribute, with tests denying 5173/5175/5176/22. HTTPS certificates are enabled.

Nothing is reachable after phase 0 alone. The app still 403s the tailnet name, which is the correct resting state.

### Phase 1 — the identity gate (built 2026-09-29)

**As built.** `server/src/remote.ts` (the pure gate), `server/src/host.ts` (applies it), `server/src/config.ts` (the `remote` block), and one API route for the audit row. The API's own Host/Origin rules and `net.ts` are unchanged.

- **Config** (`server/data/config.json`, a file, not `tm_config`, which `GET /api/config` dumps):

  ```json
  "remote": { "enabled": true, "hostname": "tm-m.tail04c8fe.ts.net", "allowedLogins": ["shindo.shitai@gmail.com"] }
  ```

  Defaults to `{ enabled: false, hostname: "", allowedLogins: [] }`. Validated at load: `hostname` must be a bare DNS name (no scheme, port, trailing dot, wildcard or IP literal; lowercased), and `allowedLogins` an array of non-empty strings (lowercased). With `enabled: true`, both must be non-empty. **Boot is refused when `remote.enabled` and LAN mode (`lan.enabled` or `TM_LAN=1`) are both on**: LAN mode binds every interface with no identity, which would leave a "remote-only" install wide open on the Wi-Fi.
- **The gate, in the front door.** It lives there because the front door rewrites `Host` to `127.0.0.1:5175`, after which the API cannot tell a remote request from a local one. Every HTTP request and WS upgrade, `/host/*` included, goes through `checkRemote()` first:
  - `Host` not EXACTLY `remote.hostname` (port-less, which is what serve sends, or `:443`) → not remote; the loopback/LAN rules apply exactly as before. `:80`, another name on the same tailnet, a trailing dot: all fall through to the old allowlist and get its 403. There is no `.ts.net` suffix rule anywhere.
  - A remote-name request gets **403** unless `remote.enabled`, the TCP peer is loopback, `Tailscale-User-Login` is on `allowedLogins` (exact, case-insensitive; a repeated header joins to `a, b` and matches nothing), **and** the `Origin` is exactly `https://<hostname>`. The Origin is required on WS upgrades and on every method except GET/HEAD (a top-level navigation carries none); a present foreign Origin is refused on every method. A refused WS upgrade gets a bare `403` and the socket closes.
  - Admitted: every `tailscale-*` header is stripped (for local requests too, so the API never sees identity it cannot verify), and the verified Origin is **rewritten to the front door's loopback origin** before the rest of the front door and the API judge it.
- **Why rewrite the Origin rather than teach `net.ts` the remote origin.** The task allowed either. Rewriting keeps the decision about the remote name in ONE place, the gate that has just checked the identity and the exact Origin. The API's `isAllowedOriginHost` and the WS routes stay loopback/LAN-only and never trust a non-private name; there is no API code path that a direct hit on `127.0.0.1:5175` with `Origin: https://tm-m…` could exercise (measured: 403 `forbidden origin`; `Host: tm-m…` straight to the API: 403 `forbidden host`). The DNS-rebinding guard is intact: the only new accepted `Host` is one exact name, and only with a tailnet identity behind it. Recorded in `docs/decisions.md` 2026-09-29.
- **Audit.** The first admitted request of each login per front-door boot writes one `tm_events` row: `kind: 'remote.login'`, `actor: 'remote'`, `data: { login, userAgent }`. It shows on the dashboard as "remote sign-in: <login>". The front door has no storage, so it POSTs to `POST /api/host/remote-login`. That route requires `x-tm-host-token`, a secret the front door mints at every boot into `server/data/host.token` (mode 0600). It is a file rather than the child's env, so an adopted API can read it too. The remote client the front door proxies for cannot read the file, so it cannot write sign-in rows. A failed hand-off (the API down) is retried on that login's next request. The boot log also prints `[host] remote sign-in: <login> (<user agent>)` once, and refusals at most once a minute per reason.
- **Not a threat:** a local process sending forged `Tailscale-User-Login` to `127.0.0.1:5176`. It already has full loopback access to everything the gate protects. tailscaled strips client-sent copies on the tailnet path (measured below).
- **Serve:** `tailscale serve --bg --https=443 http://127.0.0.1:5176`. It serves the **production front door only**. The Vite dev server (5173) is never exposed. Never `tailscale funnel`.
- **Measured 2026-09-29, before the gate** (Tailscale 1.102.4, a throwaway loopback echo server behind `serve`, iPhone iOS 18.7 Safari + Brave):
  1. `serve` forwards the **original `Host`**, port-less (`tm-m.tail04c8fe.ts.net`), and adds `X-Forwarded-For` (the peer's 100.x address), `X-Forwarded-Host`, and `X-Forwarded-Proto: https`. The TCP peer is always `127.0.0.1`.
  2. **WebSocket upgrades carry the identity headers** too, with `Origin: https://<name>`, and the WS round-trip works end to end (open, message, clean close 1000).
  3. `Tailscale-User-Login` is the account's email login. `Tailscale-User-Name` and `-Profile-Pic` come with it, plus `Tailscale-Headers-Info`.
  4. A request from the **tagged** Mac to its own name arrives with **no** identity headers, and a forged `Tailscale-User-Login` sent by the client was **stripped**. So the gate refuses tagged nodes and forgeries by construction.

  The cert is a real Let's Encrypt one for the MagicDNS name.
- **Verified 2026-09-29, with the gate.** `npm run typecheck` and the web build are clean. A script over `checkRemote`/`isRemoteHost`/`stripTailscaleHeaders` covers 32 cases (exact name, `:443`, `:80`, trailing dot, suffix look-alikes, case, repeated login, non-loopback peer, disabled, every Origin case, WS vs HTTP, HEAD). Config validation was driven for eleven files: a scheme, a port, a wildcard, an IP, a trailing dot, empty logins, empty hostname, a non-boolean, a string for the list, disabled (accepted), and remote plus `TM_LAN=1` (refused). Then an **isolated instance** was run: a copy of the tree on API 5199 / front door 5198 with its own SQLite DB, never the live 5175/5176, and `tailscale serve --bg --https=443 http://127.0.0.1:5198` pointed at it for the test only.
  - From the Mac over the tailnet name: `/api/health`, `/` and `/host/status` → **403** `no tailnet identity`; with a forged `Tailscale-User-Login` → **403** (tailscaled stripped it).
  - `127.0.0.1:5198` → unchanged (200; a foreign-Origin POST is still 403, and a foreign-Origin WS is still closed 4403 by the API).
  - With serve's headers simulated on loopback: an allowlisted login → 200, and a POST that reaches a real route gets past the API's Origin check (400 from body validation). Wrong login, no identity, `:80`, another `*.tail04c8fe.ts.net` name, a POST with no Origin, the loopback Origin, `http://` instead of `https://`, and a foreign Origin on a GET → 403. `/host/restart` with no Origin or a foreign Origin → 403. WS on `/ws/events`: the right Origin → open; a wrong, loopback or missing Origin, no identity or a wrong login → refused 403.
  - Audit: many remote requests from one login produced exactly one `remote.login` row. `POST /api/host/remote-login` without the token, directly or through the remote proxy with a wrong token → 403.
  - `remote.enabled: false` → the tailnet name gives **403** `remote access is disabled`; local unchanged.
  - **iPhone** (the owner, over the tailnet): the SPA loaded, the task list loaded, the events socket connected, and a live terminal attached over `/ws/terminal/…` and streamed (a harmless `top` repo command in the isolated instance).
  - Afterwards `tailscale serve --https=443 off` (`No serve config`), and the isolated instance stopped.
  - Not exercised: `tailscale funnel`, deliberately never run. Funnel traffic carries no identity headers, so it falls to the `no tailnet identity` branch.

#### Going live

1. **Leave LAN mode.** The live install was started with `npm run start:lan` (`TM_LAN=1`). With `remote.enabled` that combination refuses to boot. Start with `npm start`, and make sure `lan.enabled` is absent or false (and that any launchd agent runs `npm start`, not `start:lan`).
2. Add to `server/data/config.json`:
   `"remote": { "enabled": true, "hostname": "tm-m.tail04c8fe.ts.net", "allowedLogins": ["shindo.shitai@gmail.com"] }`
3. Restart the **front door** (Ctrl-C the `npm start` terminal, then `npm start` again) while no agent is working. The front door's own restart button restarts only the API, and the gate lives in the front door. The boot banner should print `remote: https://tm-m.tail04c8fe.ts.net (via \`tailscale serve\` → :5176) for shindo.shitai@gmail.com only`.
4. `tailscale serve --bg --https=443 http://127.0.0.1:5176`
5. Check: from the Mac, `curl -s https://tm-m.tail04c8fe.ts.net/api/health` → 403 `no tailnet identity`; the phone opens the board.

### Phase 2 — defence in depth: passkey + remote capability profile

The tailnet already gives identity, and this phase covers the cases where the tailnet is not enough (T5, T6):

- **Passkey (WebAuthn) login for the remote hostname only.** Face ID on the phone gives a `__Host-` cookie, `HttpOnly; Secure; SameSite=Strict`, 12 h absolute. The terminal WS and every REST call on the remote name need it. `GET /api/session` stops handing out the token to remote requests without the cookie. The `ts.net` HTTPS name is what makes this possible: WebAuthn needs a secure context and a stable RP ID. Registration happens only from loopback, at the Mac.
- **Remote capability profile.** Over the remote name, refuse the settings that turn the UI into a stronger weapon than the phone needs. The candidates are listed in § Open decisions.
- **Redact secrets** from `GET /api/config` for remote requests (the Sentry token, and anything similar).
- **Telegram ping on each new remote session** ("new sign-in: iPhone, 14:02"). Silent sign-ins are the ones that matter.

### Phase 3 — mobile polish (optional)

- iOS PWA meta (`apple-mobile-web-app-capable`, status-bar style). A service worker for the **shell only**; never cache `/api` or `/ws`.
- **Self-host the Google Fonts** (`web/index.html:14-19`), so the remote page makes no third-party requests.
- Telegram cards get an "Open in UI" link to `https://<mac>.<tailnet>.ts.net/tasks/<id>`. It resolves only on the tailnet, so a leaked link is useless.
- Web Push (iOS 16.4+ for Home Screen PWAs) could later replace some Telegram pings. Not needed while the bot does it.

## Operating it

- **Lost phone:** remove the node in the Tailscale admin console (any browser) → it can no longer reach the Mac. Also revoke the passkey (phase 2). The Telegram bot is on the lost phone too, so the admin console is the kill switch.
- **Away from home and the Mac is unreachable:** the Mac is asleep, rebooted behind FileVault, or `tailscaled` is down. The Telegram bot does not depend on the tailnet (it polls outward), so if the bot answers, the Mac is up and the problem is the tailnet or `serve`.
- **What survives what.** The serve config and the cert live in `tailscaled`'s state, so they persist across restarts and reboots and never need redoing. The phone never needs re-pairing.
  - **Sleep/wake:** the Mac is unreachable while asleep (the bot too); Tailscale reconnects on wake by itself.
  - **API restart** (the UI button, `/host/restart`): the page stays up; that is what the front door is for.
  - **Front-door restart or crash:** serve answers 502 until 5176 is back, then reload.
  - **`npm run build`:** reload the page.
  - **Dev mode is not remote:** only the production front door (`npm start`, port 5176) is served. The Vite dev server (5173) never is.
  - **Reboot:** stops at the FileVault screen until someone logs in at the Mac (`docs/telegram.md` § 6). After login, the Tailscale app (Settings → Launch at login) and the launchd agent bring everything back.
- **iPhone:** enable VPN On Demand in the Tailscale app so it connects by itself when the page is opened; otherwise open the Tailscale app first.
- **Lid closed:** `caffeinate` only stops idle sleep; lid-close still sleeps without an external display. The answers and their caveats are in `docs/telegram.md` § 6: lid open on the charger (recommended), or the undocumented `sudo pmset -a disablesleep 1` (verify with `pmset -g`; watch heat on a fanless Air).
- **Disable remote quickly:** `tailscale serve reset` on the Mac, or `remote.enabled: false` and restart the front door. Either leaves local use untouched.
- **Who signed in:** the dashboard's audit feed shows one "remote sign-in" row per login per front-door boot (`GET /api/events?kind=remote.login`).

## Open decisions

1. **Tailscale vs self-hosted WireGuard.** The recommendation is Tailscale: identity headers, no open port, and Tailnet Lock for the vendor-trust concern. Choose WireGuard only if no third-party control plane at all is a hard requirement. You then lose the identity gate and must do phase 2 before going live.
2. **Is phase 2 a prerequisite for going live, or a follow-up?** Recommendation: phase 1 is enough to start on a locked-down, one-user tailnet. Do phase 2 before adding any second device or person.
3. **The remote capability profile.** Which actions should the phone not have? Candidates: repo registration, creating (not running) repo commands, switching agents to `bypassPermissions`, chat `write` mode, `/host` force-restart. Each one refused remotely is a trip back to the Mac when you truly need it.

## Sources

- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve · `serve` CLI: https://tailscale.com/docs/reference/tailscale-cli/serve
- Identity headers: https://tailscale.com/docs/concepts/tailscale-identity · demo: https://github.com/tailscale-dev/id-headers-demo
- Security best practices: https://tailscale.com/docs/reference/best-practices/security
- Tailnet Lock: https://tailscale.com/kb/1226/tailnet-lock · Device approval: https://tailscale.com/kb/1099/device-approval · Key expiry: https://tailscale.com/docs/features/access-control/key-expiry
- iOS VPN On Demand: https://tailscale.com/docs/features/client/ios-vpn-on-demand
- Cloudflare Access self-hosted apps (the rejected alternative): https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Earlier in-repo notes this supersedes: `docs/future/telegram-bot.md` § Tailscale, `docs/future/autonomy-cloud-shadow.md` (a).
