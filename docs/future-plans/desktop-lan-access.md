# Plan: reach the Windows app from other devices on the local network

Status: proposed, 2026-11-17. The task list is
`docs/future-plans/desktop-lan-access-tasks.md`.

## 1. Goal and scope

Today the Windows app is reachable from its own PC only: every listener binds
`127.0.0.1` (`docs/future-plans/windows-installer.md`, decision D4, and
open question 2, which left "an opt-in LAN toggle" to a later proposal). This
is that proposal.

When the person turns it on, a phone, a tablet or another computer on the same
home network can open Monize at `https://monize.local:<port>`, sign in, install
it as an app and receive push notifications, exactly as it can against a
server deployment. When it is off, which is the default, nothing changes: no
new listener, no firewall prompt, no multicast traffic.

In scope: the Windows shell (`desktop/`), the user guide
(`website/docs/windows.md`), and the shell's own strings. No backend or
frontend code change is expected (section 7 says why, and task N3 verifies
it).

Out of scope: reaching the app from the internet, any VPN integration
(Tailscale and similar keep working where they put the device on the same
network, but nothing here configures them), DNS-SD service browsing, macOS and
Linux builds.

## 2. Decisions

| ID | Decision | Why |
| --- | --- | --- |
| L1 | **Opt-in, off by default.** A tray item, "Allow other devices on my network", turns it on after a dialog that says what it does. The setting is persisted. | A finance app should not appear on the network because it was installed. The Windows Firewall prompt then appears in context, when the person asks for the feature, not at first start. |
| L2 | **The children stay loopback.** PostgreSQL, the backend and the frontend keep binding `127.0.0.1` exactly as now. The shell's main process runs one new listener, a TLS reverse proxy, which forwards to the frontend's loopback port and nowhere else. | The guard D4 relies on (`desktop/src/env.ts`, `desktop/src/env.spec.ts`) stays true and unchanged. One listener, owned by the shell, opt-in, is the whole attack surface. |
| L3 | **HTTPS only on the network.** The LAN listener speaks TLS. The one plain-HTTP exception is the setup path in L6. | Plain HTTP would carry the password, the session cookie and every figure across the network unencrypted, and browsers treat `http://192.168.x.x` as insecure: no service worker, no installable app, no Web Push, no `crypto.subtle`. All of those work on `http://127.0.0.1`, which is why the window needs none of this. |
| L4 | **A per-install root certificate authority, name-constrained.** On first enable the shell creates a root CA (ECDSA P-256, ten years) whose Name Constraints permit only `.local` names and the private address ranges, and issues the server certificate from it. The root's private key is wrapped with `safeStorage`, like the other secrets. | Devices trust the root once; the server certificate can then be reissued (new IP, new name, renewal) without anyone re-trusting anything. A self-signed server certificate would warn on every device and break the service worker, which refuses to register on a certificate error. The constraints mean the root cannot vouch for `bank.com` even if its key leaked; a platform that ignores them is no worse off than with an unconstrained root such as mkcert's. |
| L5 | **The server certificate names every address the app answers on**: the mDNS name (L7), `<computername>.local`, and each current private IPv4 and IPv6 address. It is valid for 397 days, and reissued on start when it has less than 30 days left or when any of those names or addresses changed. | iOS refuses a server certificate valid for more than 825 days even from a root the person added; 397 days stays inside every platform's limit and keeps renewal routine. Reissue on change keeps the IP fallback working after the router hands out a new address. |
| L6 | **The root certificate is exposed to the person, so they can install it on their devices.** A tray item, "Set up another device...", opens a window with: the address and a QR code for it; a QR code and a link that download the root certificate; "Save root certificate..." for sending it by AirDrop, email or USB; the root's SHA-256 fingerprint; and short steps for iOS, Android, Windows and macOS. While that window is open, and only then, the LAN listener answers one plain-HTTP path, `/monize-root.crt`, with the root certificate; every other plain-HTTP request is redirected to `https://`. | A phone has to download the root before it can trust the HTTPS address, and a download over HTTPS from an untrusted address warns first, which is confusing as the first step. The root certificate is public by nature; its private key never leaves the PC. The fingerprint on the PC screen is what the person can compare against the device's view of the certificate. The time limit keeps the plain-HTTP surface closed except during setup. |
| L7 | **The app advertises `monize.local` itself, over mDNS.** The shell runs an mDNS responder while LAN access is on. It probes before claiming the name (RFC 6762 section 8); on a conflict it claims `monize-2.local`, then `-3`, and persists the name it won, so the origin does not change from one start to the next. It answers only A and AAAA queries for that name, and only with the address of the network adapter the query arrived on. | A name that never changes keeps cookies, the installed app, its service-worker cache and push subscriptions on one origin, and is easy to type and document. Windows' own responder answers only for the computer name (often `DESKTOP-8F3K2QX`), and not at all on a network set to "Public". Answering per adapter is what stops a phone being handed a WSL, Hyper-V, Docker or VPN address it cannot reach. |
| L8 | **Fallback addresses.** `https://<computername>.local:<port>` and `https://<ip>:<port>` also work, and the setup window lists them. | The responder can fail to bind, the name can be lost to a conflict, and some older Android versions and some browsers do not resolve `.local` names. |
| L9 | **The proxy checks the Host and the Origin, and gives the backend one canonical origin.** It refuses a request whose `Host` is not one of the names or addresses in L5 (DNS rebinding), and a request whose `Origin`, when present, is not `https://` plus that `Host`. A request that passes is forwarded with its `Origin` replaced by the canonical LAN origin, `https://<mdns name>:<port>`, which the backend allows through `CORS_ORIGIN`. | The backend's allowed origins are fixed when it starts, but the IP fallback can change while the app runs. The proxy has already made the exact check the backend would make, so it hands on a verified value rather than every possible spelling of the same site. |
| L10 | **Only private peers.** The proxy closes connections from any source address outside 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7 and fe80::/10, and loopback. | It keeps the listener a LAN listener even if someone port-forwards it on their router by mistake. Tailscale's 100.64/10 is section 11, open question 2. |
| L11 | **The proxy marks every cookie it relays `Secure`, and appends the peer to `X-Forwarded-For`.** | The children run with `DISABLE_HTTPS_HEADERS=true`, because the window is plain HTTP, so the backend sets no `Secure` flag; on the LAN the transport is HTTPS, and a cookie set there must never travel in clear. Appending the peer is what the frontend's client-address code already expects of one trusted hop (`frontend/src/lib/client-address.ts`, `TRUSTED_PROXY_HOPS` defaults to 1), so each device gets its own rate-limit bucket. |
| L12 | **`PUBLIC_APP_URL` stays the loopback origin.** | It is the MCP issuer and the base of OIDC redirect registrations, which existing setups on this PC have registered. Changing it when the toggle flips would break them. Section 11, open question 1. |

