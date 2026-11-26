---
title: "Provisional count on built-in reports that read transfer legs, and budget transfer actuals (issue 2396, B8)"
author: Node
date: 2026-11-26
branch: claude/issue-2396
cost: { minutes: 36, tokens: 312267 }
touches:
  - backend/test/integration/currency-detail.integration.spec.ts
  - backend/test/integration/report-transfer-fx-surfaces.integration.spec.ts
  - docs/future-plans/provisional-amounts.md
  - backend/src/budgets/budget-activity-reports.service.spec.ts
  - backend/src/budgets/budget-alert.service.spec.ts
  - backend/src/budgets/budget-health-reports.service.spec.ts
  - backend/src/budgets/budget-reports.service.spec.ts
  - backend/src/budgets/budget-spending.util.spec.ts
  - backend/src/budgets/budget-spending.util.ts
  - backend/src/budgets/budget-trend-reports.service.spec.ts
---

## Decided
- In scope = the reads that use `ownTransferLegs`/`transferLegs` (grep them): Sankey whole-transfer query, Monthly Category Breakdown transfer rows, Income vs Expenses tagged flows (wholeFlowQuery), account-breakdown-fx.ts (payee + category panels), budget-spending.util.ts transfer reads (outgoing AND incoming/transfer-income), currency-detail getUsageSummary. Every other built-in report has `t.is_transfer = false`.
- Counts are SQL over whole rows (`amount_is_provisional = true`); split transfer lines are never provisional. Only converted groups count (design section 8).
- Sankey counts per half (`provisional_inflow_count` / `provisional_outflow_count`), since one row carries both signs. Breakdown: response-level. Income vs Expenses: per tag bucket only; the top-level All figures exclude transfers and I1 forbids new top-level fields without tagKey. Panels: per row. Budget: ids (`ARRAY_AGG(DISTINCT t.id::text) FILTER ...`) so an outgoing line and an income line naming one account count a shared leg once; carried to `CategoryActualRow.provisionalCount` and getSummary's `provisionalCount`.

## Tried and ruled out
- Response-level count on IncomeVsExpensesResponse: it would always be 0 and changes the no-tagKey shape (I1 test asserts no new properties).

## Watch out
- Adding a field to `CategorySpending` breaks six hand-built fixtures in budgets/*.spec.ts (tsc --noEmit covers src specs).
- currency-detail.integration.spec.ts does a toEqual on the whole usage summary.
- Integration DB: `docker run -p 55496:5432 -e POSTGRES_USER=monize_user -e POSTGRES_PASSWORD=monize_password mirror.gcr.io/library/postgres:18-alpine`, then `DATABASE_PORT=55496 npm run test:integration -- <pattern>`; node_modules is not installed in a fresh worktree (`npm ci`).
