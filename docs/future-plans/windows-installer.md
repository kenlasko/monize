# Plan: Windows installer (Electron shell, embedded PostgreSQL)

Design for shipping Monize to Windows as one installer that a person runs and
then opens like any other desktop application. The task list is
`docs/future-plans/windows-installer-tasks.md`.

Status: **building**. The maintainer directed the build on 2026-11-13 without
opening a discussion; the section 11 questions were taken at their stated
defaults. Nothing in this document has shipped: the work is on local
`feat/desktop-*` branches (the task list records which). Written from the code
on 2026-10-19; section 12 lists what the build changed, and it wins where it
disagrees with an earlier section.

## 1. Goal

A Windows 10/11 x64 user downloads one file, `Monize-Setup-<version>.exe`,
runs it without administrator rights, and gets Monize as an application with a
Start Menu entry, a tray icon, automatic updates and an uninstaller. Nothing
else is installed first: no Docker, no WSL, no Node, no PostgreSQL. The
backend, the frontend and the migration pipeline run exactly as they do in the
containers, from the same built artifacts, at the same revision.

Out of scope for this plan: serving other machines on the LAN, macOS or Linux
desktop builds, a Microsoft Store listing, and the Android app (a separate
plan; section 3 says how the two relate).

## 2. Maintainer decisions

Recorded so a fresh session builds what was agreed. D11 was decided on
2026-10-19; the rest are the defaults this plan proposes and the discussion
confirms or corrects.

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Electron shell** (`electron` with the `electron-builder` NSIS target) supervises three local processes: PostgreSQL, the backend, the frontend. Its window loads `http://127.0.0.1:<port>`. | One installer, one icon, a tray, auto-update through `electron-updater` against the GitHub Releases feed the backend already polls (`backend/src/updates/updates.service.ts`), and `safeStorage` (DPAPI) for secrets. Neither layer is rewritten. |
| D2 | **The backend and the frontend run as child processes of Electron's own binary with `ELECTRON_RUN_AS_NODE=1`.** No separate `node.exe`. | The pattern VS Code uses. Electron 45.x bundles Node 24.22 (pinned 45.3.2; checked against the Electron release feed on 2026-11-13, when 40.x was already out of support), the same major CI tests on (`.github/workflows/ci.yml`). Nothing in either layer's runtime needs a native addon, so the Electron ABI question does not arise. Fallback if it ever does: ship `node.exe` as an extra resource. |
| D3 | **PostgreSQL 16 comes from `@embedded-postgres/windows-x64` (the zonky binaries), driven directly through `initdb` and `pg_ctl`; the `embedded-postgres` wrapper is not used (section 12).** Pinned to an exact 16.x version. | Real PostgreSQL, so RLS, the identity GUCs, advisory locks and the four contrib extensions behave exactly as in production. PGlite was rejected: one connection at a time, extensions must be preloaded, and it is untested against TypeORM pooling and the per-transaction RLS context. |
| D4 | **Single machine, single origin, loopback only.** Every listener binds `127.0.0.1`. | Windows Firewall never prompts, the database and the API are unreachable from the LAN, and cookies and CSP need no change. A LAN toggle is a later proposal. |
| D5 | **Same repository, a new `desktop/` workspace** with its own manifest, like `backend/`, `frontend/` and `e2e/`. | Lock-step with the two layers it bundles; the release workflow builds it from the same gated revision (REL-003, `docs/release-integrity.md`). |
| D6 | **Data lives under `%LOCALAPPDATA%\Monize\`**: `pgdata`, `backups`, `attachments`, `logs` and a `config.json`. The uninstaller keeps it unless the user ticks "Remove my data". | Per-user, so the installer needs no elevation (`perMachine: false`). |
| D7 | **`JWT_SECRET`, `ENCRYPTION_KEY` and `DATABASE_PASSWORD` are generated on first run and stored encrypted with Electron `safeStorage`** in the config file. A tray item reveals `ENCRYPTION_KEY` as a recovery key. | Losing `ENCRYPTION_KEY` makes TOTP secrets and every encrypted column unreadable (`docs/backup-restore-contract.md` section 8). DPAPI binds the stored copy to the Windows account, so the person must be able to export it. |
| D8 | **Ports are chosen once on first run and persisted** (defaults 3380 frontend, 3381 backend, 5433 PostgreSQL; a busy default is probed past and the result saved). | `PUBLIC_APP_URL` is a stable origin used by OIDC redirect registration, the MCP issuer and service-worker caches. A new port on every launch would break all three. |
| D9 | **Code signing through SignPath Foundation's free open-source programme first; Azure Artifact Signing is the paid alternative.** | Monize is AGPL, which qualifies. EV hardware tokens cannot run on GitHub-hosted runners. Unsigned builds work but sit behind SmartScreen. |
| D10 | **Web Push does not work inside the Electron window** (there is no push service). The tray offers "Open in browser", where the installed PWA and push keep working against the same local servers. A native notification bridge is a later task. | The push handlers in `frontend/public/sw.js` need a browser push service; the rest of the worker (offline cache, share target) is irrelevant on loopback. |
| D11 | **The Windows shell (Electron) and the Android shell (Capacitor, planned separately) stay independent.** They share one written contract that the web app offers to any shell, not a framework. | Capacitor has no Windows target: its desktop route is Electron underneath (`@capawesome/capacitor-electron` 0.2.2, pre-1.0, three months old; `@capacitor-community/electron` unmaintained since 2023). The shells do different jobs: Android is a thin client to a remote server, Windows hosts the server. Tauri 2 was the only single-codebase option and was declined. |

## 3. Relationship to the Android plan

`docs/future-plans/android-offline-app.md` puts a Capacitor WebView in a new
`mobile/` layer that loads a remote Monize origin, and adds an offline layer
to the frontend. The Windows app starts the server locally and shows it.
Their shells share nothing. What they share is a contract the web app exposes
to any shell, written once as `docs/frontend/shell-contract.md` (task F1) and
consumed by both:

- how a shell announces itself: Electron sets
  `window.__MONIZE_SHELL__ = { kind, version }` from its preload script; the
  Android plan already duck-types `window.Capacitor`, so the page's one
  detection helper reads the flag first and falls back to that, and the
  Android plan needs no change;
- the `monize://` deep-link scheme and which routes accept it;
- how a shell asks the page to open external links natively;
- the notification policy per shell (Web Push in a browser, a native bridge in
  Electron, FCM in Capacitor), so `PushEnableBanner` can hide itself where
  push cannot work;