## 3. How it fits together

```
phone ──https──> LAN listener (shell main process, 0.0.0.0 and ::, port 3382)
                   │  TLS with the L5 certificate
                   │  private peers only (L10), Host and Origin checked (L9)
                   │  Origin canonicalised, X-Forwarded-For appended, cookies Secure (L11)
                   └──http──> frontend 127.0.0.1:3380 ──> backend 127.0.0.1:3381 ──> PostgreSQL 127.0.0.1:5433
window ──http──> frontend 127.0.0.1:3380 (unchanged)

mDNS responder (shell main process, UDP 5353): monize.local -> the address of the adapter the query came in on
```

The proxy is Node's own `https` and `http` modules, streaming in both
directions: the MCP endpoint and any server-sent events must not be buffered.
It preserves `Host`, sets `X-Forwarded-Proto: https` and `X-Forwarded-Host`,
and forwards an `Upgrade` if one arrives. It stops when LAN access is turned
off and when the shell quits, after the children it fronts.

The LAN port is chosen and persisted like the other three
(`desktop/src/ports.ts`), from a default of 3382, but probed on the wildcard
address rather than on `127.0.0.1`, because that is where it will bind. A port
that moves changes every LAN origin, so a move is reported the way a moved
frontend port is.

## 4. Settings and storage

`config.json` (`desktop/src/app-config.ts`) is read strictly and is at version
1. LAN access adds a version 2 with:

- `lan.enabled` (boolean), `lan.port`, and `lan.hostname`: the mDNS name last
  won, or `null` before the first successful claim;
- the wrapped root CA private key, beside the existing secrets.

A version 1 file is read and rewritten as version 2 with LAN access off; any
other version stays a `ConfigError`, as today. The root certificate, the
server certificate and the server key (wrapped) live in a `tls/` directory
under the data directory.

- **Moving the data folder** (`desktop/src/move-data.ts`) carries `tls/` with
  everything else, so devices keep trusting the app after a move.
- **The recovery export does not include the root's key.** An install
  restored on another PC creates a new root, and its devices are set up
  again. A copy of a CA key is not something a recovery file should carry.
- **"Remove my data" at uninstall** removes `tls/` with the rest.
- **A "Replace root certificate..." action** (task N2) creates a new root and
  server certificate, for a PC that was compromised or given away. Every device
  then has to be set up again, and the dialog says so.

## 5. The certificate authority

- Root: ECDSA P-256, `basicConstraints` CA with path length 0, key usage
  `keyCertSign` and `cRLSign`, Name Constraints permitting DNS `.local` and the
  L10 IP ranges, subject `Monize on <computername>` so the person can tell
  roots apart on their phone.
- Server certificate: ECDSA P-256, extended key usage `serverAuth`, the L5
  subject alternative names, 397 days.
- Node's `crypto` makes the keys, but it cannot write an X.509 certificate,
  so a library is needed. It must be pure JavaScript (no native addon, so
  nothing to rebuild against Electron), able to write Name Constraints
  (directly, or as a raw DER extension), and maintained. Candidates are
  `@peculiar/x509`, `pkijs` and `node-forge`; task N2 picks one and names it in
  its PR, as `AGENTS.md` requires for any new dependency.

