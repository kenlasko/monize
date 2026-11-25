---
title: "Report export precision (stage 3, X1): CSV numbers, PDF formatted per surface"
author: Node
date: 2026-11-25
branch: claude/issue-2411
cost: { minutes: 12, tokens: 177287 }
touches:
  - docs/frontend/financial-figures.md
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - frontend/CLAUDE.md
  - frontend/src/components/reports/BillPaymentHistoryReport.test.tsx
  - frontend/src/components/reports/BillPaymentHistoryReport.tsx
  - frontend/src/components/reports/DuplicateTransactionReport.test.tsx
  - frontend/src/components/reports/DuplicateTransactionReport.tsx
  - frontend/src/components/reports/InvestmentReportViewer.test.tsx
  - frontend/src/components/reports/InvestmentReportViewer.tsx
  - frontend/src/components/reports/MonteCarloReport.test.tsx
---

## Decided
- Export precision lives in docs/frontend/financial-figures.md, "An export writes the screen's figure, at one export precision". A CSV money cell is a JS number, the server's figure as it arrives, which csv-export writes as String(n). A figure the client computes is rounded once with roundToCurrencyPlaces (lib/format.ts, via getDecimalPlacesForCurrency). An unknown is an empty cell, or the screen's cause text, and never 0.
- A PDF's money cells are formatted by the report itself, because pdf-export-tables formats nothing. The pattern is getExportData(surface: 'csv' | 'pdf'), using the same formatter as the on-screen cell. That is formatCurrencyCompact for Bill Payment History and Recurring Expenses, whose tables show whole units.

## Watch out
- src/test/number-locale.guard.test.ts counts toFixed calls per file, and the count must drop when one is removed. Removing toFixed from MonteCarloReport meant deleting its CLASSIFIED entry and lowering the non-vacuous check from >=5 to >=2.
- Realized Gains' totals are still a client float sum (C3's scope), and its PDF prints them under "Total" even when unknownCount > 0.
- trail check flags keyword overlaps ("four places", "round at places") on any rounding doc. These are not conflicts unless a stored or wire figure gets re-rounded.
