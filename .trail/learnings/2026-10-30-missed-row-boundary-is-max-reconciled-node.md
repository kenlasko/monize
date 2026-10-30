---
title: "Missed-row boundary is MAX(RECONCILED_THROUGH_SQL), capped at the statement"
author: Node
date: 2026-10-30
branch: claude/issue-1945
cost: { minutes: 8, tokens: 53170 }
touches:
  - backend/src/transactions/stale-reconciliation.ts
  - backend/src/transactions/transaction-reconciliation.service.spec.ts
  - backend/src/transactions/transaction-reconciliation.service.ts
  - backend/test/integration/transactions.integration.spec.ts
---

## Decided
- The stale classifier's lastReconciledDate (getStaleUnreconciled CTE and getReconciliationData) is MAX(RECONCILED_THROUGH_SQL) from backend/src/transactions/stale-reconciliation.ts: LEAST(transaction_date, COALESCE(reconciled_date, transaction_date)). It is needed because the reconcile screen lists, and can reconcile, rows dated after the statement date; the row's own date would push the "missed" boundary past the statement.
- It is still different from the accounts list's Last Reconciled (AccountsService.findAll, MAX(COALESCE(reconciled_date, transaction_date))). updateStatus to RECONCILED stamps reconciled_date with today, so using reconciled_date alone in the classifier would call everything before today missed. LEAST keeps those rows at their own date.

## Tried and ruled out
- Using MAX(reconciled_date) for the classifier: the register's status cycle stamps today's date.

## Watch out
- getStaleUnreconciled had no unit test before this; it now has one in transaction-reconciliation.service.spec.ts (managerQuery mock). The property itself is proven only by test/integration/transactions.integration.spec.ts ("stale reconciliation after a row dated past its statement"), which needs PostgreSQL and was not run locally.
- Integration fixtures for the overdue half are dated 2020 so they are past the 45-day window on any run date.
