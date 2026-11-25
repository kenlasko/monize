---
title: Importer writes and matches amount_is_provisional; the plain cross-currency leg is the historical-rate estimate and an orphaned leg stays provisional (issue 2390)
author: Node
date: 2026-11-25
branch: claude/issue-2390
cost: { minutes: 32, tokens: 229035 }
touches:
  - backend/test/integration/import-qif-plain-transfer.integration.spec.ts
  - backend/test/integration/import-qif-split-transfer.integration.spec.ts
  - backend/test/integration/migration-transactions-amount-is-provisional.integration.spec.ts
  - database/migrations/20261125150107_transactions_amount_is_provisional_backfill_repeat.sql
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
---

## Decided
- `ImportRegularProcessorService.transferLeg` is the one computation for the other account's leg on both the plain and the split path: `resolveFxRateOrNull` for the row's date, `applyFxConversion` at the target currency's precision, the rate stored on the leg, `crossCurrency` telling the caller to write the leg provisional. The plain path computes the leg before its orphan lookup, so a row with no rate is refused before anything is written for the other account (key `errors.import.noRateForTransfer` beside `noRateForSplitTransfer`; the helper takes a `line` argument to pick the message).
- The three pending lookups share `PROVISIONAL_LEG_SQL` (`t.amount_is_provisional = true`) and no longer match the description. Only `matchPendingTransfer` (this account's own file states the amount) clears the flag, in the same update that writes the file's amount.
- The two lookups for an orphaned provisional leg in the target account (`findOrphanedProvisionalLeg`, source deleted so `linked_transaction_id IS NULL`) re-link it and re-estimate it at this row's rate but leave it provisional, keeping the PENDING IMPORT note: the file being imported is the source's and still does not state the target's amount. The design table says "three lookups clear the flag", but its own definition of "confirmed" (a file stated it for its own account) rules that out for these two; flagged for the maintainer in the PR.
- Clearing the flag on a shared-ledger row needs no change to `shared_protect_ledger_transaction`'s ignore list: the same update also writes `amount`, which the trigger already refuses, and the importer never writes such a row.
- A data-only repeat of a backfill is a migration without a `schema.sql` change (precedent: 20261123221734_heal_foreign_entry_default_rate.sql); the B1 migration spec runs over both files with `describe.each`.
## Tried and ruled out
- Counting query-builder calls in the unit spec to route lookups: the counts shifted with the new helper order and one existing test was already hitting a different lookup than its title said. `routeLookups` answers each builder by the predicates written on it (`linked.account_id` for the confirm lookup, `linked_transaction_id IS NULL` plus `amount_is_provisional` for the orphan lookup).
- Adding the English error key alone: `locales.parity.spec.ts` requires every full locale to mirror `en`, so the key goes into all 19 translated catalogs in the same PR despite the task list saying "English only, Q does the locale pass".
## Watch out
- Jest's default heap OOMs on `npx tsc --noEmit` and the integration suite here; run with `NODE_OPTIONS=--max-old-space-size=4096`.
- Unit specs silence `console.*` through `silence-nest-logger.setup.ts`; trace with `process.stderr.write` when debugging.
- `DataSource.query` returns `[rows, affected]` for an `UPDATE ... RETURNING`, not the rows; select the id first.
- `trail check` reports ~20 keyword-overlap conflicts on this change (budget lines, analytics splits, SQL OR folding); none describe what the change does.
