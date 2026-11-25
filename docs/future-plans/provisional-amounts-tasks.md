# Provisional transaction amounts: task list

The task graph for `docs/future-plans/provisional-amounts.md` ("the design"; section numbers point there). One task per agent session and one PR per task, based on `main`, opened once its dependencies have merged.

## How to use this list

- Read `AGENTS.md`, the layer `CLAUDE.md` and the documents its table names for the task's subject. Any task that touches a transfer, a balance or a total reads `docs/financial-semantics.md` and the FX entries of `docs/system-invariants.md` first.
- Re-locate code by symbol, never by a line number quoted in an issue.
- Identifiers say `provisional`. `estimated` already means a schedule's history-derived amount (`amountIsEstimated`, `estimateStatus`) and is not reused in a field, type or key name.
- The flag is never accepted from a request body, and no task adds a path that reads the old description text except the restore normalization in B4.
- New reader-facing strings go in the English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q, once.
- Run only the specs the task touches plus `npm run test:changed`; integration specs where a query, an entity or a migration changed.

## Deploy impact

| Class | Meaning |
| --- | --- |
| none | Tests, docs, or code nothing calls yet |
| inert | Ships a column, a field or an endpoint that changes no figure and no existing behaviour |
| neutral | Rewrites a live path and is designed to preserve its behaviour; the touched module's existing specs are the gate |
| visible | Changes a figure, a stored value or what a reader sees; the acceptance names exactly what changes |

## Task graph

| ID | Task | Depends on | Deploy impact | Recommended agent | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | Column, backfill, entity, support-backup rule, action-history column lists | | inert | opus, medium | Open |
| B2 | Importer writes and matches the column; the plain path estimates at the historical rate and refuses without one | B1 | visible | fable, high | Open |
| B3 | Both report readers read the column | B2 | neutral | opus, high | Open |
| B5 | Confirming: the action endpoint, the transfer-edit rule, clearing when a leg stops being a transfer leg, undo | B1 | inert | fable, high | Open |
| S1 | `is:provisional` in the transaction search, both layers | B1 | inert | opus, medium | Open |
| B6 | Provisional count on account balances and net worth | B2 | inert | opus, high | Open |
| B7 | Provisional count on custom reports, transaction analytics, the assistant and MCP | B2 | inert | opus, high | Open |
| B8 | Provisional count on the built-in report surfaces that read transfer legs, and budget transfer actuals | B2 | inert | opus, high | Open |
| F1 | Types, API client, the row badge, the "Confirm amount" action | B5 | visible | opus, high | Open |
| F2 | The note and the headline mark; accounts, register header, net worth | B6 | visible | opus, medium | Open |
| F3 | The note on custom reports, built-in reports, the payee and category panels, budgets | B7, B8, F2 | visible | opus, medium | Open |
| B4 | Retire the description note: stop writing it, strip it, restore normalization, delete the marker, guard | B3, B5, S1, F1 | visible | opus, high | Open |
| E1 | E2E: import, badge, confirm, the mark goes | B4, F2 | none | sonnet, high | Open |
| Q | Acceptance: every locale, website docs, release note, invariants catalogued, plan retired to `docs/specs/` | all | none | sonnet, medium | Open |

## Tasks

### B1: the column

Files: a new migration `<UTC timestamp>_transactions_amount_is_provisional.sql`; `database/schema.sql`; `backend/src/transactions/entities/transaction.entity.ts`; `backend/src/backup/support-backup/support-backup-rules.ts`; `backend/src/action-history/action-history.service.ts`.

- `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount_is_provisional BOOLEAN NOT NULL DEFAULT false`, a `COMMENT ON COLUMN`, and a partial index on `(user_id, account_id) WHERE amount_is_provisional`.
- Backfill: set it `true` on transfer rows whose description holds the marker text. The description is left alone here; B4 strips it.
- Entity property `amountIsProvisional`.
- Support backup: `keep`.
- Action history: the column joins the restore field list and every raw `INSERT INTO transactions` column list in that service, so undoing a delete or an edit restores the flag (design P7).

