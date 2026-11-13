# Windows Installer: Agent Task List

> Companion to [`windows-installer.md`](./windows-installer.md) (the plan).
> Each task is one PR. Mark a task done by checking its box and recording the
> commits under it. Discussion: none opened; the maintainer directed the build
> on 2026-11-13 and the open questions took their defaults (plan section 12
> records what the build then changed). Nothing is pushed: each task is a
> local branch, listed under "Build record" below.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task names the files it may touch.
  Touching files outside that scope is a scope violation: stop and leave a
  note under the task instead.
- **Terminology:** "the plan" = `windows-installer.md`. Section and decision
  references (D1 to D11) point there. Re-locate code by symbol, never by line.
- **Two kinds of task.** B, F and Q tasks are ordinary repository work and run
  on Linux. D and C tasks need a Windows 10/11 x64 machine (a VM is fine) for
  their acceptance; their unit tests still run on Linux.
- **Ask-first scope.** D1, C1, C2 and C3 touch `.github/` or the release path,
  which `AGENTS.md` lists under "Ask first". The discussion (P1) records the
  maintainer's agreement to each before it starts; the PR links it.
- **The desktop workspace is `desktop/`.** Its scripts are run as
  `npm --prefix desktop run <script>` from the repository root until D1 lands;
  after D1 the manifests collector knows the directory and the plain form is
  fine from inside it.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, then
    `npm run test:changed`.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`,
    then `npm run test:changed`, then `npm run build`.
  - `desktop/`: its `lint`, `typecheck` and `test` scripts, all clean.
  - Repository root: `node scripts/check-env-docs.mjs` when an env var was
    added; `node scripts/check-docs-manifests.mjs` when a doc changed.
  - Stage new files before running a tree-walking guard (`git add -N` is
    enough): `doc-paths.spec.ts`, `source-comment-paths.spec.ts`,
    `jest-config.guard.spec.ts`, `ci-images.guard.spec.ts`.
  - New user-facing strings: English catalogs, then `npm run i18n:pseudo`,
    then every locale as the PR's final commit.
  - No emojis, no `console.log` outside the desktop package's own logger, no
    new dependency without naming it in the PR.

## Deployment safety classes

| Class | Meaning |
| --- | --- |
| none | Docs or CI only; no artifact changes |
| neutral | Code changes with no behaviour change for the container deployments |
| release | Changes what a release publishes; carries the `docs/release-integrity.md` section 7 statement |

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
| --- | --- | --- | --- | --- |
| P1 | Open the discussion, settle the open questions, obtain `approved-to-build` | -- | none | superseded: built on the maintainer's direction |
| B1 | Backup local storage: Windows-safe path validation and `BACKUP_ALLOWED_ROOTS` separator | P1 | neutral | [x] |
| B2 | `HOST` for the backend listener | P1 | neutral | [x] |
| F1 | `docs/frontend/shell-contract.md` and its index row, written with the Android plan | P1 | none | [x] |
| D1 | Repository wiring for a fourth workspace: guards, manifests collector, ignore files, dependabot, license and audit matrices | P1 | none | [x] |
| D2 | Desktop package: config, secrets, ports, logger, unit tests | D1 | neutral | [x] |
| D3 | Supervisor: child spawner, boot state machine, backend and frontend runners, health polling | D2, B2 | neutral | [x] on Linux; Windows acceptance open |
| D4 | Window, preload, tray, splash, external links | D3, F1 | neutral | [x] on Linux; Windows acceptance open |
| D5 | Embedded PostgreSQL runner | D3 | neutral | [x] on Linux; Windows acceptance open |
| D6 | Staging script: assemble backend, frontend and database files for packaging | D3 | neutral | [x] |
| D7 | electron-builder configuration, NSIS include, unsigned local build, manual acceptance | D4, D5, D6, B1 | neutral | [ ] |
| C1 | CI job on `windows-latest`: build, package, smoke-test, upload artifact | D7 | none | [ ] |
| D8 | Updater against GitHub Releases | D7 | neutral | [ ] |
| C2 | Release job attaches the installer, `latest.yml` and the blockmap | C1, D8 | release | [ ] |
| C3 | Code signing | C2 | release | [ ] |
| F2 | The page honours the shell contract: shell flag, push banner, external links | F1, D4 | neutral | [x] |
| Q1 | README, website and docs: the Windows install path | C2 | none | [ ] |
| D9 | Polish: launch at login, notification bridge, recovery-key dialog, log viewer | D8, F2 | neutral | [ ] |

## Build record

Branches are local and unpushed. Each is based on what it depends on, so they
can be opened as PRs in the order of the task graph. `feat/desktop-integration`
merges them all and is where the whole stack was run.

| Task | Branch | Commits | Verified |
| --- | --- | --- | --- |
| B1 | `feat/desktop-b1-backup-windows-paths` | ff53b828c | Specs through `path.win32`; the four Windows cases fail on the old code |
| B2 | `feat/desktop-b2-backend-host` | 6bcccfaf9 | Unit spec; a real boot logs `bound to 127.0.0.1` |
| F1 | `feat/desktop-f1-shell-contract` | bb07f53cc | Doc guards |
| F2 | `feat/desktop-f2-page-honours-shell` | 43137d2e4, 2550faccf, f7c96f406 | Vitest for the helper and both push controls; checked in the Electron window |
| D1 | `feat/desktop-d1-workspace-wiring` | a1337b8ea | Guard specs, manifest collector. It also adds the desktop manifest to the release job's version bump, which is a release-path edit |
| D2 | `feat/desktop-d2-config-secrets-ports` | b593033c3, 082064891, 4ba4bf93e | Desktop suite |
| D3 | `feat/desktop-d3-supervisor` | 10c3bb780, 1e4be779f, 68041f740 | Desktop suite with fakes; real boot on Linux |
| D3b | `feat/desktop-d3b-orphan-guard` | d86107efb | Real-process specs; `kill -9` of the shell frees both ports in under 2 s |
| D4 | `feat/desktop-d4-electron-shell` | 2577bd73a, 7962a0ba0 | Real Electron launch on Linux (WSLg): splash, login page, second launch, `--quit`, deep links |
| D5 | `feat/desktop-d5-postgres-runner` | ab5eaf58b, 7934511e1, b7828e4ae | `npm run smoke:postgres` against the real 16.15 Linux binaries, 13 steps |
| D6 | `feat/desktop-d6-staging-script` | 2b2599b83 | A real staging run; the Dockerfile guard proven red |
| runtime | `feat/desktop-integration` | bf165a666, 483e52399 | The runtime module, `dev-boot`, and the `HOST` exemption removed once B2 and D2 met |

D3b is a task this list did not have: backend and frontend children exit when
the shell that spawned them dies (plan section 12, item 7).

Not run anywhere yet: anything on Windows. D3, D4 and D5 each leave a
Windows checklist in the desktop README; C1 is the first place they can run.

## Suggested order

1. P1.
2. In parallel: B1, B2, F1, D1.
3. D2, then D3, then D4, D5 and D6 in parallel.
4. D7 (first installable build), then C1.
5. D8, then C2, then C3.
6. F2, Q1, D9.

---

## P1: Discussion and approval

Open a Discussion carrying the plan's section 2 table and section 11
questions. Record the answers back into the plan's decisions table in the
same PR that adds the `approved-to-build` label reference here.

**Acceptance:** the discussion number replaces "not yet opened" at the top of
this file and in the plan's status line; every D-row the maintainer changed
is rewritten in the plan; the ask-first items (D1, C1, C2, C3) are each named
and agreed in the discussion.

## B1: Backup local storage on Windows

Files:
- `backend/src/backup/storage/local-backup-storage.target.ts` (+ spec)
- `backend/src/backup/backup-paths.ts` (+ spec)
- `.env.example` (the `BACKUP_ALLOWED_ROOTS` comment: separator is the
  platform's path-list delimiter)
- `docs/backend/backup.md` if it states the leading-slash rule

Pattern: `backend/src/common/jest-config.guard.spec.ts` already proves a
Windows-path case by exercising `path.win32`; follow it rather than mocking
`process.platform`.

Steps:
1. In `validateFolderPath`, replace the leading-slash test with
   `path.isAbsolute` and the `resolve(x) === x` identity with a comparison
   against `path.normalize(path.resolve(x))`, so `C:\Users\...` and
   `/data/backups` both validate on their own platform. Keep the symlink and
   realpath checks exactly as they are.
2. In `safePath`, build the boundary as `basePath + path.sep` and compare the
   resolved candidate against it. Keep the "resolved path must start inside
   the base" rule; only the separator changes.
3. In `backup-paths.ts`, split `BACKUP_ALLOWED_ROOTS` on `path.delimiter` and
   accept any `path.isAbsolute` entry. On POSIX `path.delimiter` is `:` and
   `isAbsolute` is the leading slash, so behaviour there is unchanged.
4. Add specs that run the same assertions through `path.win32` with
   `C:\Monize\backups` as the base, and the traversal cases
   (`..\..\Windows`, a drive change `D:\x`, a UNC path) still refused.

**Acceptance:**
- The new Windows cases fail on the current code and pass after the change.
- Every existing spec in the two files passes unchanged.
- `npm run test:changed` is green; `node scripts/check-env-docs.mjs` is green.

**Traps:** the fallback in the constructor logs and uses the raw default when
validation fails; after this change the default `/data/backups` resolves on
Windows to a drive-relative path, which `isAbsolute` accepts, so the installer
must always pass an explicit `BACKUP_CONTAINER_DIR` (it does, plan section 6).

## B2: `HOST` for the backend listener

Files:
- `backend/src/main.ts`
- `.env.example`
- `docs/backend/modules-and-runtime.md` (the env table)

Steps:
1. Read `HOST` beside `PORT`. When set, call `app.listen(port, host)`; when
   unset, keep `app.listen(port)` so the containers are unchanged.
2. Log the bound address on the existing startup line.
3. Document it in `.env.example` with the comment that the desktop build sets
   `127.0.0.1` and containers leave it unset.

**Acceptance:** `npm run build` succeeds; a local run with `HOST=127.0.0.1`
answers on loopback and refuses on the machine's LAN address;
`node scripts/check-env-docs.mjs` is green.

## F1: The shell contract

Files:
- `docs/frontend/shell-contract.md` (new)
- `frontend/CLAUDE.md` (one row in "Read when the work touches it", beside
  the push row, pointing at the new doc)

Write it with the author of the Android plan (`android-offline-app.md`, whose
own docs task adds `docs/frontend/offline.md` and a row to the same table);
whichever PR lands first names the other. The doc is a binding contract:
`doc-paths.spec.ts` scans `docs/frontend/*.md` strictly, so every path it
names must exist. Name only files that already exist or describe planned
files in prose without a path.

Contents (plan section 3), each as a short section with the rule and the
reason:

1. **Announcing a shell.** `window.__MONIZE_SHELL__` is `{ kind: 'electron' |
   'capacitor', version: string }` or absent. Electron sets it from its
   preload before any page script runs (`contextIsolation` on, a
   `contextBridge` exposure). One page helper, `detectShell()`, reads the
   flag first and otherwise duck-types `window.Capacitor` as `capacitor`, the
   check the Android plan already makes, so that plan needs no change. The
   page treats neither as "a browser".
2. **Capabilities, not kinds.** The page asks `canReceivePush`,
   `opensExternalLinksNatively`, `supportsDeepLinks`, derived from `kind` in
   one helper the page owns, so a new shell kind changes one file.
3. **Deep links.** The `monize://` scheme and the routes that accept it
   (initially `monize://open/<path>` mapped onto the app's own routes).
4. **External links.** A shell that opens links natively intercepts
   navigations to foreign origins; the page keeps using ordinary anchors.
5. **Notifications.** Web Push in a browser; a native bridge in Electron; FCM
   in Capacitor. `PushEnableBanner` and the push settings panel hide their
   Enable control when `canReceivePush` is false and say why.
6. **Auth is never bypassed.** The shell holds no token; the page's
   same-origin cookies are the only session.

**Acceptance:** `doc-paths.spec.ts`, `instruction-files.spec.ts` and
`node scripts/check-docs-manifests.mjs` are green with the new doc staged.

## D1: Repository wiring for a fourth workspace

Files:
- `backend/src/common/repo-paths.util.ts` (`ROOTED` gains `desktop/`; its
  unit test gains a case)
- `scripts/check-docs-manifests.mjs` (`collectScriptNames` gains `desktop`)
- `.dockerignore` (add `desktop`, beside `website`; the backend build
  context is the repository root)
- `.lintstagedrc.cjs` (the desktop package's TypeScript under the same
  eslint and prettier rules)
- `.github/dependabot.yml` (a `/desktop` npm entry copied from `/frontend`,
  with an `ignore` for `@embedded-postgres/windows-x64` major updates and an
  `ignore` for `electron` majors, each with its reason in a comment)
- `.github/workflows/ci.yml` (the license-check matrix and the npm-audit
  steps gain `desktop`; no Windows job yet, that is C1)

This task lands before any desktop code exists, so it also creates the
smallest valid workspace the matrices can run against:

```text
desktop/package.json      name "monize-desktop", private, version from backend/package.json, scripts lint/typecheck/test
desktop/tsconfig.json     strict, target es2022, module commonjs, outDir dist
desktop/jest.config.cjs   ts-jest, testMatch src/**/*.spec.ts, no passWithNoTests
desktop/src/version.spec.ts   asserts the three manifests carry one version
desktop/README.md         what the package is, how to build it, where data lives
```

**Acceptance:**
- `backend/src/common/doc-paths.spec.ts` and the `repo-paths` unit test are
  green with `desktop/` rooted.
- `node scripts/check-docs-manifests.mjs` accepts a desktop script named in
  a doc and still rejects a name no manifest has.
- `jest-config.guard.spec.ts` is green (the new manifest and jest config
  carry no zero-discovery flag).
- The license-check and npm-audit matrices run for `desktop` in the PR's CI.

**Shared area:** the Android plan (`android-offline-app.md`) adds a `mobile/`
layer to the same matrices and will need the same `ROOTED` and collector
entries. If its wiring has not landed, add `mobile` beside `desktop` in each
of the one-line lists in this task and say so in the PR; if it has, this task
only adds `desktop`. Either way name the other plan in the PR.

**Traps:** `ci-images.guard.spec.ts` checks every `image:` and `FROM`; the
desktop package has neither. `instruction-files.spec.ts` does not size-check
an instruction file under the desktop directory, but `doc-paths.spec.ts`
reads every CLAUDE.md strictly; do not add one there until there are rules to
put in it.

## D2: Desktop package: config, secrets, ports, logger

Files (all new, under `desktop/`):

```text
src/app-paths.ts        resources dir (process.resourcesPath, or desktop/staging in dev) and the data dir (%LOCALAPPDATA%\Monize, overridable by MONIZE_DATA_DIR for tests)
src/app-config.ts       config.json: { version, ports, dataDir, secrets: { encrypted base64 } }, read/write, first-run creation
src/secrets.ts          generate 48-byte random strings; wrap/unwrap with electron safeStorage; a plaintext fallback only when MONIZE_INSECURE_SECRETS=1 (dev and CI smoke)
src/ports.ts            pick: try the default, probe upward on EADDRINUSE, persist; never change a persisted port that is still free
src/logger.ts           one rotating file per process under logs/, JSON lines, the only place the package writes to stdout
src/env.ts              compose the backend and frontend child environments from config (plan section 6), pure
*.spec.ts               one per module
```

Pattern: the backend's `resolvePositiveInt` table for numeric env, the
frontend's `server-log-format.cjs` for the log line shape.

Steps:
1. `app-config.ts` creates the data directories on first run and writes the
   config atomically (temp file, then rename; copy the shape of
   `backend/src/backup/atomic-file.ts`).
2. `secrets.ts` generates `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_PASSWORD`
   once; a missing secret on a later run is an error shown to the user, never
   silently regenerated (D7: regenerating `ENCRYPTION_KEY` destroys data).
3. `env.ts` is pure and fully unit-tested; it is the guard the plan's
   section 8 asks for: `HOST` and `HOSTNAME` are always `127.0.0.1`,
   `PUBLIC_APP_URL` and `CORS_ORIGIN` are always the frontend origin,
   `UPDATE_CHECK_ENABLED` is always `false`, `TZ` is `UTC`, and every
   secret is non-empty.

**Acceptance:** the desktop `test` script is green on Linux with
`MONIZE_INSECURE_SECRETS=1`; a config written by one run is read back
identically by the next; a persisted port that is busy on a later run is
moved and the new value persisted; a config missing a secret fails closed.

## D3: Supervisor

Files (new, under `desktop/src/supervisor/`): `child.ts`, `backend.ts`,
`frontend.ts`, `boot.ts`; plus `desktop/src/health.ts`; specs for each.

Pattern: `backend/docker-entrypoint.sh` is the boot order to copy exactly;
`frontend/Dockerfile` is the frontend command.

Steps:
1. `child.ts`: spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, the
   composed env, `cwd` set to the layer's resource directory, stdout and
   stderr piped to the logger, `windowsHide: true`. Returns a handle with
   `exited` (a promise of the exit code) and `stop()` (SIGTERM, then kill
   after a bound). The spawner is injectable so the state machine is tested
   with a fake.
2. `backend.ts`: run `dist/db-init.js`, wait for exit 0; run
   `dist/db-migrate.js`, wait for exit 0; start `dist/main.js` and keep the
   handle. Any non-zero exit is a boot failure carrying the last 50 log lines.
3. `frontend.ts`: start `server.js` with `--require ./server-log-format.cjs`
   and keep the handle.
4. `health.ts`: poll `GET /api/v1/health/ready` on the backend and
   `GET /api/v1/health/live` on the frontend with a deadline; both exist
   today (`frontend/src/app/api/v1/health/ready/route.ts` forwards to the
   backend's readiness).
5. `boot.ts`: the state machine `postgres -> db-init -> db-migrate -> backend
   -> frontend -> ready`, emitting a status string per step for the splash
   window; on failure it stops what it started in reverse order. On quit it
   stops frontend, backend, then PostgreSQL, and waits for each.
6. A child that exits after `ready` restarts once with backoff; a second exit
   within a minute surfaces an error dialog with "Show logs".

**Acceptance:** the state-machine spec covers: happy path order; db-migrate
non-zero stops before the backend starts; backend never ready within the
deadline stops the backend; quit during boot cancels and stops; a crashed
frontend restarts once. A manual run on Windows against a built backend and
frontend and an external PostgreSQL 16 reaches `ready`.

## D4: Window, preload, tray, splash, external links

Files (new, under `desktop/src/`): `electron-main.ts`, `window.ts`,
`preload.ts`, `tray.ts`, `splash.ts`, `splash.html`; specs where logic exists.

Steps:
1. `electron-main.ts`: single-instance lock (a second launch focuses the
   window), show the splash, run `boot`, then open the window.
2. `window.ts`: `BrowserWindow` with `contextIsolation: true`,
   `nodeIntegration: false`, `sandbox: true`, the preload, loads the frontend
   origin. `setWindowOpenHandler` and `will-navigate` send any origin other
   than the frontend's to `shell.openExternal` (F1 rule 4). Close hides to the
   tray; Quit from the tray exits.
3. `preload.ts`: exposes `window.__MONIZE_SHELL__ = { kind: 'electron',
   version }` through `contextBridge` (F1 rule 1), nothing else.
4. `tray.ts`: Open, Open in browser (`shell.openExternal` on the frontend
   origin, D10), Show logs (opens the logs directory), Show recovery key
   (confirm dialog, then a dialog with `ENCRYPTION_KEY` and a Copy button),
   Check for updates (wired in D8), Quit.
5. `splash.ts`: a small frameless window showing the boot status and, on
   failure, the log tail with Retry and Quit.

**Acceptance:** on Windows, the app opens to the login page; an external
link in the app opens the default browser; closing the window leaves the
tray icon and the servers running; Quit stops all three processes (no
`postgres.exe` or Electron child left in Task Manager); a second launch
focuses the existing window.

## D5: Embedded PostgreSQL

Files: `desktop/src/supervisor/postgres.ts` (+ spec with a fake runner),
`desktop/scripts/smoke-postgres.mjs`, the desktop manifest (dependencies
`embedded-postgres` and `@embedded-postgres/windows-x64` pinned to the 16.x
line as an exact version).

Steps:
1. On first run: `initdb` into `pgdata` with `--auth=scram-sha-256`,
   `--encoding=UTF8`, `--locale=C`, the generated superuser password, user
   `monize`. Then start, create database `monize` owned by `monize`, stop.
   db-init applies `schema.sql` on the first backend boot and that file
   creates the four extensions (plan section 4).
2. On every run: if `postmaster.pid` exists and its process is gone, delete
   it (a previous crash); `pg_ctl start` with `-o "-c listen_addresses=127.0.0.1
   -c port=<port>"`, wait for `pg_isready`.
