---
title: "Provisional amounts B1: the amount_is_provisional column, backfill and undo"
author: Node
date: 2026-11-25
branch: claude/issue-2389
cost: { minutes: 23, tokens: 139685 }
touches:
  - backend/src/action-history/action-history.service.spec.ts
  - backend/src/action-history/action-history.service.ts
  - backend/src/backup/support-backup/support-backup-rules.ts
  - backend/src/transactions/entities/transaction.entity.ts
  - backend/src/transactions/transactions.service.ts
  - backend/test/integration/action-history-provisional-undo.integration.spec.ts
  - backend/test/integration/migration-transactions-amount-is-provisional.integration.spec.ts
  - database/migrations/20261125132236_transactions_amount_is_provisional.sql
  - database/schema.sql
---

## Decided
- Backfill flags only `is_transfer = true AND linked_transaction_id IS NOT NULL AND description LIKE '%PENDING IMPORT%'` rows; both importer creation paths (plain and split) write `isTransfer: true` with the link, so this covers both. The description is left for B4.
- Undo needs the flag in `TransactionsService.snapshotTransaction` as well as the action-history lists: the delete and update history snapshots are a hand-written field list, so without it the restore has nothing to put back.
- The action-history unit specs that read the foreign entry with `.slice(-2)` now read `.slice(-3, -1)`; amount_is_provisional is the last parameter of every raw `INSERT INTO transactions` in that service.

## Tried and ruled out
- A backfill without a shared-ledger exclusion: `shared_protect_ledger_transaction` raises on any update to a posting row or a shared-group account row, which would crash-loop the migration. The integration DB is built by synchronize and has no such trigger, so a spec cannot show it; the exclusion stays in SQL.

## Watch out
- A `COMMENT ON COLUMN` in a migration must appear verbatim in schema.sql too, or verify-schema's pg_dump diff fails.
- `Array.prototype.at` does not type-check in backend specs (lib below es2022); use `slice(-1)[0]`.
- Transfer delete and bulk delete record no snapshots today; their undo handlers read legacy shapes, so they default the flag to false.
