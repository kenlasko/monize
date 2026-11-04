---
title: "Monthly Breakdown: standalone categories, folding groups, Summary only (issue 2012)"
author: Node
date: 2026-11-04
branch: claude/issue-2012
cost: { minutes: 22, tokens: 178268 }
touches:
  - frontend/src/components/reports/MonthlyCategoryBreakdownReport.funds.test.tsx
  - frontend/src/components/reports/MonthlyCategoryBreakdownReport.layout.test.tsx
  - frontend/src/components/reports/MonthlyCategoryBreakdownReport.test.tsx
  - frontend/src/components/reports/MonthlyCategoryBreakdownReport.tsx
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/en/reports.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/reports.json
  - frontend/src/i18n/messages/id/reports.json
---

## Decided
- Grouping in MonthlyCategoryBreakdownReport's model: a row with parentId+parentName joins the parent's section; any other categorized row keys a section by its OWN categoryId; only the uncategorized row (categoryId null) goes to the "Other income/expenses" bucket. A section is `isStandalone` when its single row is the category it is keyed by (`g.list.length === 1 && g.list[0].categoryId === g.key`): rendered as one line (no header, no subtotal), sorted among parent sections, takes no palette slot, empty CSV parent column. A parent's own direct spending therefore sits inside its section beside its subcategories (it used to land in "Other expenses").
- "Standalone" is decided from the report data, not the category tree: a parent whose subcategories have no activity in range also draws as one line. No backend change.
- Folding: Income/Expenses/Transfers group headers are `aria-expanded` disclosure buttons; folded groups persist as a GroupId[] under `monize-reports-monthly-category-breakdown-collapsed-groups` (a non-array stored value folds nothing). "Summary only" switch persists under `...-summary-only` and hides the three groups, keeping the Summary block, recap and MonthlyTaggedBalanceSummary.
## Watch out
- A standalone category's name now appears twice (detail line + Summary recap), so `getByText('<name>')` in tests throws; funds.test fixture gives Groceries a parent for that reason.
- The Summary recap's "Transfers" row is also a button named "Transfers": select the group header with `getByRole('button', { name: 'Transfers', expanded: true })`.
- Pre-existing, not fixed: a parent's own row drills into `categoryIds=<parent>`, which the transactions list expands to include subcategories, so the list total exceeds the row.
- Docs screenshot retake was blocked here: rootless Docker port publishing failed (RootlessKit api.sock missing) and the e2e backend's `nest build` needs NODE_OPTIONS=--max-old-space-size=3584 in the override.