Acceptance: migration lint, schema verification and the prefix check pass; an integration spec proves the backfill sets the flag on a marked transfer leg, leaves a marked non-transfer row and an unmarked leg alone, and is a no-op on a second run; an action-history spec proves a deleted provisional row comes back provisional.

### B2: the importer

Files: `backend/src/import/import-regular-processor.service.ts`, its spec, `backend/test/integration/import-qif-split-transfer.integration.spec.ts` and a plain-transfer integration case; the backend English error catalog; a second migration repeating B1's backfill.

- Both creation paths set `amountIsProvisional: true` on the cross-currency leg. They keep writing the description note until B4.
- The three pending lookups match `amount_is_provisional = true` and no longer the description. A match writes the file's amount and clears the flag in the same update.
- The plain path computes its leg as the split path does: `resolveFxRateOrNull` for the row's date, `applyFxConversion` at the target currency's precision, the rate stored on the leg. One helper serves both paths.
- No rate: refuse the row with a message naming the pair and the date (a key beside `errors.import.noRateForSplitTransfer`). Nothing is written for that row.
- Repeat the backfill in a new migration, for rows a release without this change wrote after B1.
- `shared_protect_ledger_transaction` (`database/schema.sql`) refuses any change to a shared-posting row outside its ignore list (`status`, `reconciled_date`, `description`, `payee_name`, `payee_id`, `updated_at`), and `amount_is_provisional` is not on it. B1's backfill skips shared-ledger rows for that reason; decide whether clearing the flag on such a row is refused or the column joins the list.

Acceptance: design section 7, rows 2, 3 and 6, plus the file-order reversal, as specs. A confirmed transaction whose description contains the old text is not matched as pending. A provisional leg whose description was edited or cleared is still matched. Balances move by the estimate, then by the difference on confirmation.

### B3: the report readers

Files: `backend/src/reports/transfer-counterpart.ts`, `backend/src/built-in-reports/transfer-rate-sql.ts`, their specs, the report service fetch if it does not already hydrate the column, the two transfer-FX integration specs, `docs/system-invariants.md`.

- `transferCounterpartOf` returns `null` for a counterpart with `amountIsProvisional`.
- `transferRateSql` replaces the description predicate with `amount_is_provisional IS NOT TRUE` on the same two aliases. Keep it a separate `AND` clause; folding it into the link clause breaks an existing substring assertion.
- Fixtures set the column instead of the text. Add the case that a counterpart with the text and `false` is a posted amount.
- Restate the #2338 paragraph of the FX invariant on the column (design P4).

Acceptance: the existing #2338 cases pass with the column as the only signal; the surfaces integration spec's figures do not change.

### B5: confirming

Files: `backend/src/transactions/transactions.controller.ts`, the transactions service, `backend/src/transactions/transaction-transfer.service.ts`, `backend/src/transactions/transaction-conversion.service.ts`, the action-history wiring, specs, the backend English catalog.

- `POST /transactions/:id/confirm-amount`: owner only, inside one `withScopedDb` transaction, refuses a row that is not provisional, clears the flag, changes no amount and no balance, records an undoable action. Follow how the neighbouring single-row actions are guarded and recorded.
- `updateTransfer`: when the request supplies an amount for the provisional leg (`amount` for the source leg, `toAmount` for the destination leg) and it differs from the stored one, clear the flag in the same write. A reprice without a supplied amount, and an edit that resends the same amount, leave it. Compare values, not field presence.
- Convert-to-transaction, unlink, and any other path that ends a leg's life as a transfer leg clears the flag (design P3). Grep the bulk, assistant-action and MCP routes to the same writes.
- A spec over the create, update, transfer-update and bulk-update DTOs proves `amountIsProvisional` is refused from a body (design P2).
- The split-transfer counterpart leg goes through its own update path; cover it.
- `shared_protect_ledger_transaction` (`database/schema.sql`) refuses any change to a shared-posting row outside its ignore list (`status`, `reconciled_date`, `description`, `payee_name`, `payee_id`, `updated_at`), and `amount_is_provisional` is not on it. B1's backfill skips shared-ledger rows for that reason; decide whether clearing the flag on such a row is refused or the column joins the list.