- the rule that a shell never bypasses the same-origin cookie auth.

The two plans also touch the same shared files, each adding a workspace:
the license-check and npm-audit matrices and the `release` job in
`.github/workflows/ci.yml`, the "Read when the work touches it" table in
`frontend/CLAUDE.md`, `ROOTED` in `backend/src/common/repo-paths.util.ts`
and the manifests collector in `scripts/check-docs-manifests.mjs`. Whoever
builds first names the other plan in the PR so the maintainer sequences them
(shared-area work under `CONTRIBUTING.md`); tasks D1, F1 and C2 say what to
do when the Android side has not landed. Nothing in this plan waits for the
Android work.

## 4. What the layers need at runtime

Read from the code on 2026-10-19.

| Layer | Need | Where it is decided |
| --- | --- | --- |
| Backend | Node 24. PostgreSQL 16 with `uuid-ossp`, `pgcrypto`, `pg_trgm` and `btree_gist` (all contrib, created by `database/schema.sql`). No Redis, no queue, no second process; every cron is in-process under `ScheduleModule`. No native addons: `bcryptjs`, pure `pg`. | `backend/Dockerfile`, `backend/src/app.module.ts` |
| Backend boot | `node dist/db-init.js`, then `node dist/db-migrate.js`, then `node dist/main.js`, each exiting non-zero on failure. `schema.sql`, `migrations/` and `release-notes/` are looked up beside `dist/`. The database and role must already exist: db-init never runs `CREATE DATABASE`. | `backend/docker-entrypoint.sh`, `backend/src/db-init.ts`, `backend/src/db-migrate.ts` |
| Backend env | Refuses to start without `JWT_SECRET` and `ENCRYPTION_KEY` (32+ characters) and `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME`. `PORT` defaults to 3001. VAPID and OIDC signing keys are generated into the database on first use. First registered user becomes admin; there is no seed and no wizard. | `backend/src/main.ts`, `backend/src/push/push-config.service.ts`, `backend/src/auth/auth.service.ts` |
| Backend disk | Attachments (only with the `local` provider) under `ATTACHMENT_CONTAINER_DIR`, sharded through `shardedSegments`, Windows-safe. Automatic backups under `BACKUP_CONTAINER_DIR` through `atomic-file.ts`. | `backend/src/attachments/storage/local-storage.provider.ts`, `backend/src/backup/atomic-file.ts` |
| Frontend | `output: 'standalone'`: a Node server is mandatory. `src/proxy.ts` forwards `/api/*`, `/oauth*` and the well-known paths to `INTERNAL_API_URL`; the browser only talks same-origin with httpOnly cookies. No WebAuthn. The VAPID public key is fetched at runtime from `GET /push/config`. | `frontend/next.config.js`, `frontend/src/proxy.ts`, `frontend/src/lib/backend-forward.ts`, `frontend/src/lib/push.ts` |
| Frontend boot | `node --require ./server-log-format.cjs server.js` with `PORT`, `HOSTNAME`, `NODE_ENV=production`; `.next/static` and `public/` copied beside the standalone output. | `frontend/Dockerfile` |
| Both | Plain HTTP is supported with `DISABLE_HTTPS_HEADERS=true` (drops HSTS and COOP; cookies lose `Secure`). `PUBLIC_APP_URL` must equal the origin the window loads: OIDC callbacks, the MCP OAuth issuer and email links are built from it. | `backend/src/main.ts`, `backend/src/auth/auth.controller.ts`, `backend/src/common/csrf.util.ts` |
| Build | Both layers must be installed and built on Windows: the frontend's `node_modules` carries linux-only binaries for `@next/swc`, `lightningcss` and sharp, and the backend's Dockerfile passes `--libc=musl`. `patch-package` pins `next@16.4.2`. | `frontend/package.json`, `backend/Dockerfile` |

