---
title: "Backend integration specs run locally against a throwaway Postgres; a CI stall in the register sort spec was the runner, not the code"
author: Ken
date: 2026-10-31
branch: fix/deps-glob-minimatch-advisories
id: l-6707b40b
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/ci.yml"
---

## Decided
- To check an integration-spec failure locally, run it against a fresh Postgres 16 container on its own Docker network, never the dev stack's database: the specs' cleanTables truncates every table. Use the same database name, user, password and env as the CI job.
- A one-off CI failure where a test that normally takes about 2s hits its 60s timeout, and the next test then fails with "deadlock detected" in cleanTables, is a stalled runner, not slow code. The timed-out test's queries are still holding locks. Signs: pool "timeout exceeded when trying to connect" errors elsewhere in the same run, other suites uniformly about 15% slower than main, and the spec passing locally and on main. Re-run the job.

## Tried and ruled out
- Blaming the glob 14 / minimatch 11 bump for the register-sort failure: the run found the same 169 suites and 1879 tests as main, and the spec passed locally under both the old and new dependency trees in the same time.

## Watch out
- Pushing to a PR branch while a job re-run is in progress may cancel the re-run (main's run history shows many cancelled runs from superseding pushes).

In the code: CI job backend-integration-tests in .github/workflows/ci.yml (DATABASE_NAME/USER monize_test, DATABASE_PASSWORD test_password, JWT_SECRET of 32+ chars, NODE_ENV test). Local run: `docker network create monize-itest`; `docker run -d --name monize-itest-pg --network monize-itest -e POSTGRES_DB=monize_test -e POSTGRES_USER=monize_test -e POSTGRES_PASSWORD=test_password postgres:16-alpine`; then, in node:24-alpine on that network with DATABASE_HOST=monize-itest-pg and the backend node_modules volume, `npx jest --config ./test/jest-integration.json --runInBand <spec>`.