## 6. The mDNS responder

- Library: `multicast-dns` (pure JavaScript). Probing and conflict handling are
  ours to write: three probes 250 ms apart, then announce, and on a conflict
  the next suffix.
- One socket per IPv4 and IPv6 adapter that holds a private address, so each
  answer carries that adapter's address and nothing else.
- **Sharing UDP 5353 with Windows' own responder** (the DNS Client service
  listens there) is the riskiest assumption in this plan. Task N0 settles it on
  a real Windows 10 and 11 machine before anything else is built. If sharing
  does not work, the fallback is the Windows registration API
  (`DnsServiceRegister`, available on Windows 10; the minimum build is for N0
  to confirm) through a native call, which section 11 open question 4 would then
  have to approve.

## 7. Why the backend and frontend need no change

- **The backend's allowed origins** are `PUBLIC_APP_URL` and `CORS_ORIGIN`
  (`backend/src/main.ts`), and `CORS_ORIGIN` has no other use in the backend.
  The desktop sets `CORS_ORIGIN` to the canonical LAN origin when LAN access is
  on (L9), and to the loopback origin, as now, when it is off.
- **Cookies are host-scoped**, so the window and each device each hold their
  own session.
- **The frontend's CSP is `'self'`-based**, so it holds on any origin.
- **Client addresses**: one trusted hop, the proxy (L11), is exactly the
  frontend's default.
- **HTTPS headers**: `DISABLE_HTTPS_HEADERS=true` stays. HSTS on a `.local`
  name would outlive the feature being turned off, and the window is plain
  HTTP.

Task N3 tests each of these against a running stack. A finding that one is
wrong becomes an amendment to this section and a task of its own.

## 8. Guards

- `desktop/src/env.spec.ts`'s loopback assertions stay as they are, for both
  children and PostgreSQL. The only change is a case for `CORS_ORIGIN` with
  LAN access on.
- **LAN listener spec, with real sockets:**
  - it forwards only to the frontend's loopback port;
  - it refuses an unknown `Host`, a mismatched `Origin` and a public peer;
  - it marks relayed cookies `Secure`;
  - it answers plain HTTP only on `/monize-root.crt`, and only while setup is
    open.
- **Certificate spec**: the root has its Name Constraints and path length 0;
  the server certificate carries the expected names and validity, and is
  reissued on a changed address.
- **mDNS spec:**
  - it answers only for the claimed name, with the receiving adapter's
    address;
  - it steps to the next suffix on a conflict;
  - the persisted name wins over the default on the next start.
- **Off means off**: with `lan.enabled` false, nothing binds anything but
  loopback, and no UDP socket is opened.

## 9. User guide

`website/docs/windows.md` says, correctly today, that the app is reachable from
this PC only, and its "What the Windows App Cannot Do" table has rows for
using Monize from a phone and installing it there. Task N7 rewrites both to
point at the new section. That section covers:

- turning the feature on and what the firewall prompt means;
- setting up a device, per platform, with screenshots of the setup window;
- the addresses;
- what to do when `monize.local` does not resolve.

The privacy statement lists outside services. A listener and multicast on the
home network contact no outside service, but task N7 checks the statement says
nothing this plan makes untrue.

## 10. Risks

- **Port sharing and the firewall** are unproven on Windows (task N0).
- **Firewall rights.** Allowing a per-user program through Windows Firewall
  needs an administrator's approval. A standard account sees the prompt and
  cannot approve it; the enable dialog says so.
- **Name Constraints** are honoured by current Chrome, Safari and Android, as
  far as this plan knows. Task N0 checks iOS, Android Chrome and desktop
  browsers; a platform that ignores them still works, without the extra
  protection.
- **Installing a root** is the step people get wrong:
  - iOS needs the profile installed and then full trust turned on under
    Settings > General > About > Certificate Trust Settings;
  - Firefox keeps its own store;
  - Android hides the option under Encryption & credentials.

  The setup window's steps and the guide carry these.
- **The PC must be on, with Monize running**, for a device to reach it. The
  guide says so; "Start at login" exists.

## 11. Open questions

1. `PUBLIC_APP_URL` stays loopback (L12), so a link in an email opened on a
   phone points at `127.0.0.1`. Default: keep it loopback in v1, and revisit
   once MCP and OIDC can carry two origins.
2. Accept Tailscale's 100.64/10 as a private peer and put the Tailscale address
   in the certificate. Default: not in v1.
3. A QR code needs a small library (`qrcode`). Default: yes, because typing an
   address and a certificate link on a phone is the main friction.
4. If task N0 finds that UDP 5353 cannot be shared, use the native Windows API,
   or drop `monize.local` for `<computername>.local`. To be decided with N0's
   result.

## 12. Relationship to the installer plan

This supersedes decision D4 of `docs/future-plans/windows-installer.md` for
installs that turn the feature on, and answers its open question 2. That plan
is not edited, other than a line in its section 12 that points here, written
when task N1 lands.
