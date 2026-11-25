---
title: "Stage 3 (C3): investment page totals fold exact sums; the accumulator keeps 15 significant digits (#2414)"
author: Node
date: 2026-11-25
branch: claude/issue-2414
cost: { minutes: 46, tokens: 562239 }
touches:
  - docs/frontend/financial-figures.md
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/specs/report-rounding-and-aggregation.md
  - docs/system-invariants.md
  - backend/src/reports/reports.service.spec.ts
  - backend/src/built-in-reports/income-reports.service.spec.ts
  - backend/src/common/fx-aggregate.spec.ts
  - backend/src/common/fx-aggregate.ts
  - frontend/src/lib/currency-total.test.ts
  - frontend/src/lib/currency-total.ts
---

## Decided
- The investment reports' totals (Realized Gains, Dividend Income, Dividend Yield Growth, Security Type Allocation, Currency Exposure, geographic allocation) are page totals: they group rows the server sends one by one by a key only the page picks, and Realized Gains' response is a bare array, so there was no additive field to add. They use frontend/src/lib/page-total.ts: pageSum / foldPageSums give exact sums read once at the display currency's places, pageRatio divides shares, yields and growth from exact sums, pageSumSign reads a direction.
- aggregateHoldingsBySecurity adds accounts with sumMoney at moneyDecimalsForCurrency. Security Performance's dividend footer was already exact.
- Portfolio Value by-security: the tooltip reads payload[0].payload.total. A band absent from a point with complete === false is unknown: the table shows UnknownAmount and the CSV writes N/A. Absent from a complete point means a known zero.
- Ken's two added cases. Income by Source sends IncomeSourceItem.percentage, divided from unrounded aggregates. FxAggregate.toAccumulationUnits and the client's accumulationUnits in currency-total.ts hold each component at max(12, 14 - floor(log10|x|)) places, capped at 20, with the accumulator at MONEY_SCALE + 12 = 20. Components of 100 or more are held as before.

## Tried and ruled out
- Exact decimal products (amount and rate passed separately to FxAggregate): this needs every converter call site changed (about 20 on the backend plus the client), and an own-rate conversion divides, so it still would not be exact.
- Wider fixed places (16): already ruled out, because it keeps float noise and a share read 25.000000000000007. Fifteen significant digits (DBL_DIG) drops that noise.

## Watch out
- Three task-list lines are still open, so the plan pair was not retired and INV-REPORT-005 stays partial: stage 2's "left at four places", dashboard-hero-figures' percentage, and the client's account totals (GroupedHoldingsList, portfolio-headline, accounts page, PortfolioSummaryCard).
- The PortfolioValueReport test's recharts Tooltip mock only renders a function `content`. mockTooltipPayload now clones an element tooltip when a test sets it.
- After touching currency-total.ts, frontend test:changed runs about 990 files (about 17 min).
