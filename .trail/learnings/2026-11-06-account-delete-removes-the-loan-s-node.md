---
title: "Account delete removes the loan's own schedule inside its transaction"
author: Node
date: 2026-11-06
branch: claude/issue-2028
cost: { minutes: 18, tokens: 302976 }
touches:
  - backend/src/accounts/account-schedule-references.spec.ts
  - backend/src/accounts/account-schedule-references.ts
  - backend/src/accounts/accounts.service.spec.ts
  - backend/src/accounts/accounts.service.ts
  - backend/src/scheduled-transactions/scheduled-transaction-override.service.spec.ts
  - backend/src/scheduled-transactions/scheduled-transaction-override.service.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.ts
  - backend/test/integration/account-delete-schedules.integration.spec.ts
  - docs/system-invariants.md
  - docs/verification-contract.md
---

## Decided
`AccountsService.delete` is one `withScopedDb` transaction: `lockAccountsForBalanceWrite`, `assertAccountEmpty`, clear `accounts.scheduled_transaction_id`, `ScheduledTransactionsService.removeWithoutHistory` (the nested `withScopedDb` joins the transaction), then remove the account. `recordRemoved` and the account's history entry are written after the commit, mirroring `createWithoutHistory` / `recordCreated`. A refused delete has written nothing, and a failure to remove the schedule (other than NotFound) aborts the delete instead of logging and continuing. The unlocked pre-check before the transaction is gone.
Override writes (`createOverride` / `updateOverride`) call `lockOverrideTransferAccounts`: a `FOR SHARE` on every account their split lines transfer into, joined to the schedule's `user_id`, refusing a missing one with `errors.accounts.notFound`. That serialises them against the delete's `FOR UPDATE`.

## Tried and ruled out
Calling `ScheduledTransactionsService.remove` inside the deleting transaction: its un-awaited history `record` would join the ambient transaction and race it (see `derived-state-writers.guard.spec.ts`).

## Watch out
This supersedes the Nov 6 note that the real loan delete cannot run in the entity-built integration schema. It can now, because the account's pointer is cleared before the schedule goes.
A rule-run undo that rewinds a schedule cursor still re-inserts pruned overrides without checking their lines' accounts. That gap is listed under INV-ACCOUNTDELETE-001 (status partial).
