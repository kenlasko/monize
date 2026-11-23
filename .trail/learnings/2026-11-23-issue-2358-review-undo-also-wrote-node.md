---
title: "Issue #2358 review: undo also wrote the inherited-1 foreign entry"
author: Node
date: 2026-11-23
branch: claude/issue-2358
cost: { minutes: 7, tokens: 59784 }
touches:
  - backend/test/integration/migration-heal-foreign-entry-default-rate.integration.spec.ts
  - database/migrations/20261123221734_heal_foreign_entry_default_rate.sql
  - docs/financial-semantics.md
  - docs/system-invariants.md
  - backend/src/action-history/action-history.service.spec.ts
  - backend/src/action-history/action-history.service.ts
---

## Decided
- undoTransactionUpdate in backend/src/action-history/action-history.service.ts restored exchangeRate without originalAmount or originalCurrencyCode, although snapshotTransaction records both. Undoing an edit that added a foreign entry put the plain row's 1 back beside the original amount. All three fields are now restored together; redo inverts through the same code.
- The heal migration raises a NOTICE with its row count (db-migrate logs notices as warnings) because nobody counted the affected rows.

## Tried and ruled out
- Seeding the shared-ledger fixture with session_replication_role = replica: it needs superuser. The spec instead seeds a REPAYMENT entry (no allocation check), its integration and posting, and a SHARED_SETTLEMENT account under SET LOCAL app.preserve_timestamps, in one multi-statement query so SET LOCAL holds.

## Watch out
- When a write path for a foreign entry is fixed, also check undo/redo and backup restore. The field lists in action-history are hand-written and drift from snapshotTransaction.
- A schedule's inherited 1 is not healed; the estimate cron rewrites it only when getLatestRate returns a rate for the pair.