3. On quit: `pg_ctl stop -m fast`, wait, then fall back to `-m immediate`
   after a bound.
4. The binaries directory is `resources/postgres` (D6 copies it from the
   platform package).

**Acceptance:** `smoke-postgres.mjs` on Windows: initdb into a temp dir,
start, `SELECT 1`, `CREATE EXTENSION` for each of the four names succeeds,
stop, the directory holds no `postmaster.pid`. Running it twice reuses the
cluster. A simulated crash (kill `postgres.exe`, leave the pid file) is
recovered on the next start.

**Traps:** the `embedded-postgres` wrapper's own latest tracks PostgreSQL 17
and 18; the version that matters is the platform package's. Dependabot must
be told (D1). `pgdata` must not live under the install directory, or an
uninstall or an update would delete it.

## D6: Staging script

File: `desktop/scripts/stage.mjs` (+ a spec over its manifest of copied
paths).

Runs on Windows after `npm ci` and `npm run build` in `backend/` and
`frontend/` (both installed on Windows; do not pass `--libc=musl`). Produces
`desktop/staging/`:

```text
staging/backend/dist/                      from backend/dist (locale JSON included by nest-cli assets)
staging/backend/node_modules/              from a fresh `npm ci --omit=dev` in a temp copy of backend/
staging/backend/schema.sql                 from database/schema.sql
staging/backend/migrations/                from database/migrations
staging/backend/release-notes/             from docs/release-notes
staging/frontend/                          from frontend/.next/standalone, plus .next/static into .next/static and public/ into public/
staging/frontend/server-log-format.cjs     from frontend/
staging/postgres/                          the bin/, lib/ and share/ of @embedded-postgres/windows-x64
```