## 5. Why this is non-trivial here (current state)

- **Local automatic backups are POSIX-only.** `validateFolderPath` in
  `backend/src/backup/storage/local-backup-storage.target.ts` requires a
  leading `/`, `safePath` checks `startsWith(basePath + "/")`, and
  `backend/src/backup/backup-paths.ts` splits `BACKUP_ALLOWED_ROOTS` on `:`
  and keeps only entries starting with `/`. On Windows every automatic backup
  is rejected as path traversal. This is a defect on any Windows host, not an
  installer concern, and it is fixed first (B1).
- **The backend binds every interface.** `app.listen(port)` takes no host.
  D4 needs `127.0.0.1`, so a `HOST` variable is added (B2). The frontend's
  standalone server already honours `HOSTNAME`.
- **The release pipeline publishes container images only.** Every workflow
  runs on `ubuntu-latest`; GitHub Releases carry no binary assets. A Windows
  runner job and three release assets are new (C1, C2), and
  `docs/release-integrity.md` section 7 applies to the PR that adds them.
- **The repository's guards do not know a fourth workspace.**
  `backend/src/common/repo-paths.util.ts` lists the rooted prefixes a doc may
  claim; `scripts/check-docs-manifests.mjs` collects `npm run` scripts from
  four manifests; the license-check matrix, `npm audit`, dependabot and
  lint-staged each enumerate workspaces. D1 adds `desktop` to each.
- **The update banner would mislead.** The backend's update check points at
  container images. In the desktop build it is disabled
  (`UPDATE_CHECK_ENABLED=false`) and the Electron updater owns updates.
- **Web Push cannot work in the window** (D10). The shell contract (F1) is
  how the page learns that and hides the Enable banner.

