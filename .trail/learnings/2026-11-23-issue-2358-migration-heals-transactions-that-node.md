---
title: "Issue #2358: migration heals transactions that inherited the default exchange_rate 1"
author: Node
date: 2026-11-23
branch: claude/issue-2358
cost: { minutes: 13, tokens: 102847 }
touches:
  - backend/test/integration/migration-heal-foreign-entry-default-rate.integration.spec.ts
  - database/migrations/20261123221734_heal_foreign_entry_default_rate.sql
  - docs/financial-semantics.md
  - docs/system-invariants.md
  - backend/src/scheduled-transactions/scheduled-transactions.service.spec.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.ts
---

## Decided
- The maintainer chose a data-only migration (database/migrations/20261123221734_heal_foreign_entry_default_rate.sql) over a read-side check. It rewrites exchange_rate = 1 beside an original currency to round(fxBaseFromCharged(amount, account fee) / original_amount, 10) only when the amount disagrees with applyFxConversion(original, 1, fee) by more than one unit of the account currency, the tolerance resolveForeignEntry uses.
- Skipped: zero or opposite-sign amounts, income on a 100% fee (NULLIF turns the division by zero into a NULL rate), a derived rate >= 1e10 or equal to 1, and shared-ledger rows (shared_protect_ledger_transaction would raise PSE01).
- ScheduledTransactionsService.update now passes no rate when a plain schedule gains a foreign entry, as TransactionsService.update has done since #2344.
- This is not the ruled-out "show the rate implied by the two amounts when the stored rate is missing" display. It is a one-off repair of a stored 1 that the amounts contradict, using the same derivation resolveForeignEntry already writes.

## Tried and ruled out
- Relying on the CTE's WHERE to avoid division by zero: the planner may push the outer quals down and evaluate them in any order, so the divisions use NULLIF instead.

## Watch out
- backend/test/integration/migration-heal-foreign-entry-default-rate.integration.spec.ts computes the expected rates with fxBaseFromCharged and roundFxRate, so the SQL and the TS stay in step. A mutation that drops the agreement clause fails the "keeps every 1" case.
- The heal bumps updated_at on the rows it changes; a second pass touches nothing.