The layout mirrors `backend/Dockerfile` and `frontend/Dockerfile` exactly;
db-init and db-migrate look for `schema.sql` and `migrations/` beside
`dist/`, and the release-notes service looks for `release-notes/` there.

**Acceptance:** the spec asserts the manifest names every path the two
Dockerfiles copy; on Windows, D3's supervisor boots from `staging/` with no
external install.

**Traps:** `patch-package` pins `next@16.4.2`; the staged standalone output
carries the patched file, so staging must run after `npm ci` applied it.
`@scarf/scarf` runs an install script (telemetry); set `SCARF_ANALYTICS=false`
in the staging environment.

## D7: Installer

Files: `desktop/electron-builder.yml`, `desktop/build/installer.nsh`,
`desktop/build/icon.ico`, the desktop manifest's `dist` script, and the
desktop README (the build steps).

Steps:
1. `electron-builder.yml`: `appId com.monize.desktop`, `productName Monize`,
   `win.target nsis`, `nsis` with `oneClick: false`, `perMachine: false`,
   `allowToChangeInstallationDirectory: true`, `include build/installer.nsh`,
   `artifactName Monize-Setup-${version}.${ext}`; `extraResources` mapping
   `staging/backend`, `staging/frontend` and `staging/postgres` to
   `resources/`; `asar: true` for the shell only; `publish` provider
   `github`, owner `kenlasko`, repo `monize`.
