---
title: "Account delete refuses an account any schedule names (#2028)"
author: Node
date: 2026-11-06
branch: claude/issue-2028
cost: { minutes: 21, tokens: 162529 }
touches:
  - backend/src/accounts/account-schedule-references.spec.ts
  - backend/src/accounts/account-schedule-references.ts
  - backend/src/accounts/accounts.controller.ts
  - backend/src/accounts/accounts.service.spec.ts
  - backend/src/accounts/accounts.service.ts
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
---

## Decided
`AccountsService.assertAccountEmpty`, the list's `canDelete` and `GET /accounts/:id/can-delete` all count schedules through `countSchedulesReferencingAccounts` (`backend/src/accounts/account-schedule-references.ts`). A schedule counts if it is paid from the account, transfers into it, funds an investment from it, or has a split line that transfers into it. A LOAN/MORTGAGE account's own `scheduled_transaction_id` is left out, because the delete removes that schedule on purpose. The delete refuses with a 400 (`errors.accounts.deleteWithScheduledTransactions`) and does not warn and cascade.

## Tried and ruled out
Running the real loan delete in an integration spec: the integration schema is built from the entities (`synchronize: true`), and there `accounts.scheduled_transaction_id` and `scheduled_transactions.transfer_account_id` are NO ACTION, not schema.sql's ON DELETE SET NULL. So `ScheduledTransactionsService.remove` of a loan's payment schedule fails there, and the account remove fails on the FK. The spec asserts the loan exclusion through `getTransactionCount` instead.

## Watch out
`investment_funding_account_id` has no ON DELETE action, so before this change, deleting a funding account failed with a raw FK error.
This machine's TZ is America/Toronto: `loan-payment-frequency.guard.spec.ts` fails under `test:changed` locally and passes with `TZ=UTC`, as CI runs it.
Docker works on this worker: `docker run -p 55432:5432 mirror.gcr.io/library/postgres:16` with `DATABASE_PORT=55432 DATABASE_USER=monize_test DATABASE_PASSWORD=test_password` runs one integration spec via `npx jest --config ./test/jest-integration.json --runInBand <path>`.
