---
title: "A listed transaction's report share comes from the server, and fee totals over a month with no rate are null"
author: Ken
date: 2026-11-25
branch: claude/issue-2413
cost: { minutes: 31, tokens: 140949 }
id: l-5b5c9c9b
scope: repo
status: active
src: agent
touches:
  - backend/src/transactions/fx-fee-totals.spec.ts
  - backend/src/transactions/fx-fee-totals.ts
  - backend/src/transactions/transaction-analytics.service.spec.ts
  - backend/src/transactions/transaction-analytics.service.ts
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/specs/report-rounding-and-aggregation.md
  - frontend/src/components/accounts/shared/ForeignCurrencyFeeChart.test.tsx
  - frontend/src/components/accounts/shared/ForeignCurrencyFeeChart.tsx
  - frontend/src/components/reports/ForeignCurrencyFeesReport.test.tsx
  - frontend/src/components/reports/ForeignCurrencyFeesReport.tsx
---

## Decided
- A custom report row's share is always the server's `percentage`, divided from the unrounded sums. That includes listed transactions (metric NONE, one direction). The client never divides. A signed (BOTH) list gets no shares. The Total row prints 100% only when some row shows a share.
- The Foreign Currency Fees totals follow "a subtotal is not a total". When a fee in a month has no rate, `total`, `periodAverage` and the totals of that month's columns are `null`. `knownTotal` and `knownPeriodAverage` sit beside them. The chart draws the known part and marks the cards and the column as partial.
- The breakdown's funds block renders nothing while the funding fetch is `off`. That happens when only the period in progress is in the window, so the page sends no request.

## Tried and ruled out
- Dividing a listed row's rounded value by the server's rounded headline. This still divides one reading by another: two rows of 1.2474 read 50.2% each and add up to 100.4%, where the true share is 50%. The first stage-3 pass shipped this, with a test that pinned 50.2%.
- Returning the converted part as `total` and marking only the Total card. The average card and the bars then looked complete.

## Watch out
- Fees with no rate are dropped whole before the fold. A month whose fees were all dropped must still create a month entry flagged `partial`, or the gap disappears from the columns.

In the code:
- backend/src/reports/reports.service.ts aggregateNoGrouping sets `percentage: shareOf(row.sum, mergedSum(result))`
- frontend/src/components/reports/ReportChart.tsx `shareOf` is `item.percentage ?? null`; `showsShares` gates the 100%
- backend/src/transactions/fx-fee-totals.ts FxFeeMonthPart.partial; foldFxFeeTotals returns total/knownTotal and periodAverage/knownPeriodAverage
- frontend/src/components/reports/MonthlyTaggedBalanceSummary.tsx returns null when funding.status is 'off'
