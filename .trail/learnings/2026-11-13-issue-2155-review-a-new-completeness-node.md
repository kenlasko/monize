---
title: "Issue #2155 review: a new completeness flag needs its client reader in the same PR"
author: Node
date: 2026-11-13
branch: claude/issue-2155
cost: { minutes: 11, tokens: 87936 }
touches:
  - docs/system-invariants.md
  - frontend/src/components/budgets/BudgetCategoryTrend.test.tsx
  - frontend/src/components/budgets/BudgetCategoryTrend.tsx
  - frontend/src/components/budgets/BudgetTrendChart.test.tsx
  - frontend/src/components/budgets/BudgetTrendChart.tsx
  - frontend/src/components/budgets/PartialTrendFigure.tsx
  - frontend/src/components/reports/BudgetVsActualReport.test.tsx
  - frontend/src/components/reports/BudgetVsActualReport.tsx
  - frontend/src/components/reports/CategoryPerformanceReport.test.tsx
  - frontend/src/components/reports/CategoryPerformanceReport.tsx
---

## Decided
- Budget trend points carry valuationComplete plus missingRatePairs; the client reads them through frontend/src/lib/budget-trend-completeness.ts (trendPartialPairs, === false only) and components/budgets/PartialTrendFigure.tsx (PartialTotal marker on a table figure, BudgetTrendPartialNote under a chart, tooltip "*"). PDF exports append reports.partialData.pdfSuffix.
- Reused existing keys (reports.partialData.weightingNoRate, pdfSuffix, common.partialTotal.srSuffix) so no new strings needed translating; PartialTotal's `explanation` override lets a figure without counts use it.
- Health history leaves an open period's category with an unrated row out of the score.
- Recurring-charge ARRAY_AGGs order by date then id so parallel arrays cannot swap rates on a same-day tie.

## Tried and ruled out
- Shipping the backend flag alone: AGENTS.md wants the flag read where the number is shown, and a reviewer caught it.

## Watch out
- A partial figure with no pair to name needs wording that does not invent a count; partialTotal.explanation* keys pluralise on a count the trend does not have.
