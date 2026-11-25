---
title: "Portfolio summary and Portfolio Value series at currency places; the period result's daily series stays at four (#2410)"
author: Node
date: 2026-11-25
branch: claude/issue-2410
cost: { minutes: 28, tokens: 132567 }
touches:
  - backend/src/built-in-reports/data-quality-reports.service.spec.ts
  - backend/src/built-in-reports/data-quality-reports.service.ts
  - backend/test/integration/bond-holding-value.integration.spec.ts
  - docs/specs/report-rounding-and-aggregation.md
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
  - backend/src/built-in-reports/built-in-reports.service.spec.ts
  - backend/src/built-in-reports/dto/duplicate-transactions.dto.ts
  - frontend/src/components/reports/DuplicateTransactionReport.test.tsx
---

## Decided
- Ken asked for all of it in #2410: the portfolio summary's reporting-currency totals and allocation read at the reporting currency's places, an account's totals at its own currency's (reportPlacesOfCodes, one scoped read for the coins), totalPortfolioValue = FxAggregate.sum([cash, holdings]) read once, gain %/allocation shares/CAGR from unroundedSubtotal. calculateHoldingsWithValues and computeTotalCashValue take `places` and also return their aggregates.
- getLlmSummary hands the summary's figures on as shown (asShown); only a holding's own figures keep roundMoney(4).
- NetWorthService.getDailyInvestments keeps four places: PortfolioPeriodResultService, the TWR series and daily movement work returns out of it. The report path is getDailyInvestmentsReport, reading each day's aggregates (DailyInvestmentsWithPositions.readings) at places via dailyInvestmentsAtPlaces. Sampled, monthly and breakdown series are endpoint-only and read at places directly; the breakdown apportions its bands from each point's total (apportionUnits), like the Sankey.
- Duplicate Transactions potentialSavings now converts each extra copy at its own row's rate basis (a group can mix currencies) and is withheld (null) beside knownPotentialSavings when a copy has no rate.

## Tried and ruled out
- Rounding getDailyInvestments itself at places: the period result's P&L and TWR would then be worked out from rounded figures.
- Converting a duplicate group's copies at its first row's currency: a USD/CAD pair of 100.00 counted the CAD copy as 100 USD.

## Watch out
- Left at four places: a holding's own value/cost/gain and the intraday (1D) bars (four-place contributions per bar).
- A breakdown band is dropped below half a unit at `places`, not a fixed 0.005.
- Fixtures building DailyInvestmentsWithPositions need `currency` and `readings`.
