---
title: TypeORM remove clears the entity id; un-awaited history writes race their order
author: Node
date: 2026-11-06
branch: claude/issue-2028
cost: { minutes: 17, tokens: 65106 }
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
  - frontend/src/lib/accounts.ts
---

## Decided
`AccountsService.delete` copies the account into `snapshot` before the transaction, because `m.remove(account)` sets the entity's primary key to undefined. A history entry built from the entity afterwards has `entityId: null` and no `id` in `beforeData`, and undo cannot restore it.
When one operation writes two undo entries whose order matters (a loan's schedule, then the loan), the earlier one is awaited: `recordRemoved` returns the `record` promise, and `delete` awaits it before recording the account. Two un-awaited `ActionHistoryService.record` calls can commit in either order, and undo takes the newest `created_at` first.
An override's `splits` post when `COALESCE(override.is_split, schedule.is_split)` is true (`useSplits` in `ScheduledTransactionsService.post`). So the delete count treats `is_split IS NOT FALSE` as live, and override updates lock the lines the saved override will post.

## Watch out
The unit mock of `manager.remove` returns the entity unchanged. A test that depends on what remove does to the entity has to mock the id clearing itself, as the "records the account for undo" case does.
