---
title: "Review of #2414: shareOf lives in common/fx-aggregate; the weightings service is the next float-sum surface"
author: Node
date: 2026-11-25
branch: claude/issue-2414
cost: { minutes: 6, tokens: 53354 }
touches:
  - docs/frontend/financial-figures.md
  - docs/specs/report-rounding-and-aggregation.md
  - docs/system-invariants.md
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - frontend/src/components/reports/PortfolioValueReport.test.tsx
  - frontend/src/components/reports/PortfolioValueReport.tsx
  - frontend/src/components/reports/RealizedGainsReport.test.tsx
  - frontend/src/components/reports/RealizedGainsReport.tsx
  - backend/src/built-in-reports/comparison-reports.service.ts
  - backend/src/built-in-reports/income-reports.service.ts
---

## Decided
- shareOf(part, whole) moved from reports/report-rows.ts to common/fx-aggregate.ts. The custom report, Income by Source and Weekend vs Weekday all call it, and a new report share should too.
- Security Performance's total return is sumMoney([value, -cost], moneyDecimalsForCurrency). A difference of two four-place figures is a float drift too, not only a sum.
- Realized Gains gives each security row a `gap` ConvertedTotal (no-rate sales plus unknown-cost sales) and marks it with PartialTotal, as it does the totals.
- Portfolio Value: unknownBandKeysOf(point, series) marks only the named unpriced securities' bands, plus 'other' when a named security has no band of its own. It does this only where the point's own missingRatePairs list is present and empty. Otherwise every absent band is unknown.

## Watch out
- backend/src/securities/sector-weighting.service.ts (sector, country and asset-class weightings) still sums floats with += and rounds at four places. The Geographic report's country "Other" share divides two readings on the client. This is an open task-list line, not fixed here.
- The client's sumConverted floors at places + 8 guard digits, which is 10 for a two-place currency, while FxAggregate floors at a fixed 12. Both keep 15 significant digits below 1,000.
