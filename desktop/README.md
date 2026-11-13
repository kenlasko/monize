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
npm run stage -- --vc-redist <dir>     # Windows: where the x64 Visual C++ runtime DLLs are
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
The other is `shell/icon.ico`, from `build/icon.ico`: the window, splash and
tray icon on Windows (`src/shell/icon.ts`).

On Windows the run also puts the Visual C++ runtime beside the PostgreSQL
executables (manifest `kind: "vc-runtime"`): `vcruntime140.dll`,
`vcruntime140_1.dll` and `msvcp140.dll`. The binaries in
`@embedded-postgres/windows-x64` import them, the package does not ship them,
and a clean Windows does not have them. They are copied from the Visual
Studio redistributable directory (`VC\Redist\MSVC\<version>\x64\Microsoft.VC*.CRT`),
found through `VCToolsRedistDir` or `vswhere`; `System32` is the fallback and
is reported with a warning. The run then reads the import table of every
`.exe` and `.dll` under `staging/postgres` and fails when one imports a Visual
C++ runtime DLL that is not there, so a PostgreSQL package that starts to
need another one cannot be shipped without it. On other platforms the step
is skipped.

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

## The installer

`npm run dist` builds `release/Monize-Setup-<version>.exe` (with
`latest.yml` and a `.blockmap` beside it, for the updater) from
`electron-builder.yml`. It runs on Windows only: staging copies the Windows
PostgreSQL package and the Visual C++ runtime from the build machine.

The Windows build machine needs:

- Node 24 and Git for Windows (its `sh` runs the help-image conversion).
- `cwebp` on `PATH` (the libwebp release zip); `dist` stages with
  `--require-webp`.
- Visual Studio 2022 or its Build Tools with the C++ workload, for the
  redistributable runtime DLLs. GitHub's `windows-latest` image has all of
  this except `cwebp`.

The commands, in order, from the repository root:

```bash
cd backend && npm ci && npm run build && cd ..
cd frontend && npm ci && npm run build && cd ..
cd desktop && npm ci
npm run lint && npm test
npm run dist      # typecheck, build, stage --require-webp, electron-builder --win --publish never
```

The build is unsigned until code signing lands (task C3): Windows SmartScreen
warns when the installer is run.

What the configuration decides, beyond the task's list:

- **Resources come from `staging/` in one entry.** electron-builder never
  copies a `node_modules` at the root of a `from` directory, so one entry per
  staged directory would ship the backend without its dependencies.
  `src/packaging.spec.ts` holds the entry to the staging manifest.
- **Per user only.** `build/installer.nsh` skips the "only for me / anyone
  who uses this computer" page and refuses `/allusers`: an elevated install
  can run as another account, whose `%LOCALAPPDATA%` is not the person's.
- **All of Chromium's locales ship.** The page is translated; dropping
  locales would put its date pickers and validation messages back in English.

### What `build/installer.nsh` does

It fills in macros that electron-builder's NSIS template inserts
(`node_modules/app-builder-lib/templates/nsis/`); the header of the file
lists when each one runs.

