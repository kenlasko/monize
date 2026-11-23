---
title: "Automatic price refresh (#2351) after review: failed reloads keep figures, first loads hold it, batches of 100 (supersedes the earlier #2351 note)"
author: Node
date: 2026-11-23
branch: claude/issue-2351
cost: { minutes: 17, tokens: 177682 }
touches:
  - docs/frontend/api-and-cache.md
  - frontend/src/lib/api-page-limits.ts
  - frontend/src/lib/investments.test.ts
  - frontend/src/lib/investments.ts
  - frontend/src/test/api-page-limits.test.ts
  - frontend/src/lib/price-auto-refresh.test.ts
  - frontend/src/lib/price-auto-refresh.ts
  - website/docs/investments.html
  - website/docs/investments.md
  - website/docs/search-index.json
---

## Decided
- Supersedes the earlier #2351 note, whose `touches` named PortfolioValueWidget files the final diff does not change (the dashboard widgets are #2350's, reached through `reloadInvestmentWidgets`).
- A reload after a price refresh keeps what is on screen when it fails: `loadAllPortfolioData(..., { keepOnFailure: true })` on Investments, `getPortfolioValuation().catch(() => undefined)` kept on the Dashboard, and `InvestmentDetailView` re-asks only the summary when only `refreshKey` moved (income and realized gains are not priced), keeping it on failure. The Securities list uses `fetchData({ quiet: true })` with a `loadSeq` guard.
- `holdAutomaticPriceRefresh()` (`frontend/src/lib/price-refresh-state.ts`) counts pages loading their first figures; usePriceRefresh's `holdAutomaticRefresh` option takes it. While held no automatic refresh starts, and one already on the wire that writes keeps its notification until the last release. Dashboard and Investments hold until their first valuation is in (#1888 on every in-app navigation, not only the first page).
- `lse` / `deutsche_boerse` overrides trade 08:00-16:30 Europe/London / 09:00-17:30 Europe/Berlin when no session is recorded; a null provider is the reader's default (Yahoo/MSN), so it keeps the New York fallback.
- `investmentsApi.refreshSelectedPrices` batches by `REFRESH_SELECTED_MAX_IDS` (100, `@ArrayMaxSize` on the DTO, checked in `src/test/api-page-limits.test.ts`) for manual and automatic refreshes alike.
## Tried and ruled out
- Rewriting the branch history (the worker's WIP commit) and rebasing: both are "ask first" in AGENTS.md on a pushed branch; squash-merge gives one conventional commit.
- Cross-tab coordination (BroadcastChannel): sharing the timestamp also needs sharing the "wrote" news and cache drops, or the other tab stays stale; hidden tabs already ask nothing.
## Watch out
- Editing `reloadInvestmentWidgets` here: #2350 inserts lines right after its signature and after `if (hasInvestments) {`; keep edits on the Promise.all lines and check `git merge-tree --write-tree HEAD origin/claude/issue-2350`.
- The dashboard spec's usePriceRefresh and DashboardHero mocks are rewritten by #2350; test the dashboard through the FavouriteAccounts mock (`data-market-values`) instead.
