---
title: "Investments summary FX comes from a live quote, not the Currencies page rate (issue 1973 review)"
author: Node
date: 2026-10-31
branch: claude/issue-1973
cost: { minutes: 10, tokens: 164918 }
---

## Decided
- Issue #1973 asked whether PR #1942 moved the Investments summary figures. Static review: #1942 did not touch the valuation path. `calculateHoldingsWithValues`, `getLatestPrices`, `convertToDefault`, `primeLiveRates` and `computeTotalCashValue` are identical between v1.19.0 and HEAD apart from the A26-M38 gain-over-the-same-holdings bookkeeping (PR #1869). The bond engine change in #1942 alters `principal` on a matured compounding lot only; a bond holding is valued at `gross` (`ownLotsValue`), so its value is unchanged.
- The Currencies page USD rate change (3.840246 -> 3.947732) is commit 3918004b5 in PR #1869, not #1942: `getLatestRates` now answers one row per directionless pair, the newer stored direction within FX_MAX_RATE_AGE_DAYS. Before, it listed the newest row per stored direction and the client's `getRate` took the direct `USD->X` row first, which on a database upgraded from before 1.17 is the frozen mirror row the refresh no longer writes.
- The Investments summary never read `getLatestRates`. Its "as of now" conversions (holdings value, cash, net invested, allocation) come from `primeLiveRates` -> `ExchangeRateService.getLiveRate` (FX provider chain, Frankfurter `/latest` first, Yahoo second) with `resolveStoredRate(live)` as the fallback. Both are unchanged since v1.19.0, so two versions >= v1.19.0 viewing the same data at the same moment convert at the same rate; a figure that differs between two sessions is the live quote or the latest price at each viewing time.
- TWR and MWR come from `PortfolioPeriodResultService.getInvestedResultSinceInception` (stored daily series), so they stay put when the live quote moves. Total Gain = totalPortfolioValue - totalNetInvested and Simple Return/CAGR are derived from the value, so they move with it.

## Tried and ruled out
- The #1942 `position-basis-replay.ts` change (full sale quantity via `applyActionToQuantity`, `basisGap = quantity_only_action` on an oversell) can move Gain/Loss only for a position whose history sells more than it holds; it cannot move Holdings Value.

## Watch out
- To attribute a Currencies-page rate change, query `exchange_rates` for both directions of the pair ordered by `rate_date DESC`: a frozen `USD->X` row dated before the 1.17 upgrade beside a fresh `X->USD` row is the mirror case.
- The Currencies page shows the stored rate; the Investments summary converts at a live quote. The two pages can legitimately disagree on the same day.
