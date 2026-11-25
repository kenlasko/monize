---
title: "Stage 3 (C2): page totals fold exact sums through combineTotals(totals, signs); report totals read the server's (#2413)"
author: Node
date: 2026-11-25
branch: claude/issue-2413
cost: { minutes: 28, tokens: 401332 }
touches:
  - docs/frontend/financial-figures.md
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/specs/report-rounding-and-aggregation.md
  - docs/system-invariants.md
  - frontend/src/components/reports/sankey-layout.test.ts
  - frontend/src/components/reports/sankey-layout.ts
  - backend/src/built-in-reports/comparison-reports.service.spec.ts
  - backend/src/built-in-reports/comparison-reports.service.ts
  - backend/src/built-in-reports/dto/weekend-vs-weekday.dto.ts
  - frontend/src/components/reports/WeekendVsWeekdayReport.test.tsx
---

## Decided
- ConvertedTotal carries `exact` ({units, scale, places}) from sumConverted; combineTotals(totals, signs, decimals?) rounds the signed sum of the exact sums once; a total without `exact` (reportTotal, a server figure) folds as its value. absoluteTotal negates a liability side exactly. Never spread a ConvertedTotal with a new `value` (it desyncs `exact`).
- Each combineTotals caller keeps the places it already rounded at (accounts/bills/register at four, Account Balances at four); only the netting changed.
- ReportChart: share = the row's server `percentage`; a listed row (no percentage) is a share of the server headline only when the metric's headline sums the rows (not AVERAGE / BUDGET_VARIANCE); no headline = blank Total row.
- Weekend vs Weekday gained summary.weekendShare / weekdayShare (unrounded division, null while gaps), with a client fallback for an older backend.
- Sankey merged links / Other node: sumMoney(values, currency places); confirmed presentation only (INV-SANKEY-005).

## Tried and ruled out
- Making ReportChart's totalRowValue required: 40 test renders lean on it; absent now means a blank Total row instead.

## Watch out
- Monthly Category Breakdown (client builds every total from rounded cells, folds years, drops the current period) and Foreign Currency Fees (client sums four-place converted rows across accounts/currencies, then the chart buckets them) need a design decision: server totals per view vs unrounded cell aggregates on the wire. Asked on the issue.
- test:changed after touching currency-total.ts runs ~985 files (~16 min); run it once.
- /tmp/onold.sh pattern: copy HEAD versions over the files, run the spec, copy back, to prove a test fails before.