## 6. Architecture

```text
Monize.exe (Electron main process)
  supervisor/postgres.ts   embedded-postgres: initdb once, pg_ctl start on 127.0.0.1:5433, pg_ctl stop on quit
  supervisor/backend.ts    ELECTRON_RUN_AS_NODE child: db-init.js, db-migrate.js, main.js on 127.0.0.1:3381
  supervisor/frontend.ts   ELECTRON_RUN_AS_NODE child: server.js on 127.0.0.1:3380, INTERNAL_API_URL -> :3381
  window.ts                BrowserWindow loads http://127.0.0.1:3380 once /api/v1/health/ready answers 200
  tray.ts                  Open / Open in browser / Show logs / Show recovery key / Check for updates / Quit
  updater.ts               electron-updater, GitHub provider

<install dir>\resources\   backend\  frontend\  postgres\   (extraResources, outside the asar)
%LOCALAPPDATA%\Monize\     pgdata\  backups\  attachments\  logs\  config.json
```

Boot order: PostgreSQL ready, then db-init, then db-migrate, then the backend
until its readiness route answers, then the frontend until its liveness route
answers, then the window. A failure at any step shows the log tail in the
splash window and offers Quit and Retry; nothing later starts.

Environment handed to the backend children (every variable is read at runtime
by the code named in section 4):

```text
NODE_ENV=production  PORT=3381  HOST=127.0.0.1  TZ=UTC
DATABASE_HOST=127.0.0.1  DATABASE_PORT=5433  DATABASE_USER=monize  DATABASE_PASSWORD=<generated>  DATABASE_NAME=monize
RLS_MODE=enforce  DATABASE_APP_USER=monize_app  DATABASE_APP_PASSWORD=<generated>   (section 12, item 16)
JWT_SECRET=<generated>  ENCRYPTION_KEY=<generated>
PUBLIC_APP_URL=http://127.0.0.1:3380  CORS_ORIGIN=http://127.0.0.1:3380  DISABLE_HTTPS_HEADERS=true
BACKUP_CONTAINER_DIR=%LOCALAPPDATA%\Monize\backups  ATTACHMENT_CONTAINER_DIR=%LOCALAPPDATA%\Monize\attachments
BACKUP_ALLOWED_ROOTS=%LOCALAPPDATA%\Monize\backups
UPDATE_CHECK_ENABLED=false
```

Frontend child: `PORT=3380 HOSTNAME=127.0.0.1 NODE_ENV=production
INTERNAL_API_URL=http://127.0.0.1:3381 DISABLE_HTTPS_HEADERS=true`.

`TZ=UTC` matches the containers: crons without an explicit zone follow process
local time and the date helpers assume UTC.

## 7. Work packages

Each names its mechanism, the test kind it owes, and its deploy impact. The
task list splits them into one-PR tasks.

**WP0. Plan and contract.** This document, the task list, the discussion, and
`docs/frontend/shell-contract.md` written with the Android plan. *Tests: the
doc guards. Deploy impact: none.*

**WP1. Backend portability.** The backup path fix (B1) and `HOST` (B2), both
Linux-testable, both behaviour-preserving on POSIX. *Tests: unit, with the
Windows path module substituted the way `jest-config.guard.spec.ts` already
does. Deploy impact: neutral.*

**WP2. Repository wiring and the desktop workspace.** The guard and tooling
entries for a fourth workspace (D1), then the package with config, secrets,
ports, the supervisor state machine, window and tray (D2 to D4), runnable
against a locally built backend and frontend and an external PostgreSQL.
*Tests: jest in the desktop package, Linux-runnable with a fake spawner.
Deploy impact: neutral.*

**WP3. Embedded PostgreSQL** (D5). *Tests: a Windows-only smoke script run by
C1. Deploy impact: neutral.*

**WP4. Installer** (D6, D7): the staging script, the electron-builder
configuration, the NSIS include, an unsigned local build, and the manual
acceptance list. *Deploy impact: neutral.*