2. `installer.nsh`: on install, stop a running instance (by window class or
   mutex) before copying; on uninstall, a checkbox "Remove my data
   (%LOCALAPPDATA%\Monize)" unticked by default, honoured only when ticked.
3. `dist` script: typecheck, bundle the main process, run `stage.mjs`, then
   `electron-builder --win --publish never`.

**Acceptance (manual, on a clean Windows 11 VM, written into the PR):**
- `Monize-Setup-<v>.exe` installs without an elevation prompt and without a
  Firewall prompt.
- First launch shows the splash, then the login page; registering the first
  user makes them admin.
- Create an account and a transaction; trigger a manual backup from
  Settings; the file appears under `%LOCALAPPDATA%\Monize\backups` (proves
  B1).
- Quit, relaunch: data present, no re-migration messages beyond "nothing
  pending".
- Install the same build over itself: data intact.
- Uninstall with the checkbox clear: data directory remains. Reinstall: data
  back. Uninstall with the checkbox ticked: directory gone.

## C1: CI job on Windows

Files: `.github/workflows/ci.yml` (new job `desktop-windows`),
`desktop/scripts/smoke-install.ps1`.

Steps:
1. `runs-on: windows-latest`; `actions/setup-node` pinned to a commit SHA,
   Node 24; `npm ci` and `npm run build` in `backend/` and `frontend/`;
   `npm ci` in `desktop/`; the `dist` script with `--publish never`.
