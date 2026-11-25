---
title: "Stage 3 (C1): chart rows keep the server's figures; the window's net worth change is a server field (#2412)"
author: Node
date: 2026-11-25
branch: claude/issue-2412
touches:
  - backend/src/net-worth/net-worth.service.ts
  - frontend/src/lib/net-worth-change.ts
  - frontend/src/components/reports/MonthlySpendingTrendReport.tsx
  - frontend/src/components/reports/IncomeVsExpensesReport.tsx
  - frontend/src/components/reports/CashFlowReport.tsx
  - frontend/src/components/reports/NetWorthReport.tsx
  - frontend/src/components/reports/YearOverYearReport.tsx
  - frontend/src/components/dashboard/NetWorthChart.tsx
  - frontend/src/components/dashboard/AssetsVsLiabilities.tsx
  - frontend/src/lib/tagged-balance.ts
  - docs/frontend/financial-figures.md
---

## Decided
- The fix for "Math.round chart rows read by totals, tooltips, CSVs" was to stop rounding the rows at all, not to keep a rounded copy for the chart: the compact formatter already rounds what it prints, and one row shape means nothing else can read whole units.
- The window's net worth change is the server's netWorthChangeFromStart (each month less the series' first, FxAggregate.difference read once); the client reads it through netWorthWindowChange (lib/net-worth-change.ts), falling back to the readings' difference for an older backend, like heroMonthChange.
- Year over Year writes a month the response does not carry as null (no bar, the unknown marker, an empty CSV cell); the server always sends twelve months, so this is defensive.

## Watch out
- TaggedBalanceTooltip hides a zero outflow on purpose; the bug was in the rows Income vs Expenses and Cash Flow hand it.
- The Balance view (periodBalanceFields, taggedBalanceWindow) still adds the two rounded sides plus flows rather than reading the server's net; it can read a cent off Net/Savings for the same period.
- TagKeyBreakdownBuckets, IncomeExpensesBarChart and the Monthly Comparison's net worth chart still round bars to whole units, but only the bars and a compact tooltip read them.
- To prove a test fails before, copy the HEAD version of the component over the file, run the test, and copy the new one back (no git stash: the stash is shared across worktrees).
