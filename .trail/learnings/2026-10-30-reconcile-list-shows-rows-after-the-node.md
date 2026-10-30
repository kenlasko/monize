---
title: Reconcile list shows rows after the statement date; payee icon contrast options
author: Node
date: 2026-10-30
branch: claude/issue-1945
cost: { minutes: 5, tokens: 84952 }
touches:
  - backend/src/transactions/transaction-reconciliation.service.ts
  - backend/src/transactions/transactions.service.spec.ts
  - frontend/src/components/reconcile/reconcile-rows.ts
  - backend/src/transactions/transaction-reconciliation.service.spec.ts
  - frontend/src/components/ui/BrandLogo.tsx
---

## Decided
- getReconciliationData (backend/src/transactions/transaction-reconciliation.service.ts) lists every UNRECONCILED/CLEARED parent row, with no statement-date bound. The client pre-ticks only rows dated <= statement date (initialReconcileSelection / carryReconcileSelection), and the running difference is computed client-side from the ticked rows, so the frontend needed no change.
- The server's clearedBalance/difference still sum CLEARED rows only up to the statement date; the frontend does not read them.
- Payee/institution icons render through one component, frontend/src/components/ui/BrandLogo.tsx (a transparent img in a rounded chip, no backing). Contrast options offered to the maintainer: a client canvas sample with a theme-aware backing (recommended), server-side analysis with stored columns (needs a migration and a backend image library; backend has none), or always backing transparent icons.

## Tried and ruled out
- Adding a new test in transaction-reconciliation.service.spec.ts: its getReconciliationData mock shares one query builder across all three queries, so it cannot tell the listing query from the cleared-sum query. transactions.service.spec.ts already returns a separate qb per query; the old "filters transactions up to statement date" test there was inverted instead.

## Watch out
- trail check flags transactions.service.spec.ts as reviving a "list status filter" (an AccountList UI learning). That is a lexical false positive.
- Backend prettier --check on a frontend file reports style issues because the configs differ. Check frontend files with the frontend's own tooling.