**WP5. CI and release** (C1, C2, D8): a `windows-latest` job that builds and
smoke-tests the installer on every PR; the release job attaches the installer,
`latest.yml` and the blockmap; the updater in the app. *Deploy impact: a new
CI job and three release assets.*

**WP6. Signing** (C3). *Deploy impact: release path.*

**WP7. Surface and polish** (F2, Q1, D9): the page honours the shell contract,
README and website gain a Windows section, launch at login, the notification
bridge, the recovery-key dialog. *Deploy impact: neutral.*

## 8. Guards to add

- A desktop unit test that the composed child environment always carries
  `HOST=127.0.0.1` and `HOSTNAME=127.0.0.1` and never an empty
  `ENCRYPTION_KEY` or `JWT_SECRET` (D4, D7). A loopback-only shell is the one
  property this plan cannot afford to lose silently.
- The existing guards, extended rather than bypassed: `ROOTED` gains
  `desktop/`; the manifests collector gains `desktop`; the zero-discovery scan
  in `jest-config.guard.spec.ts` already covers any new manifest and jest
  config, so the desktop jest config must not set `passWithNoTests`.

No new entry in `docs/system-invariants.md`: this plan touches no financial
semantics and no cross-layer data rule. The backup path fix is covered by the
existing backup entries.

## 9. Rollout order and deployment safety

1. WP0 and WP1 are neutral and land first; WP1 fixes a real defect for anyone
   already running the backend on Windows.
2. WP2 to WP4 add files nobody deploys until C2 attaches them to a release.
3. C1 runs on every PR before C2 exists, so a broken Windows build blocks a
   merge, not a release.
4. C2 is the one change to the release path and carries the section 7
   statement from `docs/release-integrity.md`.
5. Upgrades are in place: the new backend runs `db-migrate` against the same
   `pgdata` on the next launch, exactly as a container upgrade does
   (`docs/database-migrations.md`). A PostgreSQL major bump is its own plan
   and uses `pg_upgrade`; dependabot must not move the pinned 16.x package
   across a major.

## 10. Assumptions a fresh session should check

- `backend/docker-entrypoint.sh` still runs db-init, db-migrate, then main,
  and nothing else is required before `main.js` listens.
- `frontend/src/proxy.ts` is still the only route from the browser to the
  API, and `frontend/src/lib/api.ts` still uses a relative `baseURL`.
- No runtime dependency of either layer has gained a native addon
  (`grep -l '"install"\|gyp' */package.json` and the lockfiles).
- Electron's bundled Node is still at or above the backend's engine floor;
  `npm view electron@<pinned> --json` reports it.
- `@embedded-postgres/windows-x64` still publishes a 16.x line; on 2026-10-19
  the newest was 16.14.0-beta.17.
- `PUBLIC_APP_URL` is still runtime-read by the backend and build-inlined but
  unused by the frontend (`frontend/next.config.js`).
- The SignPath Foundation programme still accepts AGPL projects (D9).

## 11. Open questions

1. Electron window as the primary surface (D1) versus a tray-only supervisor
   that opens the default browser, which keeps Web Push working. Default:
   window plus "Open in browser".
2. Loopback only (D4) versus an opt-in LAN toggle. Default: loopback in v1.
3. Signing route (D9). Default: SignPath first.
4. Whether the Windows build is part of every release from the start.
   Default: yes, once C1 has been green for a few releases.

## 12. Amendments made while building (2026-11-13)

Each is a decision the build made against the text above, with its reason.

1. **No `embedded-postgres` wrapper (D3).** Its 16.x line is ESM-only,
   resolves binaries from `node_modules` rather than a directory the shell
   chooses, registers its own exit hook, and stops PostgreSQL on Windows with
   `taskkill /f`, which is a crash stop. The runner drives `initdb` and
   `pg_ctl` from `resources/postgres/bin` itself. Both the Windows and the
   Linux binary package are optional dependencies at one exact version
   (16.15.0-beta.19), so `npm ci` works on either system and the runner is
   tested against real binaries on Linux.