- **Stops a running Monize before any file is copied or removed**
  (`customCheckAppRunning`, which replaces electron-builder's own check).
  It runs the installed `Monize.exe --quit`, which asks the running
  application to stop its frontend, backend and PostgreSQL and returns when
  that process has gone, and which shuts down a PostgreSQL left behind by a
  Monize that was killed. Only then does electron-builder's machinery look
  for processes still running from the installation folder; an interactive
  run asks before terminating them.
- **Refuses an installation folder that is, contains, or is inside
  `%LOCALAPPDATA%\Monize`**, on the directory page (Next is greyed out) and
  again at the start of the installation, which also covers `/S` and `/D=`.
  The uninstaller deletes the installation folder with everything in it, on
  every update as well as on an uninstall, so this is the one way the
  installer could destroy the person's data. For the same reason it refuses
  a folder that already holds files and is not a Monize installation.
- **The uninstaller refuses to delete a folder that holds the data**
  (`customUnInstall`): a last line of defence should such an installation
  exist anyway. It exits with an error, which also stops an update.
- **"Remove my data (%LOCALAPPDATA%\Monize)"** is an unticked checkbox on
  the uninstaller's first page. A silent uninstall (`/S`) keeps the data
  unless it is run with `--remove-data`. An update never removes it. Data in
  a folder chosen with `MONIZE_DATA_DIR` is never touched.
- An uninstall also removes the `monize://` registration when it points at
  the removed executable, and the copy of the installer that electron-builder
  keeps under `%LOCALAPPDATA%\monize-desktop-updater` for updates.

`build/icon.ico` (16 to 256 pixels) is generated from
`frontend/public/icons/icon-512x512.png` by `node scripts/make-icon.mjs`,
which borrows `sharp` from the frontend's `node_modules`; run it when the
logo changes and commit the result.

### Acceptance checklist (manual, on a clean Windows 11 VM)

Nothing below can be verified off Windows. Use a VM that has never had
Visual Studio, a Visual C++ redistributable, Node, Docker or PostgreSQL
installed, signed in as a **standard (non-administrator) user** whose user
name contains a space (so every path does).

Install and first run:

- [ ] `C:\Windows\System32\vcruntime140.dll` does not exist before you start.
- [ ] `Monize-Setup-<v>.exe` installs with no elevation prompt and no
      Firewall prompt, and offers no "anyone who uses this computer" choice.
- [ ] On the directory page, choosing `%LOCALAPPDATA%`, or any folder inside
      `%LOCALAPPDATA%\Monize` once it exists, or a folder with files in it,
      greys out Next.
- [ ] `Monize-Setup-<v>.exe /S /D=%LOCALAPPDATA%\Monize` installs nothing and
      exits with a non-zero code.
- [ ] The Start Menu and desktop shortcuts carry the Monize icon; so do the
      window, the taskbar button and the tray. Pinning the running window to
      the taskbar adds no second button (the AppUserModelID matches).
- [ ] First launch shows the splash, then the login page. No console window
      appears at any point, including while PostgreSQL starts.
- [ ] Registering the first user makes them admin.
- [ ] `%LOCALAPPDATA%\Monize\config.json` holds no secret in plain text
      (they are encrypted with DPAPI); "Show recovery key" in the tray shows
      the key.
- [ ] Create an account and a transaction; trigger a manual backup from
      Settings; the file appears under `%LOCALAPPDATA%\Monize\backups`.
- [ ] Opening `monize://open/accounts` from Run (Win+R) brings the window to
      the Accounts page.
- [ ] Closing the window leaves the tray icon; "Open in browser" works;
      Quit in the tray leaves no `Monize.exe` or `postgres.exe` in Task
      Manager.

Restart and recovery:

- [ ] Quit, relaunch: data present, no migration messages in
      `%LOCALAPPDATA%\Monize\logs` beyond "nothing pending".
- [ ] End the first `Monize.exe` in Task Manager: the backend and frontend
      processes exit by themselves. Relaunch: Monize comes back on the same
      ports (the address in the tray's "Open in browser" is unchanged) with
      the data intact.
- [ ] `Monize.exe --quit` from a terminal stops a running Monize and
      returns only when no `Monize.exe` or `postgres.exe` is left.

Update and uninstall:

- [ ] Install the same build over itself while Monize is running: Monize
      closes without a "Monize is running" prompt, the install finishes, the
      data is intact.
- [ ] End `Monize.exe` in Task Manager (leaving `postgres.exe`), then run
      the installer: it finishes, and `postgres-server.log` shows a normal
      shutdown, not a crash recovery on the next start.
- [ ] Uninstall with the checkbox clear: `%LOCALAPPDATA%\Monize` remains;
      the installation folder, the shortcuts and
      `%LOCALAPPDATA%\monize-desktop-updater` are gone. Reinstall: data back.
- [ ] `"Uninstall Monize.exe" /S` keeps `%LOCALAPPDATA%\Monize`;
      `"Uninstall Monize.exe" /S --remove-data` removes it.
- [ ] Uninstall with the checkbox ticked: `%LOCALAPPDATA%\Monize` is gone.

## Where data lives

Per user, under `%LOCALAPPDATA%\Monize\`: `pgdata`, `backups`, `attachments`,
`logs`, a `config.json` and `shell` (Chromium's profile). The uninstaller
keeps this directory unless the user ticks "Remove my data".
