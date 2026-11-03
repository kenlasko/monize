---
title: "Custom reports: only the ungrouped No Aggregation list is signed; cross-currency transfer legs need not cancel"
author: Node
date: 2026-11-03
branch: claude/issue-1998
cost: { minutes: 29, tokens: 168389 }
touches:
  - docs/system-invariants.md
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
  - backend/src/reports/reports.service.spec.ts
  - backend/src/reports/reports.service.ts
  - frontend/src/components/reports/CustomReportViewer.test.tsx
  - frontend/src/components/reports/CustomReportViewer.tsx
  - frontend/src/components/reports/ReportChart.tsx
  - frontend/src/lib/custom-report-measure.test.ts
---

## Decided
- The server signs rows only in aggregateNoGrouping (groupBy NONE + metric NONE + BOTH). A grouped metric NONE report sums each group's unsigned cells (calculateMetricValue NONE = sum), so the client captions it "Total of unsigned category amounts" and does not treat it as a signed list (isSignedTransactionList takes the report, groupBy included).
- The custom report fetch orders with applyRegisterOrder(qb, "transaction", "ASC"), so same-day rows and the row-limit cut are deterministic.
- Cross-currency transfer legs in a BOTH list each convert at the latest rate (createConverter -> buildRateMap -> getLatestRates), so they can leave a residual in "Net cash movement". Documented, not fixed: fixing needs a decision on which leg's own rate (only the destination leg carries exchangeRate) answers for which reporting currency.

## Tried and ruled out
- Returning a server-side `signed`/`measure` field on ReportResult: the more authoritative answer, but a cross-layer API change beyond a review follow-up. Proposed, not done.

## Watch out
- Signing BOTH lists also changes a saved "sort by Amount" on them: sortData compares raw values, so the largest expenses now sort last under DESC.
- ReportChart is untranslated end to end (headers, the 'Total' default); a translated totalLabel sits beside English headers.
- backend test:changed fails loan-payment-frequency.guard.spec.ts under TZ=America/Toronto; run it with TZ=UTC as CI does.
