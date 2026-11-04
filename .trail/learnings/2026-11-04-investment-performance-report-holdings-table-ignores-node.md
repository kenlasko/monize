---
title: Investment Performance report holdings table ignores the date range (issue 2011)
author: Node
date: 2026-11-04
branch: claude/issue-2011
cost: { minutes: 2, tokens: 84066 }
touches:
  - frontend/src/components/reports/InvestmentPerformanceReport.tsx
  - AGENTS.md
---

## Decided
- Nothing built yet; questions posted on issue #2011 (per-security period gain meaning, return method, summary cards, closed positions, % Change definition, range set).
- The report (frontend/src/components/reports/InvestmentPerformanceReport.tsx) reads only getPortfolioSummary (all-time value minus cost basis); its range (useDateRange, CHART_RANGES 1m/3m/ytd/1y/5y/all) feeds only SecurityComparisonChart.
- The Investments page's period figures are the server's investmentPnl / investmentReturnPercent (PortfolioPeriodResultService, batch via usePortfolioPeriodResults); windows come from applyPortfolioWindowStart / usePortfolioRangeWindow, mirrored by backend portfolio-period-presets.util.ts.

## Tried and ruled out
- A client-side (price now - price at start) x shares per row: wrong for any buy/sell inside the window and cannot reconcile with the Investments page's investmentPnl.

## Watch out
- No per-security breakdown of the period result exists on the server; getPeriodResult values aggregate daily series plus loadInvestedCapitalFlowRows. A per-security split needs a new endpoint and a docs/specs/ spec first (AGENTS.md rule for financial features).
- Resolve the report's range through usePortfolioRangeWindow, not resolveRangePreset, or 1M/YTD/1Y windows differ from the Investments page.
