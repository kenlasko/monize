---
title: "Phone register day heading shows the closing balance (issue #2486)"
author: Node
date: 2026-11-27
branch: claude/issue-2486
cost: { minutes: 11, tokens: 110290 }
touches:
  - docs/frontend/tables-and-registers.md
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/components/transactions/register-style-data.test.ts
  - frontend/src/components/transactions/register-style-data.ts
  - frontend/src/components/transactions/variants/PebbleRegister.tsx
  - website/docs/search-index.json
  - website/docs/transactions.html
  - website/docs/transactions.md
---

## Decided
- Folio's wrapped phone card and Pebble below `md` print the day's closing balance beside each date when `showRunningBalance` is on; `balanceByDate` in `frontend/src/components/transactions/register-style-data.ts` reads it from `walkRunningBalances`' value beside the date's newest row: the first row on a desc page, the last on an asc page.
- Across accounts or off a date sort there is no balance, so the heading keeps the `netByDate` day net. Pebble from `md` keeps the net too, because its rows draw the balance there (`hidden md:block`).
## Tried and ruled out
- Using the balance of the first row drawn under the date: on an oldest-first page that is the balance after the date's oldest row, not the day's close.
## Watch out
- Pebble renders both figures and lets CSS pick one (`md:hidden` / `hidden md:inline`), so a test reading the heading's textContent sees both.
- `TransactionList.uiStyles.test.tsx` now mocks `useIsMobile` through a hoisted `phone` flag; Folio's group figure is drawn only when `wrapped` (phone + normal density).
