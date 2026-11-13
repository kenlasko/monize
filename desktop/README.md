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

## Where data lives

Per user, under `%LOCALAPPDATA%\Monize\`: `pgdata`, `backups`, `attachments`,
`logs` and a `config.json`. The uninstaller keeps this directory unless the
user ticks "Remove my data".
