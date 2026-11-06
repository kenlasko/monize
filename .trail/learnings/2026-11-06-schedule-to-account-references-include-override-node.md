---
title: Schedule-to-account references include override split JSONB
author: Node
date: 2026-11-06
branch: claude/issue-2028
cost: { minutes: 8, tokens: 36057 }
touches:
  - backend/src/accounts/account-schedule-references.spec.ts
  - backend/src/accounts/account-schedule-references.ts
  - backend/test/integration/account-delete-schedules.integration.spec.ts
  - docs/system-invariants.md
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
---

## Decided
Per-occurrence overrides store their split lines as JSONB in `scheduled_transaction_overrides.splits`, keyed `transferAccountId`, and no foreign key guards those ids. Any check of "which schedules use this account" has to look inside the JSONB as well as the four schedule columns (`account_id`, `transfer_account_id`, `investment_funding_account_id`, and the split's `transfer_account_id`). `countSchedulesReferencingAccounts` matches it with `splits @> jsonb_build_array(jsonb_build_object('transferAccountId', a.id::text))`. That containment test is false, not an error, on a NULL or non-array value.

## Tried and ruled out
Counting every override row: an override of a slot before the schedule's `next_due_date` is spent and never posts, and the UI does not show it to remove, so counting it would refuse the delete with no way out. Only overrides with `original_date >= next_due_date` count.

## Watch out
Nothing in the database cleans up override JSON when an account goes, so every other path that removes an account, or that validates an override's target, has to handle these ids itself.
