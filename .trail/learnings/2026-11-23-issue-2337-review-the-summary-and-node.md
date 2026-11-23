---
title: "Issue #2337 review: the summary and grouped totals keep a split's transfer line too"
author: Node
date: 2026-11-23
branch: claude/issue-2337
cost: { minutes: 9, tokens: 66396 }
touches:
  - backend/src/built-in-reports/rate-basis-parts.spec.ts
  - backend/src/built-in-reports/rate-basis-parts.ts
  - backend/src/transactions/transaction-analytics.service.spec.ts
  - backend/src/transactions/transaction-analytics.service.ts
  - backend/test/integration/report-transfer-fx-surfaces.integration.spec.ts
  - docs/system-invariants.md
---

## Decided
- Supersedes the "summary left as a follow-up" note in the earlier #2337 learning: every TransactionAnalyticsService read over `createFilteredAnalyticsQuery` (summary, grouped totals, tag breakdown, monthly, flow totals) keeps a split's transfer line exactly when it keeps whole transfer rows. The rule is derived from `excludeTransfers` inside the builder; there is no separate `includeTransferSplits` flag any more.
- `TRANSACTION_RATE_BASIS` carries `transferLegs: { transactionAlias: "transaction", splitAlias: "splits", wholeLegs: true }`.
- Counts: `WHOLE_ROW_COUNT_SQL` + `SPLIT_IDS_SQL` per part, folded by `foldRateParts(..., { splitIds })`, which adds each group's distinct split ids once.
- Grouped-by-category keeps a transfer line out of "Uncategorized" (`transaction.isTransfer = false AND splits.transferAccountId IS NULL`).

## Watch out
- The MCP resources spread `getSummary` and `getLlmFlowTotals` into one payload, and the payee page shows summary cards beside the monthly chart: change one of these reads and the other has to follow in the same commit.
- A parent-level tag pulls the transfer line into a tag-filtered read, while the counterpart row (untagged) stays out; that matches what the register lists.
