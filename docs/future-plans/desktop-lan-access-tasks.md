# Windows app on the local network: Agent Task List

> Companion to [`desktop-lan-access.md`](./desktop-lan-access.md) (the plan).
> Each task is one PR. Mark a task done by checking its box and recording the
> commits under it. The maintainer approved the plan's recommendations,
> including the mDNS name, on 2026-11-17; the open questions in section 11 take
> their defaults unless a task records otherwise.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task names the files it may touch.
  Touching files outside that scope is a scope violation: stop and leave a
  note under the task instead.
- **Terminology:** "the plan" = `desktop-lan-access.md`. Decision references
  (L1 to L12) point there. Re-locate code by symbol, never by line.
- **Windows acceptance.** N0 and the acceptance of N4, N5 and N8 need a
  Windows 10/11 x64 machine on a home network with a phone (iOS and Android
  both, where possible). Their unit tests still run on Linux.
- **New dependencies are ask-first.** N2 (certificate library), N4
  (`multicast-dns`) and N5 (`qrcode`) each name the package, its version, its
  licence and its maintenance state in the PR, and add it to the desktop
  workspace only, pinned exactly like the others.
- **Definition of done for every task:**
  - `desktop/`: its `lint`, `typecheck` and `test` scripts, all clean;
  - `node scripts/check-docs-manifests.mjs` when a doc changed;
  - new files staged (`git add -N`) before a tree-walking guard runs;
  - no emojis, and no `console.log` outside the desktop's own logger.

## Task graph

| ID | Task | Depends on | Status |
| --- | --- | --- | --- |
| N0 | Windows spike: UDP 5353 shared with the DNS Client service, the firewall prompt for a TLS listener and a UDP socket, Name Constraints on iOS, Android Chrome, desktop Chrome, Edge and Firefox | -- | [ ] |
| N1 | Config version 2 (`lan.enabled`, `lan.port`, `lan.hostname`, the wrapped CA key), the v1 read path, the LAN port in `ports.ts` probed on the wildcard address | N0 | [ ] |
| N2 | Certificate authority: root and server certificates, storage under `tls/`, renewal and reissue on change, "Replace root certificate..." | N1 | [ ] |
| N3 | LAN listener: TLS proxy to the frontend, Host and Origin checks, Origin canonicalisation, private peers only, `Secure` cookies, `X-Forwarded-For`, streaming; `CORS_ORIGIN` with LAN access on; the section 7 checks against a running stack | N2 | [ ] |
| N4 | mDNS responder: per-adapter sockets, probing, conflict suffixes, the persisted name | N1 | [ ] |
| N5 | Tray and windows: the toggle and its enable dialog, "Set up another device..." (addresses, QR codes, root download and save, fingerprint, per-platform steps), the timed plain-HTTP setup path | N3, N4 | [ ] |
| N6 | Data-folder move carries `tls/`; uninstall's "Remove my data" covers it; the recovery export stays without the CA key (a spec says so) | N2 | [ ] |
| N7 | User guide: `website/docs/windows.md` (the new section, its screenshots, the "cannot do" rows), the privacy statement check, `desktop/README.md`, the pointer line in the installer plan's section 12 | N5 | [ ] |
| N8 | Windows acceptance: the checklist below, on a packaged build | N5, N6, N7 | [ ] |

N0 can change the plan. Its result is written into the plan as an amendment
(a section 13, "Amendments made while building") before N1 starts, and open
question 4 is settled there.

## Task details

### N0. Windows spike

Throwaway scripts in the scratch space, run with Monize.exe's own Node
(`ELECTRON_RUN_AS_NODE=1`), nothing committed but the amendment.

- Bind UDP 5353 with `reuseAddr` beside Windows' responder, join the group on
  each adapter, and answer a query for `monize.local` from an iPhone, an
  Android phone and another Windows PC. Record what the firewall prompt offers
  and whether one approval covers both the TCP listener and the UDP socket.
- Issue a name-constrained root and a server certificate with a candidate
  library, install the root on each device, and record which platforms
  enforce the constraint (a certificate for a name outside it must fail).
- Confirm that Windows' responder still answers for `<computername>.local`
  while ours runs.

### N3. LAN listener (scope)

`desktop/src/lan/` (new), `desktop/src/env.ts` and its spec,
`desktop/src/runtime.ts` for the wiring. If the section 7 checks find a
backend or frontend change is needed, stop: it becomes its own task, with that
layer's checks.

### N8. Acceptance checklist

1. With the feature off: no listener but loopback (`netstat -ano`), no UDP
   5353 socket owned by Monize.exe, no firewall prompt.
2. Turn it on: the firewall prompt appears once; `https://monize.local:3382`
   opens on an iPhone and on an Android phone after the root is installed from
   the setup window, with no warning.
3. On the phone: sign in, install the app, receive a push notification, use it
   with the PC's IP changed (DHCP renewal or a static change), and confirm it
   still works without re-trusting anything.
4. A second Monize PC on the same network claims `monize-2.local`, and keeps
   it after a restart.
5. A request with a foreign `Host`, and one from a public source address
   (simulated), are refused.
6. Turn it off: the listener and the responder are gone, and the phone cannot
   connect.
7. Move the data folder: the phone keeps working without setting it up again.
