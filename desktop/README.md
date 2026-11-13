# Monize desktop

The Windows shell for Monize: an Electron app that starts the backend, the
frontend and a bundled PostgreSQL 16 on one machine and opens the result in a
window. The plan is `docs/future-plans/windows-installer.md`; the task list is
`docs/future-plans/windows-installer-tasks.md`.

This package is a workspace of its own, like `backend/` and `frontend/`. Its
version is kept equal to theirs; `src/version.spec.ts` fails when it drifts,
and the release job in `.github/workflows/ci.yml` bumps all three together.

## Build and test

Run from this directory:

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

## Staging

`npm run stage` assembles `staging/` (git-ignored) for packaging from build
output that already exists: `npm run build` in `backend/` and `frontend/`
first. It builds nothing and exits non-zero naming whatever is missing. The
layout mirrors the production stage of `backend/Dockerfile` and
`frontend/Dockerfile` and is declared in `staging-manifest.json`;
`src/staging-manifest.spec.ts` fails when a Dockerfile gains a `COPY` the
manifest does not account for.

```bash
npm run stage                          # everything; needs sh + cwebp, (PNG fallback without cwebp)
npm run stage -- --require-webp        # CI: fail when cwebp is missing instead of copying PNGs
npm run stage -- --skip-postgres       # without the @embedded-postgres platform package
npm run stage -- --skip-backend-deps   # reuse the staged backend/node_modules
```

Also `--repo-root <dir>` and `--out <dir>`. The backend's production
dependencies come from a fresh `npm ci --omit=dev` in a temp directory. Without
`cwebp` the help screenshots are copied as PNG (the backend serves them, at
about 2.4 times the size) with a warning.

One staged file is the desktop's own and mirrors no Dockerfile line (manifest
`kind: "desktop"`): `shell/parent-watch.cjs`, from `resources/parent-watch.cjs`.
The supervisor loads it into every backend and frontend process with
`--require` so that they exit when the shell dies, even when it is killed;
a boot without it fails at its first child rather than running unguarded.

## Running the stack without Electron

`scripts/dev-boot.mjs` boots the staged stack under plain Node through the
same runtime module the Electron main process uses (`src/runtime.ts`):
PostgreSQL, db-init, db-migrate, the backend, the frontend. It runs on Linux
as well as Windows, so the supervisor, the PostgreSQL runner and the staged
layout can be exercised with no window and no installer.

```bash
npm run stage                                   # after building backend/ and frontend/
npm run dev:boot -- --data-dir /tmp/monize-dev  # Ctrl-C stops all three
npm run dev:boot -- --data-dir /tmp/monize-dev --exit-when-ready   # boot, GET /login, stop
npm run smoke:postgres                          # the PostgreSQL runner alone, against real binaries
```

The data directory must be named: outside Electron the secrets are stored in
plain text, so the script never uses the installed application's folder.

## Running the shell in development

`npm start` builds `dist/` and runs the Electron shell (`src/electron-main.ts`)
against the staged stack: a splash while PostgreSQL, the migrations, the
backend and the frontend start, then the main window on the frontend origin
and a tray icon. Name a data directory and allow plain-text secrets, as for
`dev:boot`:

```bash
npm run stage                                   # after building backend/ and frontend/
MONIZE_DATA_DIR=/tmp/monize-shell MONIZE_INSECURE_SECRETS=1 npm start
MONIZE_DATA_DIR=/tmp/monize-shell npx electron . --quit   # asks the running shell to quit
```

- One data directory is one running shell: a second launch on the same
  directory focuses the first window and exits, and `--quit` asks the running
  shell to stop everything and exit (a no-op when none runs).
- Closing the window hides it to the tray; Quit in the tray stops the
  frontend, the backend and PostgreSQL, then exits. Without a tray (some Linux
  sessions) closing the window quits.
- Chromium's profile, the page's cookies included, lives under
  `<data dir>/shell`.
- `monize://` is registered with the operating system only by a packaged
  build. In development, pass a link as an argument instead:
  `npx electron . monize://open/accounts`.
- A shell started from a terminal that sets `ELECTRON_RUN_AS_NODE` (the VS Code
  integrated terminal does) runs Electron as plain Node and fails at once;
  unset it first.
- Logs: `<data dir>/logs/main.log` has the boot statuses and every window
  load (`Window finished loading <url>`).

The shell's own text is English only and lives in `src/shell/strings.ts`;
there is no translation framework in this package yet.

## Updates