Acceptance: design section 10 rows 6 and 9 and the split half of row 10.

### S1: search

Files: `backend/src/transactions/transaction-search-parse.util.ts`, `backend/src/transactions/transaction-search-query.util.ts`, `backend/src/transactions/apply-transaction-search.ts`, their specs, `docs/specs/advanced-search.md`, the frontend's search help copy if it lists the `is:` values.

Add `provisional` to the `is:` values, negatable, echoed in the search interpretation like `is:transfer`.

Acceptance: `is:provisional` returns exactly the flagged rows and `-is:provisional` the rest, in the parse, query and apply specs.

### B6: balances and net worth

Files: `backend/src/accounts/accounts.service.ts` (the account list and `NetWorthTotals`), `backend/src/accounts/account-balances-report.service.ts`, `backend/src/accounts/daily-balance-totals.service.ts`, `backend/src/net-worth/net-worth.service.ts`, `backend/src/mcp/tool-output-schemas.ts` for the tools that return those shapes, specs.

- Each account in a list or summary carries `provisionalCount`: its non-void provisional rows dated on or before the balance's day.
- Each total built from account balances carries the sum over its accounts; each month of the net worth history carries the count as of that month's end.
- One shared SQL fragment or helper counts them; no surface writes its own predicate.
- No figure changes and none is withheld.

Acceptance: design section 10, the balances line. A void or future-dated provisional row counts nowhere.

### B7: custom reports, analytics, assistant, MCP

Files: `backend/src/reports/reports.service.ts`, `backend/src/reports/dto/execute-report.dto.ts`, `backend/src/transactions/transaction-analytics.service.ts`, `LlmTransactionRow` in the transactions service, `backend/src/mcp/tool-output-schemas.ts`, `backend/src/mcp/tools/transactions.tool.ts`, `backend/src/ai/query/tool-definitions.ts`, specs.

- The custom report result and its summary carry `provisionalCount` over the rows the report counted.
- Every `TransactionAnalyticsService` read that already reports missing rates (summary, grouped totals, tag breakdown, monthly totals, flow totals, period comparison) carries `provisionalCount` at the same grain.
- `LlmTransactionRow` carries `amountIsProvisional`. The MCP output schemas and the tool descriptions say what the count means in one sentence.
- The assistant and the MCP server share the tools: both adapters change in this PR.

Acceptance: design section 10 rows 2 and 3 for custom reports and for the transaction summary.

### B8: built-in reports and budgets

