---
title: "Issue #2106 follow-up: server-side dated conversions beyond the reports"
author: Node
date: 2026-11-10
branch: claude/issue-2106
cost: { minutes: 139, tokens: 783203 }
touches:
  - docs/system-invariants.md
  - backend/src/ai/ai-usage.service.spec.ts
  - backend/src/ai/ai-usage.service.ts
  - backend/src/built-in-reports/comparison-reports.service.ts
  - backend/src/built-in-reports/data-quality-reports.service.ts
  - backend/src/built-in-reports/income-reports.service.ts
  - backend/src/built-in-reports/monthly-category-breakdown.service.ts
  - backend/src/built-in-reports/report-currency.service.spec.ts
  - backend/src/built-in-reports/report-currency.service.ts
  - backend/src/built-in-reports/spending-reports.service.spec.ts
---

## Decided
- The maintainer chose server-side conversion for every surface (answer to #2106): endpoints return a reporting-currency figure beside the native one. Examples: transaction summary `converted`, grouped/tag `convertedTotal`, category/payee detail accounts, fee summary `convertedFeeTotal`, daily balances `convertedBalance`, capital gains and realized gains `inReportingCurrency`, AI usage `*InReportingCurrency`, investment rows `reportingRate` / `accountRate` / `ratesInto`. The frontend reads these instead of `useExchangeRates` convert.
- The maintainer chose historical cost: the portfolio cost basis and net invested in the reporting currency convert each purchase or flow at its own date. `replayPositionBasis` takes a `targetCurrency`, and its rates load in one `getRateIndex` read.
- Per-row rule for investment rows: `investmentRowRateInto` (`src/securities/investment-row-fx.util.ts`), the row's own rate first, then onward at the market rate. For transactions: `convertRateBasis` / `convertDatedRows` in `report-currency.service.ts`.
- A report that splits a foreign aggregate by day must use `wholeGroups` and pass a group key to `ConversionGaps.record`. Otherwise a debit survives while its refund (on a rate-less day) is dropped, and `excludedCount` counts days.

## Tried and ruled out
- A client-side dated-rate hook: rejected by the maintainer in favour of server figures.
- Keeping a `convert` (latest-rate) fallback in `convertRowAmount` for unstated targets: that reintroduces the defect. The server stamps every page account currency instead.

## Watch out
- `?? 0` over a converted figure turns "no rate" (null) into zero. This bit net invested once.
- Splitting per day changes rounding: sum raw parts and round once (`sumMoney`). AI usage costs drifted when rounded per day.
- `ai_usage_logs.created_at` is a TIMESTAMP without time zone: use `TO_CHAR(created_at, ...)` and `formatDateYMDLocal` for the same day.
- Still not done, noted in the PR: `datedForeignTotals` re-runs the filtered analytics query, and `historicalCostBasesInReporting` re-reads the history the lots replay already loaded.
