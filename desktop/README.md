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

## Where data lives

Per user, under `%LOCALAPPDATA%\Monize\`: `pgdata`, `backups`, `attachments`,
`logs` and a `config.json`. The uninstaller keeps this directory unless the
user ticks "Remove my data".
