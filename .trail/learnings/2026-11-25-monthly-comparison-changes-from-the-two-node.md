---
title: "Monthly Comparison changes from the two months' aggregates (#2407)"
author: Node
date: 2026-11-25
branch: claude/issue-2407
cost: { minutes: 20, tokens: 191013 }
touches:
  - backend/src/built-in-reports/income-reports.service.spec.ts
  - backend/src/built-in-reports/income-reports.service.ts
  - backend/src/built-in-reports/monthly-comparison.service.spec.ts
  - backend/src/built-in-reports/monthly-comparison.service.ts
  - backend/src/built-in-reports/spending-reports.service.spec.ts
  - backend/src/built-in-reports/spending-reports.service.ts
  - backend/src/net-worth/net-worth.service.spec.ts
  - backend/src/net-worth/net-worth.service.ts
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/specs/report-rounding-and-aggregation.md
---

## Decided
- Each source report keeps its public method and gains a `*WithAggregates` sibling returning `{ response, <aggregates> }`: `getIncomeVsExpensesWithAggregates` (periods: Map<"YYYY-MM", {income, expenses}>), `getSpendingByCategoryWithAggregates` (categories: Map<categoryId|null, FxAggregate>, only the listed/net-spending ones), `getMonthlyNetWorthWithAggregates` (each month carries `netWorthAggregate`; `getMonthlyNetWorth` strips it).
- A change is `FxAggregate.difference(cur, prev).knownSubtotal`; a percent change divides `unroundedSubtotal`s and tests "previous is zero" on `sign` (rules 4, 5, 8). A previous month of 0.00003 now gives a huge percent, not 100.

## Tried and ruled out
- Moving getMonthlyNetWorth's body into the new method with its `|| "1990-01-01"` default: net-worth.service.spec.ts "no new fixed-epoch window default" allowlists only getMonthlyNetWorth by name. The default stays there; the new method takes `start`/`end` required.

## Watch out
- monthly-comparison.service.spec.ts mocks now use `withIncomeAggregates` / `withSpendingAggregates` / `withNetWorthAggregates` (aggregate = the shown figure) or `incomeMonth` / `spendingWindow` (exact components) helpers.
- `trail check` flags many word-overlap false positives on this area ("rule 2", "date spec").