2. `smoke-install.ps1`: silent install (`/S`), launch with
   `MONIZE_INSECURE_SECRETS=1` and a temp `MONIZE_DATA_DIR`, poll
   `http://127.0.0.1:3380/api/v1/health/live` until 200 within a bound,
   `POST /api/v1/auth/register` a user, `GET` the accounts list as that user,
   quit through a `--quit` flag the main process honours, assert no stray
   `postgres.exe`, silent uninstall.
3. Upload the installer as a workflow artifact with a 7-day retention.
4. Add the job to `prepare-release`'s gate list.

**Acceptance:** the job is green on the PR; a deliberate break (an
`exit 1` in `stage.mjs` on a scratch branch) is red.

**Traps:** `ci-images.guard.spec.ts` checks `image:` and `FROM` lines only;
a runner label is neither. Pin the action by commit SHA like every other
action in the file. The job must not use `passWithNoTests` anywhere
(`jest-config.guard.spec.ts` scans workflows).

## D8: Updater

Files: `desktop/src/updater.ts` (+ spec), `desktop/src/tray.ts` (Check for
updates), the desktop manifest (`electron-updater`).

Steps:
1. `autoUpdater` with the GitHub provider; `checkForUpdatesAndNotify()` once
   after `ready` and on the tray item; downloads in the background;
   `quitAndInstall` only after the user confirms from the notification.
