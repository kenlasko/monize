---
title: "Dashboard price refresh must reach widgets that fetch their own valuation (issue #2350)"
author: Node
date: 2026-11-23
branch: claude/issue-2350
cost: { minutes: 11, tokens: 131018 }
touches:
  - docs/frontend/financial-figures.md
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/components/dashboard/DashboardHero.tsx
  - frontend/src/components/dashboard/PortfolioHero.test.tsx
  - frontend/src/components/dashboard/PortfolioHero.tsx
  - frontend/src/components/dashboard/PortfolioValueWidget.test.tsx
  - frontend/src/components/dashboard/PortfolioValueWidget.tsx
  - frontend/src/components/dashboard/widget-registry.tsx
---

## Decided
- The dashboard page's usePriceRefresh onRefreshComplete (reloadInvestmentWidgets) only reloads the page's own state (top movers, portfolioValuation, favourites). PortfolioHero and PortfolioValueWidget fetch their own valuation/series/period result/returns via useReportData, so the page now bumps `priceRefreshKey` there and passes it through DashboardWidgetContext and DashboardHero; each fetch lists it in deps and as usePortfolioPeriodResult's reloadKey.
- To avoid the hero/widget dropping to skeletons seconds after load, each useReportData gets a `requestKey` WITHOUT the refresh key, and the placeholder shows only while `dataKey !== requestKey` (data answers a different scope), mirroring the Investments page's keep-previous-figures rule.
## Tried and ruled out
- Calling `reload()` from the widget's own refresh: it skipped the period result. A local counter summed with the prop key re-asks everything.
## Watch out
- NetWorthHero (monthly net worth) and the page's netWorthData are NOT reloaded on a price refresh; only the invested figure via portfolioValuation is.
- react-hooks/preserve-manual-memoization fails a `useCallback(() => setX(...), [])`; pass the arrow inline to usePriceRefresh instead.