2. **Data checksums.** The cluster is created with `--data-checksums`. The
   binary packages carry no `pg_checksums`, so initdb is the only moment the
   choice exists.
3. **Server settings are passed on every start** (`pg_ctl -o`): loopback
   only, the persisted port, no unix socket, `timezone=UTC` (initdb otherwise
   writes the machine's zone into `postgresql.conf`, and the backend assumes
   UTC).
4. **Staging includes `help/`.** This plan predates in-app help; the backend
   image now carries the guide text and its screenshots, so the staged
   backend does too. The staging manifest is checked against every `COPY` of
   both production Dockerfile stages, so the next such addition fails a spec
   instead of being missed.
5. **Boot and environment are guarded against drift.** A spec compares the
   supervisor's commands with `backend/docker-entrypoint.sh` and the
   frontend image's `CMD`; another holds every variable the child
   environments carry to the documented set. A backend boot step or a renamed
   variable turns the desktop suite red rather than needing a second,
   remembered change.
6. **One runtime module, bootable without Electron.** The composition of
   config, secrets, the PostgreSQL runner and the supervisor lives in one
   module that the Electron main process and a development script both call,
   so the whole stack is exercised on Linux under plain Node.
7. **Children end with the shell.** A desktop-owned preload exits a backend
   or frontend child when its stdin pipe closes, which is what the operating
   system does when the shell dies. Without it a killed shell left both
   listening, and the next launch moved the ports (D8). On start the shell
   also stops a database server left by an earlier session and waits up to
   5 s for the persisted ports before it moves one.
8. **Children are stopped by termination on Windows.** The backend has no
   shutdown hook, so a container stop already ends it without running its
   code; PostgreSQL rolls back what was in flight and backup files are
   written through a temp-file-then-rename helper.
9. **The child environment is an allowlist**, not the parent's environment
   plus overrides, so a user-level `DATABASE_HOST` or `NODE_OPTIONS` cannot
   change what the application does. `HOST` and `HOSTNAME` are both set in
   both children.
10. **`dataDir` is not stored in `config.json`** (D6): a pointer kept inside
    the directory it points to is useless. "Move data folder" (D9) needs
    another home for it.
11. **Attachments stay in the database.** Section 6 sets
    `ATTACHMENT_CONTAINER_DIR` but not the provider, so the backend keeps its
    default (`database`) and the folder is unused; a backup of `pgdata` then
    holds everything.
12. **Settings that exist only as environment variables are not reachable**
    in the desktop build (SMTP, OIDC, the system default AI provider). The
    shell composes the environment itself; a way to add to it is a later
    proposal.
13. **The shell's own strings are English only.** It has no i18n framework;
    every string sits in one keyed module so that can change.
14. **The PostgreSQL executables need the VC++ runtime** and the package
    ships none; the installer carries it app-local (D7). GitHub's Windows
    runners have it installed, so CI alone will not catch its absence.
15. **Size.** The staged tree is about 620 MB before compression; the
    backend's production `node_modules` is 279 MB of it.
16. **Row-level security is enforced** (decided by the maintainer on
    2026-11-14). The cluster's owner is a superuser, and a superuser bypasses
    every policy, so the backend connects as the unprivileged `monize_app`
    role with `RLS_MODE=enforce`. A fourth secret, the role's password, is
    generated on first run and stored like the other three; db-init creates
    the role and rotates its password on every start. The container
    deployments default to `RLS_MODE=off`, so the desktop build is the first
    to run every UI flow with policies in force: a flow that fails only under
    enforcement shows up here first. The install smoke test asserts the
    backend's own "enforce verified" line.
17. **The desktop's backend `node_modules` differs from the image's by exactly
    the files Node never executes**: declaration files, source maps,
    TypeScript sources and Markdown (licences are kept), removed to cut the
    installer's file count, since every file is written twice and scanned by
    Defender. A check after the prune (`desktop/scripts/lib/prune-check.mjs`)
    holds it: every `main`, `module`, `bin` and `exports` target of every
    package must still resolve, or staging fails naming the package.