2. Before `quitAndInstall`, run the supervisor's stop sequence so PostgreSQL
   shuts down cleanly; the NSIS include's stop-running-instance step is the
   backstop.
3. The in-app update banner is already off (`UPDATE_CHECK_ENABLED=false`,
   plan section 6).

**Acceptance:** with a locally served `latest.yml` (the `dev-app-update.yml`
mechanism), an installed build detects a higher version, downloads, and on
confirm installs it, and the next launch runs `db-migrate` against the same
`pgdata` and shows the data.

## C2: Release assets

Files: `.github/workflows/ci.yml` (the `release` job and `prepare-release`).

Steps:
1. The `desktop-windows` job uploads `Monize-Setup-<v>.exe`, `latest.yml`
   and `Monize-Setup-<v>.exe.blockmap` as one artifact when the run is a
   release dispatch.
2. The `release` job downloads it and passes the three files to the existing
   `gh release create` call. The Android plan's CI task attaches its APK to
   the same call; whichever lands second rebases onto the first and names it
   in the PR.
3. The build must come from the same resolved SHA the images are built from
   (REL-003): read the SHA the image job resolves and check it out explicitly
   in the Windows job; fail if they differ.

**Acceptance:** a `workflow_dispatch` release on a scratch tag attaches the
three assets; `electron-updater` on an installed previous version sees it.
The PR body carries the `docs/release-integrity.md` section 7 statement:
which revision each artifact is bound to and how, that no post-gate commit is
added, no new bypass or PAT, and which gap-register rows move.

