---
title: "Issue #2072: VOID mirror/cash leg asked the reconciled lock"
author: Node
date: 2026-11-10
branch: claude/issue-2072
cost: { minutes: 20, tokens: 117471 }
touches:
  - backend/src/securities/investment-transactions.service.spec.ts
  - backend/src/securities/investment-transactions.service.ts
  - backend/src/transactions/transaction-reconciliation.service.spec.ts
  - backend/src/transactions/transaction-reconciliation.service.ts
  - backend/src/transactions/transactions.service.ts
  - backend/src/transactions/void-status-transition.util.spec.ts
  - backend/src/transactions/void-status-transition.util.ts
  - backend/test/integration/reconciled-mirror-leg-void.integration.spec.ts
  - docs/system-invariants.md
---

## Decided
- `assertMirrorLegVoidTransitionMutable` (`backend/src/transactions/void-status-transition.util.ts`) locks the transfer counterpart / investment cash leg and calls `assertReconciledRowsMutable` (no undo window) before the first write, in `TransactionReconciliationService.applyStatusTransition`, `TransactionsService.update` (only when the named row's own status crosses VOID) and `InvestmentTransactionsService.updateStatus` (per leg's `transactionId`, before `beginBondWriteGuard`).
- `applyVoidTransitionToMirrorLeg` asks it again before writing the leg, as a backstop for any future caller.

## Tried and ruled out
- Only asserting inside `applyVoidTransitionToMirrorLeg`: every caller has already written its own row by then, so the refusal relies on rollback and breaks "a rejected command must not already have written" (unit tests asserting no `update` fail).

## Watch out
- In `TransactionsService.update`, gate the pre-check on the named row crossing VOID, not the counterpart: a divergent pair (row VOID, mirror RECONCILED) resending VOID would otherwise be refused though nothing crosses.
- Integration proof: `backend/test/integration/reconciled-mirror-leg-void.integration.spec.ts` fails 2/3 on the unfixed code.
