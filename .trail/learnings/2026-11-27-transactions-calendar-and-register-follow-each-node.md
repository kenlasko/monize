---
title: "Transactions calendar and register follow each other by page, not date filter (issue 2475)"
author: Node
date: 2026-11-27
branch: claude/issue-2475
cost: { minutes: 30, tokens: 221415 }
touches:
  - e2e/tests/calendar.spec.ts
  - docs/specs/calendar-view.md
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/calendar/TransactionsCalendarView.tsx
  - frontend/src/hooks/useRegisterCalendarMonth.test.ts
  - frontend/src/hooks/useRegisterCalendarMonth.ts
  - frontend/src/lib/calendar-month.test.ts
  - frontend/src/lib/calendar-month.ts
  - frontend/src/lib/register-month-landing.test.ts
---

## Decided
- Table to calendar: useRegisterCalendarMonth(pageRows, start, end, today) opens on earliestMonthOf(the page's row dates), falling back to monthForDateRange for an empty page. rowDate() reads a timestamp-dated row.
- Calendar to table: handleViewChange in app/transactions/page.tsx asks firstRegisterRowInMonth (lib/register-month-landing.ts: getAll limit 1, sortBy date asc, month clipped to the range by monthWithinDateRange), then sets targetTransactionIdRef and calls loadTransactions, so the server places the row (calculateTargetPage). No date filter is written.
- "First transaction of the month" was read chronologically (oldest row of the month), as the issue's "closest to the beginning of a month" wording reads.
- landedOn(month, id): while that row is on the page the calendar reopens on the month it came from; without it a round trip drifts one month back, because the page holding a month's oldest row usually reaches into the month before.
- Non-date sort, or a month with no rows: the register keeps its page (targetTransactionId would force the date sort).

## Tried and ruled out
- Keying the round-trip guard on registerKey: the landed page is only known after the targeted reply, so the key never matched. Keying on the landed row's id needs no key at all.

## Watch out
- page.test.tsx fixtures must carry transactionDate (not date): the hook reads every page row, and a row without it crashes the page.
- e2e/tests/calendar.spec.ts: a spec that seeds rows in the previous month opens there now; showTodaysMonthFrom waits for the opening month before clicking Today.
- The e2e backend build OOMs at Node's default heap on this machine; a throwaway compose override with NODE_OPTIONS=--max-old-space-size=4096 works. Rootless Docker: run the Playwright image without --user (scripts/e2e-playwright.sh's --user cannot write the mount).
