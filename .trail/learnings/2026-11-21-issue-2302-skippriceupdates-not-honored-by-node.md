---
title: "Issue #2302: skipPriceUpdates not honored by the intraday chart"
author: Node
date: 2026-11-21
branch: claude/issue-2302
cost: { minutes: 14, tokens: 193265 }
touches:
  - backend/src/securities/portfolio.service.spec.ts
  - backend/src/securities/portfolio.service.ts
  - backend/src/securities/provider-priced.guard.spec.ts
  - backend/src/securities/provider-priced.util.ts
  - backend/src/securities/security-price.service.ts
---

## Decided
- `isPricedByQuoteProvider` (bond-link only) and `isRefreshEligible` (bond-link + `skipPriceUpdates`) are two different predicates; every *scheduled* automatic-fetch path in `security-price.service.ts` (refresh, backfill, settlement, ensurePricesForDate) already used `isRefreshEligible`, but `PortfolioService.toIntradayHolding` (the dashboard/portfolio intraday-value-series chart) used only `isPricedByQuoteProvider`, so a security with "Disable Automatic Updates" on (e.g. a manually tracked GIC) still got queried against Yahoo/MSN on every chart load.
- Fix: moved `isRefreshEligible` out of `security-price.service.ts` (where it was module-private) into `provider-priced.util.ts` beside `isPricedByQuoteProvider`, so it is one shared, importable predicate; switched `portfolio.service.ts` to use it. A skip-flagged holding now falls back to its stored close for the intraday chart, same as a bond-linked or inactive one.
- `provider-priced.guard.spec.ts`'s scanner only checks that a file *calls* `isPricedByQuoteProvider`/`isRefreshEligible` somewhere in the method that reaches a provider -- it doesn't check that the right one of the two is called for the purpose. That's why this gap wasn't caught: `toIntradayHolding` did call a predicate, just the narrower one. The guard's one hard-coded location check (`function isRefreshEligible(...)` inside `security-price.service.ts`) had to move with the function, to `provider-priced.util.ts`.

## Tried and ruled out
- Nothing ruled out -- once `trail grep "skipPriceUpdates"` and `trail callers isRefreshEligible` were run, every other automatic-fetch call site (sector weighting, Monte Carlo backfill, GEM backfill, performance-comparison history, top-movers/month-over-month boards) already excluded skip-flagged securities correctly. The intraday chart was the only miss.

## Watch out
- If you add a new path that fetches a provider quote for "every active security" (another chart, a new board), reach for `isRefreshEligible` from `provider-priced.util.ts`, not `isPricedByQuoteProvider` alone -- the bond check alone lets a skip-flagged security through.
- `provider-priced.guard.spec.ts` only proves *a* predicate was called in the method, not the *correct* one for what the method is about to do with the result. Don't trust a green run of that guard as proof `skipPriceUpdates` is honored; grep for the actual predicate name used.
