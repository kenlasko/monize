---
title: "Desktop specs that touch real folders must use the host's path rules; only pure path specs may name a platform"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-9a7388cf
scope: repo
status: active
src: agent
touches:
  - desktop/src/test-support/move-fixture.ts
  - ".github/workflows/ci.yml"
---

## Decided
- A desktop spec that creates real files under the system temp folder passes `process.platform` and the host `path` module to the code under test. A spec over literal paths (`/a/Monize`, `C:\Monize`) with no filesystem access may pass `"linux"`, `"win32"` and `path.posix` / `path.win32` explicitly, and should, so both platforms' rules are proven on the Linux runner.
- A fixture's temp root is resolved with `realpathSync.native` before use.

## Watch out
- The desktop suite also runs on the Windows CI job. A fs-backed spec hard-coded to `"linux"` passes on Linux and fails only there: the code checks `C:\` temp paths with POSIX rules (not absolute, `/` joins). The data-folder move's first Windows run failed 44 tests in six suites from this one cause.
- The Windows runner's temp folder is an 8.3 short name (`C:\Users\RUNNER~1\...`); anything that resolves links or compares resolved paths sees `runneradmin`, so an unresolved root makes spelling-sensitive checks disagree.

In the code:
- desktop/src/test-support/move-fixture.ts, desktop/src/move/*.spec.ts
- the Windows job's "Test the desktop package" step in .github/workflows/ci.yml
