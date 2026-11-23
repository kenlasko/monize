---
title: "Issue #2337: a split's transfer line in monthly and MCP flow totals"
author: Node
date: 2026-11-23
branch: claude/issue-2337
cost: { minutes: 32, tokens: 191138 }
touches:
  - backend/src/transactions/transaction-analytics.service.spec.ts
  - backend/src/transactions/transaction-analytics.service.ts
  - backend/test/integration/report-transfer-fx-surfaces.integration.spec.ts
  - docs/system-invariants.md
  - backend/src/built-in-reports/rate-basis-parts.ts
  - backend/src/built-in-reports/transfer-rate-sql.spec.ts
  - backend/src/built-in-reports/transfer-rate-sql.ts
---

## Decided
- `createFilteredAnalyticsQuery` takes `includeTransferSplits`: `getMonthlyTotals` always, `getConvertedFlowTotals` when `excludeTransfers` is false. Summary and grouped totals still drop the lines (grouped-by-category would put a transfer line in "Uncategorized").
- A read of whole rows LEFT JOINed to their lines prices transfers through `transferRateSql(..., { splitAlias, wholeLegs: true })`: a COALESCE of the line shape and the whole-leg shape, which are exclusive (a line sits on a split parent; the whole-leg shape needs `is_split IS NOT TRUE`).
- The yardstick for the monthly chart is "adds up to the register list it sits on". Under the account filter that means both sides of a split transfer; under the `transfer` pseudo-category it means whole transfer rows only, because the register does not list the split parent there.

## Tried and ruled out
- Matching `splits.transferAccountId IS NOT NULL` under the `transfer` category in analytics only: the chart then disagreed with the register list. Changing what "Transfer" matches must happen on every filter surface at once (register list, bulk update, balance windows, `is:transfer` search).
- A correlated EXISTS per row to tell splits with transfer lines apart for the count: runs twice per joined row, each through transaction_splits' RLS policy.

## Watch out
- Once one transaction's lines carry different `fx_transfer_rate` values, they land in different rate parts and a per-part `COUNT(DISTINCT transaction.id)` double-counts. The monthly count now counts non-split rows per part and `ARRAY_AGG` of split ids across the month.
- The transaction summary (`getSummary`) still counts a split transfer's incoming row but not its outgoing line; that was left as a follow-up.