`src/updater.ts` runs `electron-updater` against GitHub Releases; every
decision is in `src/shell/update-policy.ts` and `src/shell/version-policy.ts`.

- **Where it looks.** electron-builder writes `resources/app-update.yml` from
  the `publish` block of `electron-builder.yml` (GitHub, `kenlasko/monize`).
  The updater reads the latest release's `latest.yml`, then downloads the
  installer it names. A release must carry `Monize-Setup-<v>.exe`,
  `latest.yml` and `Monize-Setup-<v>.exe.blockmap`.
- **When.** Once after the stack first reaches `ready`, and whenever the
  person chooses Check for updates in the tray. Never while a check or a
  download is running, and not at all in a development run (below).
- **What the person sees.** The download runs in the background; the tray
  item reads "Downloading update... N%", then "Restart to update to <v>", and
  a notification says the update is ready. Nothing installs until the person
  answers Restart now. Then the window hides, the shell stops the frontend,
  the backend and PostgreSQL (a clean `pg_ctl stop`), and only then starts the
  installer and quits; the installer opens Monize again, and the new backend
  runs `db-migrate` against the same `pgdata`. Later leaves the update
  downloaded for the next restart.
- **Not on an ordinary quit.** `autoInstallOnAppQuit` is off: a quit also
  comes from Windows signing out, from `--quit` and from the installer's or
  uninstaller's own stop-running-instance step, and an installer started then
  would be cut off or run beside another one. A downloaded update is found in
  the cache and offered again on the next launch.
- **Which versions.** Never a downgrade or the running version. A stable
  install is never offered a prerelease, even one published by mistake as a
  normal release. A prerelease install (`1.22.0-beta.1`) follows newer
  prereleases and the next stable release (electron-updater's own default,
  keyed on the running version).
- **Failures.** A failed check or download is a line in `logs/main.log`
  (`Updates: ...`, and electron-updater's own `Updater: ...` lines); it is
  shown in a dialog only when the person asked from the tray, and the app
  keeps running.

**What is verified, and what is not.** The installer is checked against the
`sha512` in `latest.yml`, after a full or a differential download and again
when a cached download is reused; that catches a corrupted or swapped file,
but `latest.yml` comes from the same release, so it is no proof of who made
it. The Authenticode check (`Get-AuthenticodeSignature`, matched against
`publisherName`) runs only when `app-update.yml` carries a `publisherName`,
which electron-builder writes only for a signed build. An unsigned build
(until the signing task, C3) therefore verifies the checksum alone; the
download itself is HTTPS from GitHub.

**Trying it without a release.** On Windows only (`NsisUpdater` installs NSIS
installers; the Linux updaters do not apply):

1. Build the installer with electron-builder and install it, then raise
   `version` in `package.json` (say to `1.21.1`) and build again. Keep the second build's `release/` folder: it holds
   `Monize-Setup-1.21.1.exe`, its `.blockmap` and `latest.yml`.
2. Serve that folder: `npx http-server release -p 8080` (or
   `python -m http.server 8080 -d release`).
3. Point the installed build at it: in the install directory (per user, by
   default `%LOCALAPPDATA%\Programs\Monize`), edit `resources\app-update.yml`
   and replace the `provider`, `owner` and `repo` lines with
   `provider: generic` and `url: http://127.0.0.1:8080/`, keeping the other
   keys. For an unpackaged run (`npm start`) the same two lines go in a
   `dev-app-update.yml` beside this package's `package.json` instead
   (git-ignored); its presence is what turns the updater on in development.
4. Start the installed build with some data in it. Within a minute of the
   window opening the tray reads "Restart to update to 1.21.1" and a
   notification appears; `logs/main.log` shows `version 1.21.1 is
   downloaded`.
5. Choose Restart now. Expect, in order: the window hides; `main.log` shows
   `stopping the stack first`, the supervisor stopping each process, then
   `the stack is stopped; installing version 1.21.1`; the installer runs and
   reopens Monize; the splash shows "Updating the database..."; the app opens
   on the same data. `postgres.log` shows a clean shutdown before the install
   (no recovery on the next start).
6. Repeat step 4 and choose Later: nothing installs; quit from the tray and
   check that no installer starts; the next launch offers it again.

## Where data lives

Per user, under `%LOCALAPPDATA%\Monize\`: `pgdata`, `backups`, `attachments`,
`logs` and a `config.json`. The uninstaller keeps this directory unless the
user ticks "Remove my data".
