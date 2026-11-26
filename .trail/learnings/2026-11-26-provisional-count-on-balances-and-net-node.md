---
title: "Provisional count on balances and net worth (issue 2394, B6)"
author: Node
date: 2026-11-26
branch: claude/issue-2394
cost: { minutes: 36, tokens: 331791 }
touches:
  - backend/src/accounts/account-balances-report.service.spec.ts
  - backend/src/accounts/accounts.service.spec.ts
  - backend/src/accounts/daily-balance-totals.service.spec.ts
  - backend/src/common/ledger-balance-sql.spec.ts
  - backend/src/common/ledger-balance.sql.ts
  - backend/src/common/provisional-count.util.spec.ts
  - backend/src/common/provisional-count.util.ts
  - backend/src/delegation/joint-accounts.service.spec.ts
  - backend/src/delegation/joint-accounts.service.ts
  - backend/src/net-worth/net-worth-rows.ts
---

## Decided
- One shared read: `loadProvisionalCounts` (backend/src/common/provisional-count.util.ts) over `PROVISIONAL_COUNTS_AS_OF_DATES_SQL` / `ledgerProvisionalPredicate` in common/ledger-balance.sql.ts (ledger movement predicate + `amount_is_provisional`, bounded at each as-of date). `ledger-balance-sql.spec.ts` fails a file under accounts/, delegation/, net-worth/ or scheduled-transactions/ that names the column.
- Account list (owned rows in `findAll` AND joint rows in `JointAccountsService.jointAccountsFor`) counts rows inside `currentBalance` (<= today); a future-dated leg is in `futureTransactionsSum` and counted nowhere, per the issue's acceptance, even though the list shows current + future.
- Net worth months count as of month end with `notAfterDatabaseToday` (SQL CURRENT_DATE), because `recalculateRegularAccount` bounds the snapshot at CURRENT_DATE, not the request timezone. Only accounts whose ledger balance is in the month's figure and whose balance converted count; ASSET months before date_acquired count 0.
- `NetWorthTotals` and months carry `provisionalCount`, `assetsProvisionalCount`, `liabilitiesProvisionalCount`; summary adds `totalBalanceProvisionalCount`; LLM history keeps only `provisionalCount`.

## Tried and ruled out
- Declaring `provisionalCount` in `listAccountsOutput`: +61 bytes, list_accounts and the tools/list total are at their shrink-only budget (6 bytes spare). Left undeclared on the loose object.
- Bounding the running net worth month at `todayYMD()`: disagrees with the snapshot near midnight for non-UTC users.

## Watch out
- Unit specs that chain `mockResolvedValueOnce` on `manager.query` (net-worth spec) are shifted by a new query; route the count read by `isProvisionalCountQuery(sql)` with `provisionalCountRows` from src/test-helpers/provisional-count-testing.ts instead.
- Integration DB: `docker run mirror.gcr.io/library/postgres:18-alpine` with POSTGRES_USER=monize_user POSTGRES_PASSWORD=monize_password, then `DATABASE_PORT=<port> npm run test:integration -- <pattern>`.
