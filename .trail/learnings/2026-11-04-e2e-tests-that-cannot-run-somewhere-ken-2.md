---
title: "E2E tests that cannot run somewhere are left out of that project, and the first-attempt E2E failures came from Turbopack's on-disk dev cache, so the e2e stack…"
author: Ken
date: 2026-11-04
branch: test/e2e-never-run-tests
id: l-6e8bd6de
scope: repo
status: active
replaces: l-984c3b39
src: agent
touches:
  - ".github/workflows/ci.yml"
  - docker-compose.e2e.yml
  - e2e/CLAUDE.md
  - e2e/playwright.config.ts
  - e2e/tests/backup.spec.ts
  - e2e/tests/cluster.spec.ts
  - e2e/tests/mobile.spec.ts
  - e2e/tests/share-target.spec.ts
  - frontend/next.config.js
---

## Decided
- A test that cannot run in an environment is excluded from that Playwright project instead of skipped inside it. Chromium-only blocks carry the `@chromium-only` tag, and the firefox project drops them with grepInvert. cluster.spec.ts runs in its own `cluster` project, which exists only when E2E_CLUSTER=multi is set. The DEMO_MODE-only backup E2E test was removed; AutoBackupSection.test.tsx covers what it checked.
- The e2e frontend runs `next dev` with Turbopack's filesystem cache off (NEXT_DEV_FILESYSTEM_CACHE=false in docker-compose.e2e.yml, read by frontend/next.config.js). Its background cache writes and compactions (12-91s each) stalled requests for already-compiled pages by 10-50s. Measured on a cold scratch stack over the 5 specs that kept failing their first CI attempt: with the cache on, 6 of 18 failed in 8.9 min; with it off, all 18 passed in 4.5 min.
- Playwright blocks service workers (`serviceWorkers: 'block'`) except in share-target.spec.ts. sw.js replaces any navigation slower than 10s (NAVIGATION_TIMEOUT_MS) with its "Unable to connect" offline page and a 503, which is what failed investment-account-consolidation.

## Tried and ruled out
- Opening every page (121 URLs plus the API proxy routes) in global-setup before the tests. It took 350-416s per run and still left 1-2 failures, because the cache stalls came after the warm-up. With the cache off it brought no further gain, so it was removed.

## Watch out
- To reproduce, run the e2e stack under another compose project with the ports remapped (`ports: !override`) and PUBLIC_APP_URL/CORS_ORIGIN set to match. `docker compose up --force-recreate --no-deps frontend` gives you a cold frontend again.

In the code: docker-compose.e2e.yml frontend env, frontend/next.config.js experimental.turbopackFileSystemCacheForDev, e2e/playwright.config.ts use.serviceWorkers.
