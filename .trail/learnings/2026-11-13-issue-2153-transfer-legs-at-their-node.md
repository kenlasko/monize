---
title: "Issue #2153: transfer legs at their posted amounts in every SQL read"
author: Node
date: 2026-11-13
branch: claude/issue-2153
cost: { minutes: 76, tokens: 353776 }
touches:
  - backend/src/built-in-reports/cash-flow-sankey.service.spec.ts
  - backend/src/transactions/transaction-analytics.service.ts
  - backend/src/budgets/budget-spending.util.ts
  - backend/src/built-in-reports/cash-flow-sankey.service.ts
  - backend/src/built-in-reports/income-reports.service.ts
  - backend/src/built-in-reports/monthly-category-breakdown.service.ts
  - backend/src/built-in-reports/rate-basis-parts.spec.ts
  - backend/src/built-in-reports/rate-basis-parts.ts
  - backend/src/built-in-reports/report-currency.service.spec.ts
  - backend/src/built-in-reports/report-currency.service.ts
---

## Decided
- `built-in-reports/transfer-rate-sql.ts` `transferRateSql` is the SQL form of `reports/transfer-counterpart.ts`: a correlated subquery by id selects |leg| / |counterpart| as the leg's own rate when the other side posted in the reporting currency. It wins over a stored rate, and a ratio of 1 is real (`toOwnRate` accepts it; `ownRateSql`'s stored-1 rule does not apply).
- Opt-in per read: raw SQL via `ownRateSql` / `rateBasisColumnsSql(param, "t", ownTransferLegs(userId, "$1", splitAlias?))`; query builders via `splitByRateBasis` columns `transferLegs: { transactionAlias, splitAlias? }`, which adds `fx_transfer_rate`, read by `partRateBasis` / `convertRateParts` / `convertDatedRows` through `transactionRateBasis({ transferRate })`.
- Covered: Sankey transfer flows, Monthly Category Breakdown transfer rows, Income vs Expenses tagged flows, TransactionAnalyticsService summary/grouped/tag/monthly/flow totals, payee and category detail account panels, budget outgoing-transfer actuals.
- Only the reader's own legs read the counterpart (`transferRateReader` = realUserId ?? userId). A delegate (RLS runs as the owner, so the DB cannot hide the counterpart account) or a joint grantee keeps the market rate. Second review flagged that owner and delegate then see different figures; kept as the privacy-first choice.
- Exactly one other side must answer (`COUNT(*) = 1`), not `LIMIT 1`.

## Tried and ruled out
- `fx_leg.user_id = t.user_id` alone: a delegate's summary would derive a figure from an ungranted account.
- Gating on `current_setting('app.real_user_id')`: the GUCs are only set when RLS mode is not `off`.

## Watch out
- Unit specs have no request context, so `transferRateReader()` is undefined and the transfer column is not emitted; wrap in `requestContextStorage.run({ userId })` to test the SQL shape. Only the PostgreSQL integration spec (`report-transfer-fx-surfaces`) proves the GROUP BY over a correlated subquery works.
- Postgres 16 runs fine via `docker run mirror.gcr.io/library/postgres:16`; call jest with `--config ./test/jest-integration.json --testPathPatterns=...`.
- A budget transfer with no market rate is now known when its other side posted in the budget currency; `budget-multi-currency-actuals` keeps its missing-rate case on a one-sided link.
