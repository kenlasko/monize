---
title: "Review of report rounding stage 2: where two-place figures broke client sums"
author: Node
date: 2026-11-25
branch: claude/issue-2410
cost: { minutes: 30, tokens: 240940 }
touches:
  - backend/src/net-worth/net-worth.service.spec.ts
  - backend/src/net-worth/net-worth.service.ts
  - backend/test/integration/portfolio-movement-flow.integration.spec.ts
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
  - docs/specs/report-rounding-and-aggregation.md
  - frontend/src/components/reports/CashFlowSankeyReport.test.tsx
  - frontend/src/i18n/messages/de/reports.json
---

## Decided
- A figure the client still adds to something else stays at money precision until stage 3 moves the sum to the server: an account's totals in the portfolio summary (moneyDecimalsFor of its currency's places, so four for fiat, a coin's own) and the Foreign Currency Fees rows (FIAT_MONEY_DECIMALS into convertDatedRows). Reading them at two places put the page's sums a cent off.
- A difference the client showed is sent by the server as one rounding: PortfolioSummary.totalGainOverNetInvested, each monthly net worth month's netWorthChange (the hero reads it; getLlmHistory strips it). The trivia differences months through getMonthlyNetWorthWithAggregates and FxAggregate.difference (netWorthBetween in trivia-facts.ts).
- Investment breakdown: security and "other" bands are apportioned over the securities subtotal's own rounding; the cash band is round(total) - round(securities), so total less cash equals the daily series' securitiesValue. The client takes that difference with sumMoney in the currency's money units.
- Monthly Comparison: "more"/"less" reads FxAggregate.difference(...).sign; a percentage only over a previous month whose reading at places is non-zero (else 100, or 0), the same base rule as compare_periods.
- FxAggregate.unitsAt(places) gives an exact bigint unit count: through knownSubtotalAt while a double holds the value well under a unit, integer half-away rounding past that. apportionUnits uses it, so eight places above ~5e7 no longer throws.

## Tried and ruled out
- Moving getMonthlyNetWorth's `|| "1990-01-01"` into getMonthlyNetWorthWithAggregates: the "no new fixed-epoch window default" guard in net-worth.service.spec.ts allows it only in getMonthlyNetWorth and getMonthlyInvestments. A whole-history aggregate series opens at the first stored month (MIN(month)) instead.
- Two 124.752474 rows as a rounding test at two places: they read 249.50 whether summed exactly or as two-place readings. 1.93 EUR at 1.2474 (2.41 each, 4.81 together, 4.82 from readings at two or at four) tells all three apart.

## Watch out
- reportPlacesMock (test-helpers/report-rate-testing.ts) answers BTC at 8 by default now; a mocked spec that wants a coin at other places passes them.
- After changing a method's window or defaults, rerun the whole spec file of that service; the fixed-epoch guard lives at the end of net-worth.service.spec.ts.
