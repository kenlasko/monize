---
title: "Dashboard net worth after a price refresh: snapshots must be recalculated before the refresh answers (#2350)"
author: Node
date: 2026-11-23
branch: claude/issue-2350
cost: { minutes: 16, tokens: 224949 }
touches:
  - docs/frontend/financial-figures.md
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/components/dashboard/DashboardHero.tsx
  - frontend/src/components/dashboard/NetWorthChart.test.tsx
  - frontend/src/components/dashboard/NetWorthChart.tsx
  - frontend/src/components/dashboard/NetWorthHero.test.tsx
  - frontend/src/components/dashboard/NetWorthHero.tsx
  - frontend/src/components/dashboard/widget-registry.tsx
  - backend/src/securities/securities.controller.spec.ts
---

## Decided
- Supersedes the "NetWorthHero is not reloaded" watch-out in the earlier #2350 notes: the maintainer ruled that "all portfolio values" includes net worth. NetWorthHero, NetWorthChart (both via priceRefreshKey + requestKey = config.range) and the page's 12-month netWorthData (re-fetched in reloadInvestmentWidgets, for Assets vs Liabilities) now reload on a price refresh.
- `/net-worth/monthly` reads stored monthly_account_balances snapshots, which `POST /securities/prices/refresh/selected` used to recalculate fire-and-forget AFTER answering, so an immediate reload read the old month. The controller now awaits `recalculateAllAccounts` (after the price commit, outside its transaction; errors logged, refresh still succeeds) before responding.
## Tried and ruled out
- Calling `netWorthApi.recalculate()` from the client after the refresh: a second full recalculation racing the server's own.
## Watch out
- The backfill route (`prices/:id/backfill`) still recalculates fire-and-forget; a surface that reloads net worth right after a backfill would read the old month.
