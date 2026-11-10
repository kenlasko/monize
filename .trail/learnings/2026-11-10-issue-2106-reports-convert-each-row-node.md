---
title: "Issue #2106: reports convert each row at its own date's FX rate"
author: Node
date: 2026-11-10
branch: claude/issue-2106
cost: { minutes: 44, tokens: 440118 }
touches:
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
  - backend/src/built-in-reports/anomaly-reports.service.spec.ts
  - backend/src/built-in-reports/anomaly-reports.service.ts
  - backend/src/built-in-reports/built-in-reports.service.spec.ts
  - backend/src/built-in-reports/cash-flow-sankey.service.ts
  - backend/src/built-in-reports/comparison-reports.service.spec.ts
  - backend/src/built-in-reports/comparison-reports.service.ts
  - backend/src/built-in-reports/data-quality-reports.service.spec.ts
---

## Decided
- Built-in reports and the custom report engine convert through `ReportCurrencyService.buildConverter(rows, currency)`: the row's own rate where it settled into the reporting currency (`ownRateSql` / `transactionRateBasis`, same rule as the Cash Flow Sankey), else `convertAtDate` at the row's date. `buildRateMap` / `tryConvertAmount` are gone.
- Each report query selects `rateBasisColumnsSql(currencyParam)` (`tx_date`, `own_rate`) and adds `RATE_BASIS_GROUP_BY`. The reporting currency is a NEW parameter used only by those columns, so every hard-coded `$3` start date moved to `$4`. `tx_date` is NULL for a reporting-currency row, so a single-currency report keeps its row count.
- The rate history loads through `ExchangeRateService.getRateIndex` (wraps `buildRateIndex`), not the report's own `dataSource`.
- A grouping that judges its total must fold the per-day parts back first: Weekend vs Weekday regroups before `isNetSpending`, and Recurring Expenses uses `SUM(COUNT(*)) OVER (PARTITION BY ...)` in place of `HAVING COUNT(*) >= $4`.
- The custom report's budget variance converts the plan at the window's last day, with its own `buildConverter` call. The currency is unknown when the transactions' index is built.

## Tried and ruled out
- Loading the index through `ReportCurrencyService`'s dataSource, the way the Sankey does. Every report spec mocks `manager.query` with one `mockResolvedValue` fixture, so the rate query got aggregate rows back.

## Watch out
- Spec fixtures: a foreign row needs `tx_date`. Use `FIXTURE_TX_DATE` and `rateIndexOf` from `src/test-helpers/report-rate-testing.ts`, where rates are dated 2026-01-15 by default. A 2025 row is then look-ahead and converts to null.
- `duplicate-functions.guard.spec.ts` flags a second copy of the own-rate parser. Import `toOwnRate`.
- Still open, waiting on a maintainer decision: frontend surfaces that convert dated amounts with `useExchangeRates` (latest only): RealizedGains, ForeignCurrencyFees, DividendIncome, DividendYieldGrowth via `convertRowAmount`, the category/payee pages via `widget-shared`, `TagKeyBreakdownChart`, and the transactions-page balance line. Also the backend's portfolio `costBasisDefaultCurrency` / `totalNetInvested`.
