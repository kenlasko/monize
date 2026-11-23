---
title: "Issue #2344: reports honour a transaction foreign entry recorded at 1:1"
author: Node
date: 2026-11-23
branch: claude/issue-2344
cost: { minutes: 28, tokens: 165973 }
touches:
  - backend/src/ai/forecast/forecast-aggregator.service.spec.ts
  - backend/src/built-in-reports/rate-basis-parts.spec.ts
  - backend/src/built-in-reports/report-currency.service.spec.ts
  - backend/src/built-in-reports/report-currency.service.ts
  - backend/src/currencies/currency-detail.service.ts
  - backend/src/transactions/transaction-analytics.service.spec.ts
  - backend/src/transactions/transactions.service.spec.ts
  - backend/src/transactions/transactions.service.ts
  - backend/test/integration/fx-own-rate-surfaces.integration.spec.ts
  - docs/financial-semantics.md
---

## Decided
- The transaction own-rate rule (`ownRateSql` / `transactionRateBasis` in backend/src/built-in-reports/report-currency.service.ts) no longer drops a stored 1. `normalizeFxEntry` has always required a positive rate on a foreign entry, so a 1 beside `original_currency_code` is a recorded rate. The column default 1 only sits on rows with no original currency, and those never reach the own-rate branch.
- Every report, register, analytics/MCP, budget, forecast and insights read goes through those two functions (splitByRateBasis -> partRateBasis -> transactionRateBasis). The only other copy was `direct_rate` in currencies/currency-detail.service.ts.
- Closed the one write hole: `update()` used to inherit the plain row's default 1 when an edit added a foreign entry without a rate. It now passes `undefined`, so `fxRateRequired` refuses it.
- Investment rows (`usableRowRate`, position-basis-replay) still ignore a stored 1: many investment write paths store 1 by default.

## Tried and ruled out
- A read-side check that the amounts are consistent with 1:1. The fee folds into `amount` and `fxFeePercent` can be up to 100, so the check needs the account's fee threaded into about ten query shapes. Left as a documented residual instead.
- A schema flag column: too big for the issue; it needs agreement.

## Watch out
- Legacy rows that got the default 1 through the old update hole now read at 1:1. Nothing repairs them; a migration or heuristic would need maintainer agreement.
- Integration specs run against a throwaway postgres: `docker run -p 55432:5432 -e POSTGRES_USER=monize_user -e POSTGRES_PASSWORD=monize_password -e POSTGRES_DB=monize_test mirror.gcr.io/library/postgres:18-alpine`, then `DATABASE_PORT=55432 TZ=UTC npx jest --config ./test/jest-integration.json --runInBand <file>`.
- budget-alert.service.spec.ts fails unless TZ=UTC; run test:changed with TZ=UTC.
- The worktree had no node_modules; run `npm ci` in backend/ first.
