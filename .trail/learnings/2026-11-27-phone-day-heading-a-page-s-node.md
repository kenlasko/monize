---
title: "Phone day heading: a page's newest date may continue on the neighbouring page"
author: Node
date: 2026-11-27
branch: claude/issue-2486
cost: { minutes: 5, tokens: 54859 }
touches:
  - docs/frontend/tables-and-registers.md
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/components/transactions/register-style-data.test.ts
  - frontend/src/components/transactions/register-style-data.ts
  - frontend/src/components/transactions/variants/DayClosingBalance.tsx
  - frontend/src/components/transactions/variants/PebbleRegister.tsx
  - frontend/src/i18n/messages/de/transactions.json
  - frontend/src/i18n/messages/en/transactions.json
  - frontend/src/i18n/messages/es/transactions.json
---

## Decided
- `balanceByDate(rows, balances, direction, hasNewerPage)` withholds the page's NEWEST date when a newer page exists (`hasNewerPage`: newest first with currentPage > 1, oldest first with currentPage < totalPages) and returns it as `continuedDate`. `DayClosingBalance` then prints "Continues on the previous/next page" instead of a mid-day balance. Only the newest date can straddle the newer edge; an older date's later rows are all on this page.
- An empty `runningBalances` (one account, no seed yet) sets `dayBalance` to null, so the heading keeps the day net instead of a row of dashes.
- Folio and Pebble both draw the close through `variants/DayClosingBalance.tsx` (signed and `balanceColor`ed like Folio's balance column, with an sr-only "Balance at end of day" label).
## Tried and ruled out
- Printing the balance beside the newest row on the page for a date that straddles a page break: on page 2+ newest first, that is a mid-day balance labelled as the close.
## Watch out
- Every TransactionList caller that pages passes `currentPage`/`totalPages` (transactions page, category/payee tabs, investment cash register, rule test match). A new paged caller that omits them would make `hasNewerPage` false, and the edge date would print a possibly mid-day close.
