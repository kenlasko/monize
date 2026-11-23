---
title: "Dashboard price refresh: every self-fetching priced widget takes priceRefreshKey (supersedes the #2350 note)"
author: Node
date: 2026-11-23
branch: claude/issue-2350
cost: { minutes: 6, tokens: 64042 }
touches:
  - docs/frontend/financial-figures.md
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/components/dashboard/PortfolioValueWidget.test.tsx
  - frontend/src/components/dashboard/PortfolioValueWidget.tsx
  - frontend/src/components/dashboard/widget-registry.tsx
  - frontend/src/components/dashboard/PortfolioHero.test.tsx
  - frontend/src/hooks/usePortfolioPeriodResult.test.ts
  - frontend/src/hooks/usePortfolioPeriodResult.ts
  - frontend/src/components/dashboard/GeographicAllocationWidget.test.tsx
  - frontend/src/components/dashboard/GeographicAllocationWidget.tsx
---

## Decided
- Supersedes the earlier #2350 note. Four dashboard surfaces fetch their own priced data and take the page's `priceRefreshKey` (bumped in the page's onRefreshComplete): PortfolioHero, PortfolioValueWidget, SecurityTypeAllocationWidget (valuation + asset-class weightings) and GeographicAllocationWidget (valuation + country weightings; getSecurities is not priced and is not re-asked). A new widget that fetches a valuation or weightings must take it too.
- Portfolio Value no longer runs its own usePriceRefresh: it calls the page's `ctx.onRefresh(scope)` so its refresh reloads every priced widget. `DashboardWidgetContext.onRefresh` accepts an optional scope.
- usePortfolioPeriodResult now keeps its previous answer while only `reloadKey` moved (scopeKey without reloadKey), like usePortfolioPeriodResults; never another window's answer, never a failure.
## Tried and ruled out
- A widget-local refresh counter summed with the page key: the widget's own refresh then reached nothing else on the page.
## Watch out
- NetWorthHero and the page's netWorthData are still not reloaded on a price refresh; only the invested figure (portfolioValuation) is.
