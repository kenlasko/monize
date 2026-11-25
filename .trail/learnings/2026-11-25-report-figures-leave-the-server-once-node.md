---
title: "Report figures leave the server once-rounded at the currency's places: knownSubtotalAt / reportFigure (#2410)"
author: Node
date: 2026-11-25
branch: claude/issue-2410
cost: { minutes: 91, tokens: 923820 }
touches:
  - backend/src/built-in-reports/anomaly-reports.service.ts
  - backend/src/common/report-rounding.guard.spec.ts
  - backend/src/transactions/transaction-analytics.service.spec.ts
  - backend/src/transactions/transaction-analytics.service.ts
  - docs/specs/report-rounding-and-aggregation.md
  - docs/system-invariants.md
  - docs/financial-calculation-contract.md
  - docs/financial-semantics.md
  - docs/frontend/financial-figures.md
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
---

## Decided
- Stage 2 of docs/specs/report-rounding-and-aggregation.md (section 6, option b): a report figure is read with FxAggregate.knownSubtotalAt(places) / totalAt(places), or reportFigure(value, places) for a non-aggregate (backend/src/common/report-figure.ts). knownSubtotal/total stay at four places for non-report surfaces (account lists, the budget page, transactions widgets, detail pages).
- Places = reportPlacesFor: the ISO minor unit via Intl (what useNumberFormat().formatCurrency formats at), else the currency row's decimal_places, capped at 8. ReportCurrencyService.getReportPlaces == reportPlacesOf(dataSource, code); loadReportPlaces(m, code) inside a transaction. An ISO code needs no DB read.
- The Sankey apportions and closes in 10^-places units (apportionUnits(parts, places, target?)); the page shows sankey.roundingNote beside the nodes.
- compare_periods now takes each change from FxAggregate.difference of the two periods; a percentage only over a first period that reads as money at places.
- report-rounding.guard.spec.ts also fails a .knownSubtotal read in src/built-in-reports and src/reports outside a sort comparator.

## Tried and ruled out
- Widening FxAggregate's accumulator to MONEY_SCALE + 8 (16 places) so a coin's 8-place reading keeps 8 guard digits: it kept the float noise of amount * rate and a custom report share read 25.000000000000007. Twelve places stays; a coin keeps four guard digits.
- A dust first period judged on sign in compare_periods: 0.003 gave ~3,333,233%; the reading at places is the guard.

## Watch out
- Every spec that mocks ReportCurrencyService as a plain object needs getReportPlaces: reportPlacesMock() in src/test-helpers/report-rate-testing.ts.
- At two places 100.01 EUR x 1.2474 rows no longer discriminate grouping bugs (124.75 + 124.75 = 249.50 = exact); use 1.00 EUR rows (1.25 each, 2.49 together) or a 2.50498 figure.
- Still four places (recorded in INV-REPORT-005's gap): the portfolio summary (getPortfolioSummary, which feeds Monte Carlo seeds, movement alerts, trivia, get_portfolio_summary), the budget lines' CategorySpending readings, the Monthly Comparison's PortfolioPeriodResultService figures.
- trail check flags ~20 keyword-overlap false positives on this area.
