---
title: "E2E tests that cannot run somewhere are left out of that project, and the recurring first-attempt E2E failures are cold dev-server route compiles, not missing…"
author: Ken
date: 2026-11-04
branch: test/e2e-never-run-tests
id: l-984c3b39
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/ci.yml"
  - e2e/CLAUDE.md
  - e2e/playwright.config.ts
  - e2e/tests/backup.spec.ts
  - e2e/tests/cluster.spec.ts
  - e2e/tests/mobile.spec.ts
  - e2e/tests/share-target.spec.ts
  - docker-compose.e2e.yml
---

## Decided
- A test that cannot run in an environment is excluded from that Playwright project instead of skipped inside it, so the skipped count in a report stays meaningful. Chromium-only blocks carry the `@chromium-only` tag, and the firefox project drops them with grepInvert. cluster.spec.ts runs in its own `cluster` project, which exists only when E2E_CLUSTER=multi is set.
- Removed the backup "disables the automatic-backup controls in demo mode" E2E test. No run starts a DEMO_MODE=true stack, so it was skipped on every run. AutoBackupSection.test.tsx ("in demo mode") already covers the disabled controls.

## Watch out
- Across 41 green CI shard jobs (Nov 2026), the tests that keep failing on the first attempt and passing on retry are cash-flow-sankey, warranties "uploads a receipt", investment-account-consolidation "offers both ledgers", tours intro, and the auth login/logout flow. None is caused by a missing service. Each one times out waiting for a heading or URL on a route's first visit. The e2e frontend runs `next dev` (frontend Dockerfile target development), so every route compiles on its first hit. A route warm-up in global-setup is the likely fix; it was not tried in this session.

In the code: e2e/playwright.config.ts projects (CLUSTER_SPEC, grepInvert), ci.yml "Run cluster tests" uses --project=cluster, docker-compose.e2e.yml frontend target: development.
