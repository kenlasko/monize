---
title: "Issue #2073: budget period month picked by UTC, not user's day"
author: Node
date: 2026-11-10
branch: claude/issue-2073
cost: { minutes: 13, tokens: 80676 }
touches:
  - backend/src/budgets/budget-date.utils.spec.ts
  - backend/src/budgets/budget-date.utils.ts
  - AGENTS.md
---

## Decided
Fixed getCurrentMonthPeriodDates/getPreviousMonthPeriodDates (backend/src/budgets/budget-date.utils.ts)
to derive the month from todayYMD() (request/cron-scoped timezone) instead of new Date().getUTCFullYear()/getUTCMonth().
getPreviousMonthPeriodDates steps back one month via Date.UTC(year, month - 2, 1) read back with getUTCFullYear/getUTCMonth,
so the year-rollover arithmetic stays independent of the host's own timezone. Added two regression tests using
jest.useFakeTimers({ now: "2026-11-01T01:00:00.000Z" }) + requestContextStorage.run({ timezone: "America/Los_Angeles" }, ...)
to cover the "evening of the last day, west of UTC" case from the issue.

## Tried and ruled out
- Plain local `new Date(year, month - 2, 1)` (reading getFullYear/getMonth back) for the previous-month step: works, but
  ties the round-trip to the *server's* local timezone/DST instead of being pure calendar arithmetic. Switched to the
  Date.UTC round-trip pattern already used by getFollowingMonthPeriodDates in the same file for consistency.

## Watch out
- This worktree's node_modules was not installed; had to `npm ci` in backend/ before any jest/tsc command worked.
- `npx tsc --noEmit` OOMs on this machine's default heap; needs `NODE_OPTIONS="--max-old-space-size=4096"` (the repo's own ceiling).
- The host container's local TZ is America/Toronto, not UTC. Running `npm run test:changed` without `TZ=UTC` produced two
  unrelated failures in `src/accounts/loan-payment-frequency.guard.spec.ts` (date math landing on a different day under
  EST vs UTC) that have nothing to do with the budgets change. AGENTS.md already says CI runs in UTC — always run
  `TZ=UTC npm run test:changed` (or the AGENTS.md-mandated `TZ=UTC npm run test:unit -- --coverage`) here, not the bare
  command, or you'll chase a phantom regression.
