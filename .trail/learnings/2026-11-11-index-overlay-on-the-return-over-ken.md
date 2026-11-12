---
title: Index overlay on the return-over-time chart draws each index from its own points
author: Ken
date: 2026-11-11
branch: feat/release-1.21-tours
id: l-fb91e352
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/dashboard/widget-meta.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.chartUx.test.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.mobileWrapped.test.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.test.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.tsx
  - frontend/src/components/reports/PortfolioReturnChart.test.tsx
  - frontend/src/components/reports/PortfolioReturnChart.tsx
  - frontend/src/components/reports/ReportSwitcher.test.tsx
  - frontend/src/components/reports/ReportSwitcher.tsx
  - frontend/src/components/reports/SecurityPerformanceReport.tsx
---

## Decided
Market indexes on the Investment Performance report's Portfolio / By account chart are fetched index-only from the performance-comparison endpoint, rebased on the first date of the drawn TWR series (read off the answer, not rederived from the range), and each index Line gets its own `data` (its sampled dates, server nulls kept, connectNulls={false}). The tooltip reads index values from a per-index ts map, not from Recharts' payload, and index lines have activeDot={false}.

## Tried and ruled out
- Merging index points into the daily TWR rows: the index has points only on trading days (or weekly/monthly over 400+ days), so with connectNulls={false} it breaks every weekend, and index-only dates break the portfolio line.
- Splitting each index into segments at server nulls and using connectNulls within a segment: the ui-conventions guard fails any connectNulls other than ={false}, and its baseline is shrink-only.
- Relying on Recharts' tooltip payload for a Line with its own data: when the hovered ts is not in that line's data, Recharts falls back to the same array index, which is a different date's value (combineTooltipPayload).

## Watch out
docs/specs/portfolio-twr-series.md lists benchmark overlays on the portfolio line as out of scope; this feature was asked for directly by the maintainer.

In the code: frontend/src/components/reports/index-overlay-lines.ts, frontend/src/hooks/useIndexComparison.ts, frontend/src/hooks/useMarketIndexPicker.ts (shared with SecurityPerformanceReport), PortfolioReturnChart.tsx.
