---
title: "CI test speedups: shard with merged coverage, keep TRUNCATE cleanup, and keep every module-graph runtime case"
author: Ken
date: 2026-11-04
branch: perf/ci-test-speed
id: l-09d7230a
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/ci.yml"
  - backend/src/test-helpers/fast-password-hashing.setup.ts
  - backend/src/module-graph.spec.ts
  - backend/test/helpers/integration-setup.ts
---

## Decided
- Frontend and backend integration tests run as 3 shards each. Vitest shards must run with their coverage thresholds switched off; the thresholds are applied once, by a merge job over the shards' blob reports. Without that, every shard fails on partial coverage.
- The Jest transform cache is saved only on pushes to main, so a pull request can read it but never write what main runs.

## Tried and ruled out
- Restricting module-graph's runtime cases to modules that sit on a require cycle. A cycle can be entered through a service file, which no module-first case starts from, so this would test less. Reusing package instances across cases was used instead: no package imports back into src, so the load order each case measures is unchanged.
- Replacing cleanTables' TRUNCATE ... CASCADE with DELETEs under session_replication_role=replica (about 200ms against 500-700ms per test). DELETE does not cascade, so every dependent table would have to be listed by hand, and a missed one leaves rows behind for the next test. The in-memory, fsync-off Postgres was taken instead (about 25% faster on the email-receipts pipeline spec).
- Deleting the integration job's nest build: it is the only production build a PR runs, so it moved to Backend Lint instead.

## Watch out
- bcryptjs 3's require entry is a UMD bundle whose module.exports is a plain object. A spec that wants to jest.spyOn it must use `import bcrypt from "bcryptjs"`; the namespace import gives non-configurable getters ("Cannot redefine property").

In the code: .github/workflows/ci.yml (frontend-unit-tests matrix with --coverage.thresholds.*=0, frontend-coverage job running vitest --merge-reports --coverage), backend/src/test-helpers/fast-password-hashing.setup.ts, backend/src/module-graph.spec.ts (packageInstances), backend/test/helpers/integration-setup.ts cleanTables.
