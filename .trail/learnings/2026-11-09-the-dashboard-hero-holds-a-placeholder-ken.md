---
title: "The dashboard hero holds a placeholder for slow figures instead of waiting, and the dashboard reads a valuation without the since-inception returns"
author: Ken
date: 2026-11-09
branch: fix/dashboard-hero-load
id: l-f300a282
scope: repo
status: active
src: agent
touches:
  - backend/src/securities/portfolio-summary-memo.spec.ts
  - backend/src/securities/portfolio-summary-memo.ts
  - backend/src/securities/portfolio.controller.spec.ts
  - backend/src/securities/portfolio.controller.ts
  - backend/src/securities/portfolio.service.spec.ts
  - backend/src/securities/portfolio.service.ts
  - docs/backend/securities-and-providers.md
  - docs/frontend/ui-conventions.md
  - docs/future-plans/dashboard-hero-load-tasks.md
  - docs/future-plans/dashboard-hero-load.md
---

## Decided
Holding the whole hero until the portfolio summary answered (the #2075 fix for "invested" popping in) made the hero arrive seconds after the widgets, because the summary starts only after the dashboard's first batch and is its slowest request. A figure that costs more now keeps a placeholder in its own place, and the hero draws once its headline figures are known.

The summary's cost is mostly a walk over every calendar day since the first investment, which only TWR, MWR and CAGR need. The dashboard now reads a valuation (the summary without those fields). The summary is built on the same memoized valuation, so the two cannot disagree and a page asking for both pays for one valuation. The dashboard's automatic price refresh waits for the valuation, as the Investments page's waits for its summary.

## Tried and ruled out
Nulling the return fields on a lighter summary: `null` on a return already means withheld with a stated reason, so a separate shape says "not worked out here" instead.

Folding the valuation into the dashboard's first request batch: `isLoading` gates every widget, so that would slow the whole page for one figure.

A separate returns endpoint: the portfolio hero can ask for the existing summary only when TWR, MWR or CAGR is chosen, which costs nothing new on the server.

## Watch out
The gain was worked out by reading the code and was not timed on a real portfolio or seen in a browser.

Two memo entries mean that if an invalidation message is lost, a summary built late in a valuation's life can outlast it by one TTL, so that bound is two TTLs.

`trail check` flags this work against the learning that rejected folding the summary into the first batch. It matches on words; that fold is still not done.

In the code: `getPortfolioValuation`, `buildPortfolioValuationMemoKey`, `GET /portfolio/valuation`, `HeroFigureSkeleton`, `HeroChartSkeleton`.
