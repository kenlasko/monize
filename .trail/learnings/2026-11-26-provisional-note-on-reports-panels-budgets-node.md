---
title: "Provisional note and mark on reports, panels and budgets (F3, #2399)"
author: Node
date: 2026-11-26
branch: claude/issue-2399
cost: { minutes: 45, tokens: 250000 }
touches:
  - frontend/src/components/reports/CustomReportViewer.tsx
  - frontend/src/components/transactions/widget-shared.ts
  - frontend/src/components/accounts/shared/TopGroupsPanel.tsx
  - frontend/src/components/reports/TagKeyBreakdownBuckets.tsx
  - frontend/src/components/budgets/BudgetDashboard.tsx
  - frontend/src/components/currencies/detail/CurrencySummaryCards.tsx
  - docs/future-plans/provisional-amounts.md
---

## Decided
- One count for one figure gets `ProvisionalMark` (or `PartialTotal provisionalCount`); one count over several figures (Sankey, Monthly Category Breakdown, tag bucket flows, budget summary) gets `ProvisionalDataNotice`. The backend never says which figure holds the leg there.
- `summarizeInDisplayCurrency` returns `provisionalCount`: native `summary.provisionalCount`, or `converted.provisionalCount` on a converted summary (only converted currencies).

## Watch out
- `ProvisionalMark` renders an `InfoTooltip`, whose trigger is a `<button>`. Never place it inside a clickable row's `<button>` (TopGroupsPanel rows, BudgetCategoryRow): put it beside the button.
- `widget-shared.test.ts` uses `toEqual` on the summarize result; a new returned field breaks those.
- `npm run type-check` OOMs at the default heap here; `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit`.
