---
title: "Stage 3 (C1): chart rows keep the server's figures; the window's net worth change is a server field (#2412)"
author: Node
date: 2026-11-25
branch: claude/issue-2412
cost: { minutes: 28, tokens: 33440 }
touches:
  - frontend/src/components/dashboard/AssetsVsLiabilities.tsx
  - frontend/src/components/reports/MonthlySpendingTrendReport.test.tsx
  - frontend/src/components/reports/MonthlySpendingTrendReport.tsx
  - frontend/src/components/reports/YearOverYearReport.test.tsx
  - frontend/src/components/reports/YearOverYearReport.tsx
  - docs/frontend/financial-figures.md
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/specs/report-rounding-and-aggregation.md
  - docs/system-invariants.md
  - frontend/src/components/dashboard/AssetsVsLiabilities.test.tsx
---

## Decided
- The fix for "Math.round chart rows read by totals, tooltips, CSVs" was to stop rounding the rows at all, not to keep a rounded copy for the chart: the compact formatter already rounds what it prints, and one row shape means nothing else can read whole units.
- The window's net worth change is the server's netWorthChangeFromStart (each month less the series' first, FxAggregate.difference read once); the client reads it through netWorthWindowChange (lib/net-worth-change.ts), falling back to the readings' difference for an older backend, like heroMonthChange.
- Year over Year writes a month the response does not carry as null (no bar, the unknown marker, an empty CSV cell); the server always sends twelve months, so this is defensive.

## Tried and ruled out
- Keeping a whole-unit copy of each row for the chart beside the server's figure: two row shapes is how the totals came to read the wrong one, and the compact formatter already rounds.
- Summing the server's per-month netWorthChange for the window's change: a sum of rounded parts; a server field is the single rounding.

## Watch out
- TaggedBalanceTooltip hides a zero outflow on purpose; the bug was in the rows Income vs Expenses and Cash Flow hand it.
- The Balance view (periodBalanceFields, taggedBalanceWindow) still adds the two rounded sides plus flows rather than reading the server's net; it can read a cent off Net/Savings for the same period.
- TagKeyBreakdownBuckets, IncomeExpensesBarChart and the Monthly Comparison's net worth chart still round bars to whole units, but only the bars and a compact tooltip read them.
- To prove a test fails before, copy the HEAD version of the component over the file, run the test, and copy the new one back (no git stash: the stash is shared across worktrees).