Files: the built-in report services and DTOs for the surfaces `docs/system-invariants.md` lists under the transfer-rate rule (the Cash Flow Sankey's transfer flows, the Monthly Category Breakdown's transfer rows, Income vs Expenses' tagged transfer flows, the payee and category account panels through `backend/src/built-in-reports/account-breakdown-fx.ts`), `backend/src/budgets/budget-spending.util.ts` for outgoing-transfer lines, `backend/src/currencies/currency-detail.service.ts`, specs, `report-transfer-fx-surfaces.integration.spec.ts`.

A surface is in scope exactly when its rows can be transfer legs: a provisional amount is always a transfer leg, so a report that excludes transfers has nothing to count and is left alone. Each in-scope response gains `provisionalCount`.

Acceptance: the surfaces integration spec asserts count 1 while the EUR legs are provisional and 0 once confirmed, on every surface it already covers.

### F1: the row and the action

Files: `frontend/src/types/transaction.ts`, `frontend/src/lib/transactions.ts`, `frontend/src/components/transactions/TransactionRow.tsx`, `frontend/src/components/transactions/variants/PebbleRegister.tsx`, `frontend/src/components/transactions/TransactionActionSheet.tsx`, the transactions page's handler wiring, the English `transactions` catalog, tests.

Design section 9, "Badge" and "Action". The badge follows the muted-label-plus-tooltip pattern the schedule estimate uses in `ScheduledTransactionList`. After confirming, the row and the account's balance display refresh through the page's existing mutation path.

Acceptance: a provisional row shows the badge in the card, the desktop row and the Pebble register; a confirmed row shows neither badge nor action; the action calls the endpoint and the badge goes.

### F2: figures, first surfaces

Files: a new note component beside `frontend/src/components/reports/PartialDataNotice.tsx`, a provisional mark beside or within `frontend/src/components/ui/PartialTotal.tsx`, the account types, `frontend/src/components/accounts/AccountList.tsx`, `frontend/src/components/accounts/AccountRow.tsx`, `frontend/src/components/transactions/AccountInfoBar.tsx`, `frontend/src/components/dashboard/NetWorthHero.tsx`, `frontend/src/components/dashboard/NetWorthChart.tsx`, `frontend/src/components/reports/NetWorthReport.tsx`, the English catalogs, tests.

The figure is always shown. A count above zero adds the mark and a tooltip or note saying how many estimated amounts it includes and that `is:provisional` lists them. Read the count as a number; an absent field is no information and shows nothing.

Acceptance: each surface shows the mark at count 1 and nothing at 0 or absent; a figure that is both partial (missing rate) and provisional shows both.

### F3: figures, reports

Files: `frontend/src/components/reports/CustomReportViewer.tsx`, the built-in report components for B8's surfaces, `frontend/src/components/transactions/PayeeInfoWidget.tsx` and the category counterpart, the budget components that show transfer actuals, types, tests.

Wire F2's two components to B7's and B8's counts.

Acceptance: as F2, per surface.

### B4: retire the note

Files: `backend/src/import/pending-import.ts` (deleted or reduced to what the normalization needs), `backend/src/import/import-regular-processor.service.ts`, a migration, `database/schema.sql` if the migration changes structure (it should not), `backend/src/backup/restore-legacy-normalizations.ts`, a guard spec, `docs/system-invariants.md`, `docs/backend/transactions-and-money.md`.

- The importer stops writing the note.
- Migration: repeat the backfill, then remove the exact note text from the descriptions of flagged rows, trim, and store an empty result as `NULL`. Model the header and the guarded shape on `20261123221734_heal_foreign_entry_default_rate.sql`. A row whose description holds the words but is not a transfer leg is left alone.
- The restore normalization applies the same two statements to a backup that predates the column.
- A source-scanning guard fails on a description match against the old text anywhere in `backend/src` outside the normalization (design P1).

Acceptance: an integration spec proves the strip on a note-only description, a memo-plus-note description and an already-stripped row, twice; a restore of a pre-column fixture yields flagged rows without the note; the guard fails on a reintroduced `LIKE`.

### E1: end to end

Files: one new Playwright spec and its fixture files under `e2e/`.

Import a file for a USD account holding a transfer into a EUR account; the EUR register shows the estimated amount with the badge and the accounts list marks the EUR balance; confirm it; both marks go. A second case imports the EUR file instead and sees the amount replaced.

### Q: acceptance

- Every locale, both layers, as the final commit.
- Website docs: the pages that tell the reader to search for the memo text (`website/docs/importing-from-microsoft-money.md`, `website/docs/reports.md`, `website/docs/currency-management.md`) describe the badge, the action and `is:provisional`; regenerate the built pages and the search index.
- Release note.
- The design's P1 to P7 are in `docs/system-invariants.md` with their enforcement status.
- The plan pair is retired to `docs/specs/` as one spec, the tracker is closed, and Discussion #2383 gets a closing comment.
