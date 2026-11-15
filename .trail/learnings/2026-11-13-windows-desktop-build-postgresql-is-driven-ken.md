---
title: "Windows desktop build: PostgreSQL is driven from the binary packages directly, and the whole stack can be booted on Linux without Electron"
author: Ken
date: 2026-11-13
branch: feat/desktop-integration
id: l-9aa223ce
scope: repo
status: active
src: agent
touches:
  - desktop/scripts/smoke-postgres.mjs
  - desktop/src/runtime.ts
  - desktop/scripts/dev-boot.mjs
  - desktop/staging-manifest.json
  - desktop/src/staging-manifest.spec.ts
  - desktop/src/supervisor/boot-contract.guard.spec.ts
  - desktop/src/env-docs.spec.ts
---

## Decided
- The bundled PostgreSQL 16 is run from the platform binary packages alone; the `embedded-postgres` wrapper package the plan named is not used. The runner calls `initdb` and `pg_ctl` itself from a directory it is given.
- The cluster is created with data checksums. This can only be chosen at initdb: the binary packages ship no `pg_checksums`, so an existing cluster could never gain them.
- Both the Windows and the Linux binary package are optional dependencies pinned to one exact 16.x version, so `npm ci` works on either OS and the runner is tested for real on Linux.
- One runtime module wires config, secrets, the PostgreSQL runner and the supervisor. The Electron main process and a no-Electron script both call it, so the stack can be booted end to end on Linux under plain Node (first run about 19 s, later runs about 9 s).
- Drift between the containers and the desktop build is held by guard specs, not by review: the staging manifest must account for every COPY in both production Dockerfile stages, the supervisor's boot steps must equal the entrypoint's, and every variable the child environment carries must be a documented one.
- Electron is pinned to the 45 line (bundles Node 24.22); the plan's 40.x was already out of support when the build started.

## Tried and ruled out
- The `embedded-postgres` wrapper: its 16.x line is ESM-only, resolves binaries from node_modules instead of a chosen directory, registers its own exit hook, and stops PostgreSQL on Windows with `taskkill /f`, which is a crash stop.
- A cooperative shutdown channel for the backend and frontend children on Windows: the backend has no shutdown hook to trigger (a container stop already kills it without running its code), so terminating it is the path production already takes.

## Watch out
- The plan was written before in-app help existed, so its staging layout lacked the backend's `help/` folder; the Dockerfile-vs-manifest guard is what catches this class of omission from now on.
- The Windows PostgreSQL executables import `VCRUNTIME140.dll` and the package ships none. GitHub's Windows runners have it installed, so CI will not catch a missing runtime; the installer has to carry it.
- The Linux binary package needs its postinstall symlink hydration, or a copy with symlinks dereferenced (about twice the size).
- After `kill -9` of the postmaster, a backend still mid-statement keeps the shared memory attached and a new server refuses to start for a few seconds; the runner retries only on that specific log text.
- The staged tree is about 600 MB uncompressed (the backend's production node_modules is 279 MB of it), so installer size needs attention at packaging.
- A fresh git worktree has no node_modules; symlinking each layer's node_modules from the main checkout works for lint, tsc and jest, but husky does not fire there, so run `npx lint-staged` by hand before committing.

In the code:
- desktop/src/supervisor/postgres*.ts, desktop/scripts/smoke-postgres.mjs (`npm run smoke:postgres`)
- desktop/src/runtime.ts, desktop/scripts/dev-boot.mjs (`npm run dev:boot -- --data-dir <dir> --exit-when-ready`)
- desktop/staging-manifest.json, desktop/src/staging-manifest.spec.ts, desktop/src/supervisor/boot-contract.guard.spec.ts, desktop/src/env-docs.spec.ts
- packages: @embedded-postgres/windows-x64 and @embedded-postgres/linux-x64 at 16.15.0-beta.19; electron 45.3.2 (added by the window task)
