---
title: Custom report list keeps a row with no rate; unconverted amount columns print number + code (issue 2342)
author: Node
date: 2026-11-23
branch: claude/issue-2342
cost: { minutes: 33, tokens: 196355 }
touches:
  - docs/frontend/forms-and-formatting.md
  - frontend/src/components/reports/ReportChart.test.tsx
  - frontend/src/components/reports/ReportChart.tsx
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
  - backend/src/reports/dto/execute-report.dto.ts
  - backend/src/reports/reports.service.spec.ts
  - backend/src/reports/reports.service.ts
  - backend/test/integration/report-custom-transfer-fx.integration.spec.ts
---

## Decided
- aggregateNoGrouping (metric NONE) no longer drops a row or split line whose conversion is null: it is pushed with `value: null` beside accountAmount. AggregatedDataPoint.value is `number | null` in both layers; grouped aggregators build `KnownDataPoint` (value: number, in execute-report.dto.ts). calculateSummary sums only known values; summary.count counts listed rows; excludedCount still counts the row (conv.convert records the gap). sortData VALUE puts null rows last in either direction.
- ReportChart: table/PDF print '-' for Amount and %, CSV a blank cell; pie/bar/line plot `plottedData` (known rows only) and `total` sums those. CustomReportViewer's legend filters null rows after colour assignment to stay in step.
- Amount (account currency) and Amount (original currency) print `${formatNumber(amount, getDecimalPlacesForCurrency(code))} ${code}` on every row, the reader's own currency included. Rule written in docs/frontend/forms-and-formatting.md beside withCurrencyCode.
## Tried and ruled out
- Fixing "CHF 100.00 CHF" inside withCurrencyCode: format.test.ts pins that an ISO code is still appended ("so no fiat figure changes"), and the helper deliberately omits the reader's own currency, which this column must show.
- Showing the unconverted amount in the Amount cell when no rate exists: the issue asked for a dash, and an unconverted figure under a converted header breaks INV-FX-001.
## Watch out
- backend/test/integration/report-custom-transfer-fx.integration.spec.ts pinned the old drop ("its other line unknown"); a split's lines come back in no guaranteed order, so the spec sorts by accountAmount.
- ReportChart.test's formatNumber mock is toFixed, so locale separators are not exercised there.
