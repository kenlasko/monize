---
title: ChartLegend compact mode for 2-item donut legends
author: Node
date: 2026-10-31
branch: claude/issue-1972
cost: { minutes: 14, tokens: 155539 }
touches:
  - frontend/src/components/dashboard/AssetsVsLiabilities.tsx
  - frontend/src/components/dashboard/DonutCalloutChart.tsx
  - frontend/src/components/ui/ChartLegend.tsx
---

## Decided
Added an opt-in `compact` prop to ChartLegend (frontend/src/components/ui/ChartLegend.tsx),
forwarded through DonutCalloutChart as `legendCompact`. Compact mode renders the `ul` as
`flex flex-wrap justify-center` instead of a CSS grid, and drops `flex-1`/`ml-auto` from the
name/trailing spans so each row hugs its own content and the group centers, instead of every
row stretching to the full grid-column width with the value pushed to the far edge.

Wired up only for AssetsVsLiabilities (frontend/src/components/dashboard/AssetsVsLiabilities.tsx),
which only ever has 2 slices (Assets, Liabilities). Other ChartLegend/DonutCalloutChart
consumers (ExpensesPieChart, RecurringExpensesWidget, CashFlowSankeyReport,
IncomeBySourceReport, SpendingByCategoryReport) are category lists where aligned
trailing-figure columns are the right look, so they keep the default (non-compact) grid.

## Tried and ruled out
- Overriding `legendColumnsClassName` with arbitrary Tailwind classes (e.g.
  `grid-cols-[repeat(2,max-content)]`) from the caller: relies on undefined class-ordering
  behaviour to override the default `sm:grid-cols-2`, fragile and not idiomatic.
- Hand-rolling a bespoke legend inside AssetsVsLiabilities instead of extending the shared
  primitive: duplicates markup the codebase already has one canonical version of.

## Watch out
- Verified visually (not just via unit tests) by writing a static Tailwind-CDN HTML repro of
  the exact class strings and screenshotting it with a throwaway `mcr.microsoft.com/playwright`
  Docker container (no frontend node_modules/e2e Playwright browsers were installed in this
  worktree) -- confirms the "before" grid+ml-auto markup reproduces the regression screenshot
  (name far left, value far right) and the new compact markup reproduces the pre-regression
  look (name and value grouped together, centered).
- This worktree had no `node_modules` installed anywhere (frontend, e2e); needed
  `npm ci --prefer-offline` in frontend/ before any lint/test/type-check would run. The global
  npm cache at ~/.npm had the packages already so `npm ci` was fast (~27s, no real network
  dependency fetch).
