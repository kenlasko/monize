---
title: "Bucket budget build: what stayed open and what bit us when several agents shared one worktree"
author: Ken
date: 2026-11-15
branch: feat/bucket-budget
cost: { minutes: 26, tokens: 394185 }
id: l-b33cbae8
scope: repo
status: active
src: agent
touches:
  - e2e/helpers/factories.ts
  - frontend/src/lib/docs-links.ts
  - website/docs/budgets.html
  - website/docs/budgets.md
  - website/docs/search-index.json
  - frontend/src/components/budgets/BudgetWizard.test.tsx
  - frontend/src/components/budgets/BudgetWizard.tsx
  - frontend/src/components/budgets/BudgetWizardAnalysis.test.tsx
  - frontend/src/components/budgets/BudgetWizardBuckets.tsx
  - frontend/src/components/budgets/BudgetWizardCategories.test.tsx
---

## Decided
- A line whose bucket is not one of its own budget's is counted as Unassigned by the figures function, so a bad link can never put spending in the wrong bucket.
- The dashboard's bucket status is fetched by the budget page, not the card, so it reloads with undo/redo and assistant actions; a failed request shows its own error and is never turned into empty data.
- The wizard keeps each line's bucket when the analysis is re-run under the Bucket strategy.

## Tried and ruled out
- Reusing the period-category rows alone for a bucket's frozen spend at the close: a line added mid-period has no such row, so the snapshot would differ from what the dashboard card showed. The close uses the budget's current lines with the close's own actuals.
- ON CONFLICT on (period, bucket) for the snapshot write: NULL bucket ids (deleted buckets) are distinct in that key. The close reads the period's rows under the period lock and updates by id or inserts.

## Watch out
- INV-BUDGET-002 is still partial: the backup restore only checks that a line's bucket exists in the same file, not that it belongs to the line's budget.
- The wizard apply (also on main) never checks who owns a transfer line's account id.
- A layer-wide `npm run lint` rewrites an unrelated auth guard spec and other agents' files; agents sharing a worktree lint only their own files.
- Two agents adding keys to the same English catalog must each use their own top-level object and regenerate the pseudo-locale last.
- In the wizard, clearing the bucket list and re-running the analysis brings the Three Buckets preset back.

In the code:
- backend/src/budgets/budget-bucket-figures.util.ts, budget-period.service.ts (freezePeriodBuckets), backend/src/backup/restore-references.ts, backend/src/budgets/budget-generator.service.ts, frontend/src/components/budgets/BudgetWizard.tsx, backend/src/auth/guards/pat-access.guard.spec.ts
