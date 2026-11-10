---
title: "Report data used outside the report screens has two traps: payee-less spending is named Unknown, and months are zero-filled"
author: Ken
date: 2026-11-10
branch: feat/ux-batch-nov10
id: l-3246cdb9
scope: repo
status: active
src: agent
touches:
  - backend/src/built-in-reports/spending-reports.service.ts
  - backend/src/ai/trivia/trivia-ledger-facts.ts
---

## Watch out
- Spending by payee groups every transaction without a payee under the literal English name "Unknown" (with payeeId null). Anything ranking payees outside the report screen must filter on payeeId !== null, not on the name.
- Income vs expenses, given a startDate, returns every month of the window, filling a month with no activity as zero. A row count therefore says nothing about how much history exists; count from the first month with money in it before claiming "the last twelve months".

## Decided
- Trivia's cash-flow facts drop leading empty months and need three active months.

In the code: backend/src/built-in-reports/spending-reports.service.ts (payeeName fallback "Unknown"), income-reports.service.ts summarizePeriodRows; consumer backend/src/ai/trivia/trivia-ledger-facts.ts completeFlows