## C3: Code signing

Files: `.github/workflows/ci.yml` (the Windows job), `desktop/electron-builder.yml`.

Steps:
1. Apply to SignPath Foundation (D9); or configure Azure Artifact Signing
   through `win.azureSignOptions`.
2. Sign the installer and the uninstaller stub; `electron-builder` signs the
   nested executables it builds when a signer is configured. The embedded
   PostgreSQL binaries are already signed by their publisher and are left
   alone.
3. Verify with `signtool verify /pa` in the smoke script.

**Acceptance:** a fresh Windows VM shows the publisher name instead of the
SmartScreen "unknown publisher" sheet; `electron-updater` applies a signed
update over a signed install.

## F2: The page honours the shell contract

Files:
- `frontend/src/lib/shell.ts` (new: reads `window.__MONIZE_SHELL__`, exposes
  the capability helpers of F1 rule 2; + test)
- `frontend/src/components/layout/PushEnableBanner.tsx` (+ test)
- the push settings panel and its test
- `frontend/src/i18n/messages/en/*.json`, then `npm run i18n:pseudo`

Steps: the banner and the panel's Enable control hide when `canReceivePush`
is false and show the reason string; nothing else in the page changes. A
browser (no shell flag) behaves exactly as today.

**Acceptance:** tests cover absent flag (unchanged), `electron` (hidden with
the reason), `capacitor` (per F1). `npm run test:changed` and `npm run build`
green.

