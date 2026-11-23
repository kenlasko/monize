---
title: "Automatic price refresh while the site is open (#2351): one engine, pages subscribe, reloads stay quiet"
author: Node
date: 2026-11-23
branch: claude/issue-2351
cost: { minutes: 36, tokens: 348367 }
touches:
  - docs/frontend/api-and-cache.md
  - frontend/src/app/securities/page.test.tsx
  - frontend/src/app/securities/page.tsx
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/components/dashboard/PortfolioValueWidget.test.tsx
  - frontend/src/components/dashboard/PortfolioValueWidget.tsx
  - website/docs/investments.html
  - website/docs/investments.md
  - website/docs/search-index.json
  - frontend/src/components/investments/InvestmentValueChart.test.tsx
---

## Decided
- One engine: `runAutomaticPriceRefresh` (`frontend/src/lib/price-refresh-state.ts`) refreshes at most once per 15 min (`AUTO_PRICE_REFRESH_INTERVAL_MS`), counting failed/empty attempts. `PriceAutoRefresher` (root layout) asks every 30 s once the tab has been open an interval, only while visible, signed in and not a delegate (the securities routes have no `@AllowDelegate`). It lazy-imports the refresh state so `lib/investments` stays out of the root bundle (the command palette is the only shell user and it is `dynamic`).
- Which securities is `autoRefreshSecurityIds` (`frontend/src/lib/price-auto-refresh.ts`): active, not `skipPriceUpdates`, not bond-linked (INV-BOND-008), and trading now: CRYPTO always, else the stored Yahoo session (`getMarketState`), else the NYSE regular session. Only Yahoo fills `regularSession`; MSN, LSE, Deutsche Boerse and HTML tables report none.
- An unscoped manual refresh restarts the interval; a scoped one (security page, account-filtered holdings) does not (`setRefreshInProgress(true, { restartsInterval: false })`).
- Surfaces follow through `useOnAutoPriceRefresh` with the same reload their manual Refresh runs, and that reload must keep what is drawn: InvestmentValueChart's `refreshKey` effect now calls `fetchData` (no `loadData` dim/"Updating" label); the Securities list re-reads with `{ quiet: true }` plus a `loadSeq` guard.
## Tried and ruled out
- Subscribing PortfolioValueWidget itself: branch claude/issue-2350 rewrites that widget to take the dashboard's `priceRefreshKey` (bumped inside `reloadInvestmentWidgets`), so the dashboard's single `useOnAutoPriceRefresh(reloadInvestmentWidgets)` reaches hero, Portfolio Value and the allocation widgets once both land. Editing the widget here only produced merge conflicts.
## Watch out
- `InvestmentDetailView` renders a failed reload as "No data" / zero income (`.catch(() => null / [])`); the account page's auto refresh reaches it through `refreshKey`, so a transient failure there is visible. Pre-existing for writes and manual refresh.
- Sibling bot branches (claude/issue-N) touch the same files: `git merge-tree --write-tree HEAD origin/claude/issue-N` is a cheap no-checkout conflict check.
- PriceAutoRefresher tests need `await vi.dynamicImportSettled()` inside `act` after advancing timers.
