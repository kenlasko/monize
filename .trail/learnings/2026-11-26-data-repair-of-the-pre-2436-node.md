---
title: "Data repair of the pre-#2436 imported investment cash-leg shape (#2445)"
author: Node
date: 2026-11-26
branch: claude/issue-2445
cost: { minutes: 14, tokens: 171198 }
touches:
  - backend/test/integration/migration-heal-imported-investment-cash-leg-shape.integration.spec.ts
  - database/migrations/20261126140130_heal_imported_investment_cash_leg_shape.sql
  - docs/backend/transactions-and-money.md
---

## Decided
- `database/migrations/20261126140130_heal_imported_investment_cash_leg_shape.sql` repairs rows the QIF/OFX/CSV importer wrote before PR #2443: investment row (INVESTMENT_BROKERAGE) -> transaction_id named a transfer counterpart in the brokerage, mutually linked with the real cash row in the brokerage's linked cash account. It repoints transaction_id at the cash row, clears the cash row's is_transfer/link, moves tags, deletes the counterpart, subtracts its amount from the brokerage current_balance (skip VOID and rows dated after the owner's today: preference tz, else last_client_timezone, else UTC, validated against pg_timezone_names) and deletes the brokerage's monthly_account_balances.
- The brokerage balance did include the counterpart: the post-import recalculation sums every ledger row of every affected account, and the brokerage id is in affectedAccountIds.
- Counterparts with dependents (attachments, warranties, email receipts, scheduled_transaction_postings, bank-sync matches, split links, shared_ledger_links) are skipped and named in a NOTICE.

## Tried and ruled out
- A backup-restore legacy normalization (restore-legacy-normalizations.ts) for this repair: those replay meaning changes of a column, and run before restoreDeferredFkColumns, so linked_transaction_id / transaction_id are not in place yet. The heal_foreign_entry_default_rate repair has none either.
- Backfilling investment_transactions.exchange_rate from the cash row: not asked in #2445; left as a follow-up.

## Watch out
- The integration DB is built by TypeORM synchronize, not schema.sql: also run the migration once against a schema.sql database (triggers, extra NOT NULLs) by hand.
- PR #2443's doc paragraph ends "nothing repairs them in place"; once both merge, that sentence is stale.
