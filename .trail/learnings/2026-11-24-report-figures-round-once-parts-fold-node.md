---
title: "Report figures round once: parts fold as FxAggregates, Sankey apportions, sign reads before rounding (#2384)"
author: Node
date: 2026-11-24
branch: claude/issue-2384
cost: { minutes: 132, tokens: 901523 }
touches:
  - backend/src/ai/forecast/forecast-aggregator.service.ts
  - backend/src/built-in-reports/monthly-category-breakdown.service.ts
  - backend/src/common/report-rounding.guard.spec.ts
  - backend/src/net-worth/net-worth.service.spec.ts
  - backend/src/net-worth/net-worth.service.ts
  - backend/src/securities/portfolio-calculation.service.spec.ts
  - backend/src/securities/portfolio-calculation.service.ts
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/specs/report-rounding-and-aggregation.md
  - docs/system-invariants.md
---

## Decided
- Rule 2 of docs/specs/report-rounding-and-aggregation.md: a part (cell, category, month, node) folds into the figure above it with FxAggregate.merge / mergeNegated / difference / sum, never as its knownSubtotal. backend/src/common/report-rounding.guard.spec.ts fails addConverted/add/sumMoney/+=/-=/+/- over a reading (sort comparators excepted) and isNetSpending over a reading or roundMoney.
- Direction decisions (isNetSpending, net > 0) read FxAggregate.sign, so a category netting 0.00003 keeps its row (shows 0.0000). sign is 0 under half a unit at 8 places or within (summed component magnitude >> 51), the float residue bound.
- The Cash Flow Sankey closes by apportioning (largest remainder, FxAggregate.apportionUnits, ties to the lower key) from each side's single rounding down to roots, children and accounts (cash-flow-sankey-figures.ts). #2360's round-once-on-read had made parents and children round apart and the report 500.
- Custom report rows carry their unrounded sums (backend/src/reports/report-rows.ts ReportRow); headline, mean, shares and budget variance come from them. convertDatedRows/convertRateParts round each figure once; *Aggregates variants hand the aggregates on.
- Client sumConverted accumulates at target places + 8 in BigInt, like FxAggregate.
- Left open for Ken (spec section 6): report figures leave the server at 4 places and the screen rounds again at the currency's places (2.50498 -> 2.5050 -> 2.51).

## Tried and ruled out
- A fixed 0.5e-8 sign threshold: 16,768.69 at 9731.4245182213 refunded as 4,012.32 + 12,756.37 nets -0.00000002 in doubles and read as money.
- Running prettier on frontend files: the frontend has no prettier config (lint-staged runs eslint only), so prettier rewrote single quotes to double across a test file.

## Watch out
- Two figures deliberately keep the sum of what they show: a tag bucket's window flows (I8 of report-tag-key-breakdown.md). Recorded residuals: Monthly Comparison changes (difference of two rounded figures), Budget Health's converted foreign income.
- AGENTS.md is ~11 bytes under its ceiling after this branch.
- Run backend test:changed with TZ=UTC; budget-alert and loan amortization specs fail in the worker's local zone.
- Many frontend surfaces still total rounded rows or Math.round chart values (stage 3 of docs/future-plans/report-rounding-and-aggregation-tasks.md).