## Q1: README, website and docs

Files: `README.md` (a "Windows" section under Deployment with the download
link, data location, backup and recovery-key advice), `website/assets/js/app.js`
and `website/index.html` (a Windows install tab beside Docker Compose and
Kubernetes), `docs/backup-restore-contract.md` section 7 (one sentence: on
the desktop build, whole-instance recovery is the `pgdata` directory plus the
attachments directory, copied while the app is stopped).

**Acceptance:** `node scripts/check-docs-manifests.mjs` green; the
`README.md` tree of Compose stacks (rule 4) unchanged.

## D9: Polish

Each item is its own small PR; none blocks the others.

- Launch at login (`app.setLoginItemSettings`) with a tray toggle.
- Notification bridge: poll the notification centre's unread route with the
  window session's cookies and raise a native `Notification` per new row;
  clicking opens the window on the notification. Replaces D10's loss for
  the in-window case without touching `sw.js`.
- "Export recovery key" writes a text file through a save dialog, in addition
  to the show dialog from D4.
- Log viewer: a window tailing the three log files.
- "Move data folder": stop, copy, verify, switch the config, restart.

## PR body

Use `.github/pull_request_template.md`. Link the discussion from P1. No
invariant IDs change in this plan; say so explicitly in the box. For C2 and
C3 add the `docs/release-integrity.md` section 7 statement.
