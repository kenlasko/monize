---
title: "Stage 3 (C2) second half: breakdown and fee report totals moved to the server (#2413)"
author: Node
date: 2026-11-25
branch: claude/issue-2413
cost: { minutes: 29, tokens: 163750 }
touches:
  - backend/src/built-in-reports/monthly-category-breakdown-totals.ts
  - docs/frontend/financial-figures.md
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/specs/report-rounding-and-aggregation.md
  - docs/system-invariants.md
  - website/docs/currency-management.html
  - website/docs/currency-management.md
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
---

## Decided
- Monthly & Yearly Breakdown: the endpoint takes period=month|year (a year folds its months' FxAggregates in JS, no SQL change) and the client sends the window it shows: breakdownRequestEnd ends it the day before the column in progress unless "Include current" is on, so server averages are over the shown columns. The server owns the section rule (sectionKeyOf: parent / own id / __other_income__ / __other_expense__) and sends row total/average, sections and summary (income, expenses, balance, transfers, overall) from monthly-category-breakdown-totals.ts.
- Income vs Expenses gained bucket=year, and each tag-bucket period carries balance/balancePercent folded from the ALL period's income/expenses plus the bucket's flows (spec 10.9), not the bucket's own categorized rows. monthly-funds-summary and periodBalanceFields read them, with taggedBalance as an older-backend fallback.
- Foreign Currency Fees: GET /transactions/fx-fee-totals (accountIds, currencyCodes) folds fees per month and returns month/quarter/year buckets, total and per-granularity averages (gap-filled period count). The chart overrides its own buckets by key when given `totals`. The fee SQL is FX_FEE_AMOUNT_SQL, shared with getFxFeeSummary, whose converted rows now read at report places.
- Account, bills and register page totals round once at getDecimalPlacesForCurrency, not 4 then 2.

## Watch out
- process-local-state.guard.spec.ts fails any class-scope Map, even a per-call helper class; use plain functions over a Map.
- MCB component tests go through src/test/monthly-breakdown-fixture.ts (serveBreakdown), which plays the server: it folds years, cuts at endDate and computes totals. A test of a server figure passes explicit period/sections/summary, which it returns untouched.
- The breakdown's percentage view still divides a cell's server figure by its group's server figure.
