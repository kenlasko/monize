---
title: Provisional backfill must flag unlinked marked legs too (supersedes the B1 predicate)
author: Node
date: 2026-11-25
branch: claude/issue-2389
cost: { minutes: 10, tokens: 23662 }
touches:
  - backend/test/integration/migration-transactions-amount-is-provisional.integration.spec.ts
  - database/migrations/20261125132236_transactions_amount_is_provisional.sql
  - docs/future-plans/provisional-amounts-tasks.md
---

## Decided
- The amount_is_provisional backfill is `is_transfer = true AND description LIKE '%PENDING IMPORT%'` plus the shared-ledger exclusions, with no `linked_transaction_id IS NOT NULL`. This replaces the predicate in the earlier B1 learning.

## Tried and ruled out
- Requiring the link: the importer's split and plain pending lookups match only unlinked marked legs (`t.linked_transaction_id IS NULL`), and ON DELETE SET NULL unlinks a leg whose source is deleted. Once B4 strips the note, an unflagged leg like that can never be found again, and the next import duplicates it.

## Watch out
- B2's repeat backfill must use the same predicate.
- The integration DB does have shared_protect_ledger_transaction. Seed shared rows under `SET LOCAL app.preserve_timestamps = 'on'` in one query (fixture in migration-heal-foreign-entry-default-rate.integration.spec.ts). Without the exclusion the migration fails with PSE01.
- The trigger's ignore list does not include amount_is_provisional, so B2's clear-on-match and B5's confirm will be refused on a shared-posting row unless that is decided.
