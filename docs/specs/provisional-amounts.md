# Provisional transaction amounts

Status: shipped (tracker #2388, Discussion #2383; every task below is merged, and the acceptance task Q closed the build). Kept as the specification: the invariants are catalogued as INV-FX-006 to INV-FX-011 in `docs/system-invariants.md` (P4 is the transfer paragraph of INV-FX-002), the importer's rules are in `docs/backend/transactions-and-money.md`, and the reader-facing behaviour is in `website/docs/currency-management.md` and `website/docs/reports.md`. The plan's task list is folded into section 14.

## 1. Goal

A transaction amount that Monize wrote as a placeholder is recorded as such in a column, stays visible, stays in every total, and every figure that contains one says so. Nothing about that state is read from, or changed by, the description.

Today the only such amount is the importer's: a cross-currency transfer in an imported file creates the other account's leg before that account's own file has been imported, and marks it by putting the words `PENDING IMPORT` in the leg's description. Discussion #2383 reports two defects that remain after issue #2338:

1. **The placeholder is a wrong number.** A plain transfer stores the file's figure at par (100 USD becomes +100 EUR). With EUR as the reporting currency the USD account reads -80 EUR, the EUR account +100 EUR, and both together a cash movement of +20 EUR that never happened.
2. **The state lives in an editable text field.** Removing the words confirms an unconfirmed amount, typing them on another transaction makes a confirmed amount provisional, and three paths rewrite a description wholesale (a transfer edit writes the description onto both legs, a bulk update mirrors it onto the linked leg, and an import rule's set-description action runs on the placeholder row itself).

## 2. What exists

| Need | Today |
| --- | --- |
| The marker | `backend/src/import/pending-import.ts`: `PENDING_IMPORT_MARKER`, the note text, a `LIKE` pattern, `isPendingImportAmount` |
| Who writes it | `backend/src/import/import-regular-processor.service.ts`, two places: the plain transfer path and the split-line transfer path. QIF, CSV and OFX files all run through this processor |
| Who confirms it | The same file, three lookups by `description LIKE`: `matchPendingTransfer` (the other account's file arrives), the split path's pending check, the plain path's pending check. Each replaces amount and description together |
| The plain path's placeholder | `-qifTx.amount` at par, no stored rate |
| The split path's placeholder | The historical rate through `resolveFxRateOrNull`; refused with `errors.import.noRateForSplitTransfer` when there is none (PR #1828) |
| Rate lookup | `resolveFxRateOrNull` in `backend/src/common/fx-entry.util.ts` calls `ExchangeRateService.getRateForDate`, which reads the stored history and, when nothing covers the date, fetches a provider window around it and stores it |
| Who reads it in reports | `backend/src/reports/transfer-counterpart.ts` (custom reports) and `backend/src/built-in-reports/transfer-rate-sql.ts` (every SQL surface): a marked counterpart is not a posted amount, so the confirmed leg converts at the market rate (issue #2338) |
| The provisional leg's own figure | Counted everywhere as an ordinary amount: balances, net worth, reports, analytics, MCP |
| The frontend | Nothing reads the marker; the reader sees it only as description text |
| Finding them | The website docs tell the reader to search for the memo text |
| "This total is incomplete" | `missingCurrencies` / `missingRatePairs` on the response, `PartialTotal` and `PartialDataNotice` on the page. That mechanism withholds a total; this one does not |
| A similar word | `scheduled_transactions.amount_is_estimated` and `estimateStatus` (issues #2096, #2164) mean a schedule's history-derived amount. Identifiers here say `provisional`, never `estimated` |

## 3. Product decisions

Made by the maintainer on 2026-11-24.

1. **A column is the only source of truth.** `transactions.amount_is_provisional BOOLEAN NOT NULL DEFAULT false`. A migration sets it from the existing marker text and removes the note from those descriptions. The importer stops writing the note. Two states only; there is no stored "unknown" amount.
2. **Estimate, include, flag.** A plain cross-currency transfer's other leg is estimated at the historical rate for its date, as the split path already does, so the two sides net to zero in any currency. A provisional amount stays in balances, net worth and report totals. Every figure that contains one carries a count and the page marks it "includes estimated amounts". No total is withheld and no separate subtotal is shown.
3. **No rate, no row.** The rate lookup already asks the provider when nothing is stored. When that also yields nothing, the plain path refuses the row exactly as the split path does: the row's savepoint rolls back and the import result names the pair and the date.
4. **Three ways to confirm.** The other account's file is imported (as today); the reader uses an explicit "Confirm amount" action; or the reader saves a transfer edit that supplies a different amount for the provisional leg.
5. **Only the importer creates a provisional amount.** A reader cannot mark a transaction provisional. Discussions #253 and #1797 stay separate.
6. **Finding them.** The transaction search gains `is:provisional`, replacing the documented search for the memo text.

## 4. Definitions

- **Provisional leg.** A transfer leg row with `amount_is_provisional = true`. Its amount is Monize's estimate of what the other account's statement will show.
- **Confirmed.** Any row with `amount_is_provisional = false`, the default. Every amount a person typed, a file stated for its own account, or a bank reported is confirmed.
- **Provisional count.** For a figure, the number of provisional legs whose amounts are inside it. Zero means the figure is built from confirmed amounts only.

A split line is never provisional: the counterpart of a split's transfer line is a whole row in the other account, and that row carries the flag.

## 5. Invariants

Proposed for `docs/system-invariants.md` under the next free ids of the FX family; the task that makes each one true adds its entry.

| Id | Statement | Mechanism |
| --- | --- | --- |
| P1 | Whether an amount is provisional is read from `amount_is_provisional` and nowhere else | The marker constants are deleted; a guard spec refuses a description match against the old text outside the restore normalization |
| P2 | No edit of description, memo, payee, category, tags or status changes the flag | Only the four writers in section 6 name the column; a spec over the update DTOs proves the field is not accepted from a request body |
| P3 | A provisional leg is a transfer leg | Every path that turns a leg into an ordinary transaction, or unlinks it, clears the flag in the same write |
| P4 | A provisional counterpart is not a posted amount (issue #2338, restated on the column) | `transferCounterpartOf` and `transferRateSql` read the column |
| P5 | A figure that sums a provisional amount reports a provisional count above zero on the same response | Per-surface specs (section 10) |
| P6 | Confirming replaces the estimate and moves the balance by the difference in the same transaction | The import paths already do; the confirm action changes no amount |
| P7 | Undo restores the flag with the row | The column is in every action-history column list |

## 6. Data contract

**Column.** `amount_is_provisional BOOLEAN NOT NULL DEFAULT false` on `transactions`, entity property `amountIsProvisional`, with a partial index on `(user_id, account_id) WHERE amount_is_provisional` for the importer's lookups and the counts.

**Writers.** Exactly these set or clear it:

| Writer | Effect |
| --- | --- |
| The importer creating the other account's leg of a cross-currency transfer (plain and split paths) | `true` |
| The importer's lookup for this account's own file (`matchPendingTransfer`), on a match | `false`, with the file's amount; the two legs take the settlement rate the stated amounts imply (source 1, destination the ratio) |
| The importer's two lookups for an orphaned leg (source deleted; the plain and split creation paths), on a match | stays `true`: the leg is re-linked and re-estimated at the row's rate, because the file being imported is the source's and still does not state this leg's amount (changed in issue #2390 from "`false`, with the new amount"; awaiting the maintainer's agreement on that issue's PR) |
| The confirm action, `POST /transactions/:id/confirm-amount` | `false`, amount unchanged |
| `updateTransfer`, when the request supplies an amount for the provisional leg that differs from the stored one | `false` |
| Convert to an ordinary transaction, unlink, or any path that ends the leg's life as a transfer leg | `false` |

A provisional leg is never a recorded transfer to the importer's duplicate check (`import-transfer-dedupe.ts`), so the account's own file confirms it even when it states exactly the estimate. A zero transfer across currencies needs no rate: its other leg is a confirmed zero and is never provisional.

Decided in issue #2392:

- The confirm action's history entry restores the flag alone and records the confirmed amount only to compare. Undo is refused once the leg holds another amount or is no longer a transfer leg: that figure is the reader's, and decision 5 lets nobody mark an amount provisional.
- A row the shared-expense ledger protects (`shared_protect_ledger_transaction`) is not exempted: the column stays off the trigger's ignore list, so confirming such a row is refused with the trigger's own message until it is unlinked in Shared expenses.
- An amount is compared with its currency. A transfer edit that leaves the pair in one currency confirms the leg (a conserving pair holds no estimate), and an amount stated for a leg the edit moves into another currency confirms it even when the number is unchanged.
- An edit of a split parent replaces its lines and recreates each transfer line's counterpart. The flag is carried onto a recreated counterpart in the same account holding the same amount (`backend/src/transactions/provisional-split-legs.ts`). This preserves a state across a row replacement, as the received amount already is; it is not a fifth writer, because it never sets the flag on an amount that was not provisional. A line whose own amount changed is repriced and written confirmed: a replace-all write cannot tell which old line it continues.

A transfer edit that reprices the provisional leg without a supplied amount (the reader changed only the other side, and the server computed the rest from the market rate) leaves it provisional: the new figure is still an estimate.

**Read shape.** The transaction entity is the response, so `amountIsProvisional` appears on every transaction read. The model-facing row `LlmTransactionRow` carries it too. It is never accepted on a create or update body.

**Figure shape.** Each response that carries a converted or summed figure which can contain a transfer leg gains `provisionalCount: number` beside its existing completeness fields. It counts provisional legs inside that figure under that read's own filters, never void rows, and for a balance as of a day only legs dated on or before it. The frontend marks the figure when the count is above zero.

Decided in issue #2394 (balances and net worth):

- Every balance surface reads its count through `loadProvisionalCounts` (`backend/src/common/provisional-count.util.ts`), one statement over `ledgerProvisionalPredicate`: the ledger movement predicate plus the column, bounded at each as-of date. `ledger-balance-sql.spec.ts` fails a balance reader under `accounts/`, `net-worth/`, `delegation/` or `scheduled-transactions/` that names the column itself.
- The account list's `provisionalCount` is over the rows inside `currentBalance`, dated on or before today, on owned rows and joint rows alike (`JointAccountsService.jointAccountsFor`). A future-dated leg sits in `futureTransactionsSum`, which the list adds to the balance it shows, and is not counted there (section 10: a future-dated leg counts nowhere).
- A balance as of a later day counts the legs dated on or before that day: the balances-as-of report at its date, and each day of the daily totals, including a projected day.
- `NetWorthTotals` and each net worth month carry `provisionalCount` with `assetsProvisionalCount` and `liabilitiesProvisionalCount` beside it, counted as of the month's end, bounded at the user's today (their effective timezone, not the database's `CURRENT_DATE`) as the snapshot's own sum is, over the accounts whose ledger balance is in the month's figure. A brokerage valued at market holds none of its ledger rows, so none of its legs either, and an asset counts nothing in the months before its acquisition, whose snapshot is zero. An account whose balance did not convert is outside the subtotal and outside the count (section 8). The summary also carries `totalBalanceProvisionalCount` for `totalBalance`. The LLM net worth history keeps only `provisionalCount`, as it drops the per-side completeness flags.
- `list_accounts` is at its `tools/list` byte budget, so the counts are not declared in its output schema; the loose object carries them, as it does the `known*` subtotals.

Decided in issue #2395 (custom reports, transaction analytics, the assistant and MCP):

- A custom report's `ReportResult` and its `summary` carry `provisionalCount`: each provisional row whose converted amount is inside a figure, once however many groups hold it. The net cells (`backend/src/reports/report-net-cells.ts`) name a row only when its line converted and its part and cell were kept, so a row left out for want of a rate, or one a direction filter drops, counts nowhere; a listed transaction counts when it converted. The count metric sums no amount and counts 0.
- Every `TransactionAnalyticsService` read that reports missing rates counts in SQL (`PROVISIONAL_COUNT_SQL`, whole rows only) at its own grain: the summary's `provisionalCount` over its totals and `converted.provisionalCount` over the buckets that converted, each grouped-totals and tag-breakdown row, each month of the monthly totals (over the parts that converted), the LLM flow totals and each side of the period comparison. The flow totals behind `list_transactions` and the period comparison exclude transfers, so their count is 0 today; it is counted, not assumed. The `transfersOnly` rollup (`getTransfersByAccount`), whose rows are whole transfer legs, carries a count per account and in total.
- The assistant's summary line marks each figure whose count is above 0 ("includes N estimated amounts"), where the numbers are shown.
- `LlmTransactionRow` carries `amountIsProvisional: true` on a provisional leg's row only.
- The assistant's `list_transactions` and `compare_periods` descriptions say what the count means. On MCP the `tools/list` total is at its shrink-only budget, so the counts stay undeclared on the loose outputs, as `list_accounts`' do, and the server instructions say once, for every tool and resource, what a `provisionalCount` above 0 and `amountIsProvisional` mean.

Decided in issue #2396 (built-in reports that read transfer legs, and budget transfer actuals):

- In scope are exactly the reads whose rows can be transfer legs, the ones `transferRateSql` serves: the Cash Flow Sankey's transfer flows, the Monthly Category Breakdown's transfer rows, Income vs Expenses' tagged transfer flows, the payee and category account panels (`backend/src/built-in-reports/account-breakdown-fx.ts`), budget transfer actuals and the currency usage summary. Every other built-in report excludes transfers and gains nothing.
- Each counts in SQL over whole rows (`amount_is_provisional`): a split's transfer line is never provisional, so the split reads count nothing. A group left out for want of a rate counts nowhere (section 8).
- `CashFlowSankeyResponse` and `MonthlyCategoryBreakdownResponse` carry `provisionalCount` at the response; the Sankey counts each half of a flow row on its own side, so an estimate in a half that did not convert is not counted.
- Income vs Expenses carries it on each tag bucket (`IncomeExpenseTagBucket.provisionalCount`), over its `taggedInflows` and `taggedOutflows`. The top-level (All) figures never hold a transfer leg and keep their shape (I1 of `docs/specs/report-tag-key-breakdown.md`).
- Each row of the payee and category account panels carries `provisionalCount` over its `total`; `convertedTotal` is null rather than partial while a part has no rate, so it holds the same rows.
- `queryCategorySpending` counts per outgoing transfer line, per transfer income line and for the transfers-in toggle's income, by id, so a leg an outgoing line and an income line naming one account both read counts once in `provisionalCount`. The budget summary carries `provisionalCount` on each `CategoryActualRow` (0 on a category line) and in total. The alerts, trend, health and period-close readers of the same util are not surfaces F3 marks and are left alone.
- `CurrencyUsageSummary.provisionalCount` is over every row in `transactionCount`, inside `totalInCurrency` and inside `totalInReportingCurrency`, which is null rather than partial while a row has no rate. The transaction-rates list is not a summed figure and is left alone.

**Search.** `is:provisional` and `-is:provisional` in the transaction search grammar.

## 7. Truth table

A transfer of 100 USD on a day whose stored EUR/USD rate is 0.80; reporting currency EUR. "Count" is the provisional count.

| State | USD account only | EUR account only | Both | EUR balance moved by |
| --- | --- | --- | --- | --- |
| Today: USD file imported, par placeholder | -80 | +100 | +20 | +100 |
| After: USD file imported, estimate | -80, count 0 | +80, count 1 | 0, count 1 | +80 |
| After: EUR file imported with +90 | -90, count 0 | +90, count 0 | 0, count 0 | +90 (a further +10) |
| After: reader confirms the +80 instead | -80, count 0 | +80, count 0 | 0, count 0 | +80 |
| After: reader edits the EUR leg to +90 | -90, count 0 | +90, count 0 | 0, count 0 | +90 |
| No rate stored and the provider has none | The row is refused; nothing is written to either account | | | 0 |

The USD leg reads the market rate while its counterpart is provisional (issue #2338) and the two posted amounts once it is confirmed (discussion #2139). The market rate the report reads and the historical rate the importer used are the same stored observation, which is why the two sides net to zero.

The same table holds when the EUR file is imported first: the provisional leg is then the negative USD row, estimated as -112.50 at the inverse rate, and confirmed by the USD file.

## 8. Missing-data policy

- No rate at import: the row is refused (decision 3). Nothing provisional is written without a rate.
- A provisional leg whose own currency has no rate into the reporting currency on a later read is handled by the existing missing-rate rule; the provisional count is counted over the rows that did convert.
- A backup taken before this feature holds the marker text and no column. Restore applies the same backfill-and-strip through `backend/src/backup/restore-legacy-normalizations.ts`.
- A support backup keeps the flag (`keep` in `backend/src/backup/support-backup/support-backup-rules.ts`); it has always dropped descriptions.

## 9. Frontend

- **Badge.** On the amount of a provisional row, in `TransactionRow` (the card branch and the desktop row) and in `PebbleRegister`: a muted "Estimated amount" label with a tooltip saying the amount is Monize's estimate until the other account is imported or the amount is confirmed.
- **Action.** "Confirm amount" in `TransactionActionSheet` and beside the desktop inline buttons, shown only on a provisional row. No confirmation dialog; it is undoable through the action history.
- **Figures.** One small component, a note in the shape of `PartialDataNotice`, and a mark on a headline figure in the shape of `PartialTotal`, both driven by a provisional count. They do not replace or hide the figure.
- **Where.** The accounts list and its summary, the register header, the net worth hero, chart and report, the custom report viewer, the built-in reports whose rows can be transfer legs, the payee and category account panels, and budget transfer actuals.
- **Copy.** Reader-facing words are "estimated amount" and "includes estimated amounts". Keys live under a `provisional` name so they do not collide with the schedule estimate's keys.

Decided in issue #2397 (the badge and the action):

- One component, `ProvisionalAmountBadge` (`frontend/src/components/transactions/`), draws the label wherever a row's amount is drawn: the phone card, the desktop row's Amount cell, Folio's Payment or Deposit cell, the Pebble row and the Pebble inspector. It reads the flag through `isProvisionalAmount` (`frontend/src/lib/provisional-amount.ts`) as `=== true`, so a payload without the field is drawn as confirmed. Every register that renders `TransactionList` shows the badge.
- The action is offered only where a caller passes `onConfirmAmount`; today that is the Transactions page. The endpoint is the owner's alone: it carries no `@AllowDelegate()`, so `AccountDelegateGuard` refuses it to an acting delegate, and it is scoped to the caller's `user_id`. The list therefore offers it only outside a delegate session, on a row whose `userId` is the signed-in reader's, and never on a row of a joint account shared to the reader. Letting a delegate confirm would be a backend change (the route's delegate annotation) and a separate proposal.
- A refusal (most likely "not provisional", because the leg was confirmed elsewhere) is toasted and the page reloads, so the row shows the server's state.
- After the endpoint answers, the page marks the row confirmed in place, then reloads through `loadAllData`, the path the register's delete takes: the rows, the accounts the account widget reads (where F2's count will live), and the reload key the widgets refetch on. A reload that fails therefore leaves no stale badge. `transactionsApi.confirmAmount` drops the cached balance reads. A second click on the same row before the reload lands sends nothing.

Decided in issue #2398 (the mark and the note on accounts, the register header and net worth):

- `ProvisionalMark` (`frontend/src/components/ui/`) is a `≈` with an `InfoTooltip` saying how many estimates the figure includes and that `is:provisional` lists them. `PartialTotal` draws it through its optional `provisionalCount` prop, after the partial marker when there is one, so a figure that is both partial and provisional carries both. `ProvisionalDataNotice` (`frontend/src/components/reports/`) is the note counterpart of `PartialDataNotice`. Both read the count through `provisionalCountOf` (`frontend/src/lib/provisional-amount.ts`): an absent or unreadable count is `0` and draws nothing.
- A sum of balances sums its accounts' counts (`sumProvisionalCounts`): an account row (a folded pair counts both ledgers), a group header and the accounts page's summary cards. The register header (the bar and the full widget) reads the account's own count.
- Net worth reads the month's `provisionalCount`, `assetsProvisionalCount` and `liabilitiesProvisionalCount`: the hero, the widget's headline and the report's headline mark the newest month, and the report's table marks each month. The report's note takes the largest month's count, because a provisional leg stays in every month from its date on and a sum would count it once per month.

Decided in issue #2399 (the note and the mark on reports, panels and budgets):

- A count that covers one figure marks that figure; a count that covers several figures at once is a `ProvisionalDataNotice`, because the response does not say which figure holds the estimate. Marked: the custom report's headline (`PartialTotal` with the summary's count), each account row of the payee and category pages' account panels (`TopGroupsPanel` reads a row's `provisionalCount`), and on a currency's detail page the total in the currency and the reporting total while it is complete (a partial reporting subtotal leaves out rows with no rate, which may be the estimated ones, and the count does not say). Noted: the custom report (beside its headline mark, both read from one value), the payee and category info widgets (one summary count over income, expenses, net and the average; `summarizeInDisplayCurrency` returns the native count, or the conversion's count over the currencies that converted), the Cash Flow Sankey report and its dashboard widget, the Monthly Category Breakdown, each tag bucket's tagged transfer flows (Income vs Expenses and Cash Flow, under the inflow and outflow pair), and the budget dashboard (the summary's count over the transfer lines and transfer income).
- A clickable row is a `<button>` and `ProvisionalMark`'s tooltip trigger is one too, so the mark sits beside the row's button, never inside it. For the same reason the budget lines carry no per-line mark: the standard row is a button end to end, so the budget dashboard's note is the one surface for every UI style.

## 10. Test matrix

The discussion's ten scenarios, each owned by a task.

| # | Scenario | Where it is proven | Task |
| --- | --- | --- | --- |
| 1 | Only the confirmed side is in a report | `report-custom-transfer-fx.integration.spec.ts`, `report-transfer-fx-surfaces.integration.spec.ts` | B3 |
| 2 | Only the provisional side is in a report: the estimate, count 1 | The same two, plus the custom report unit spec | B7 |
| 3 | Both sides: net zero, count 1 | The same two | B7, B8 |
| 4 | No historical rate: the row is refused and the pair is named | `import-regular-processor.service.spec.ts`, an import integration spec | B2 |
| 5 | The actual amount differs from the estimate: amount replaced, balance moved by the difference, flag cleared | `import-regular-processor.service.spec.ts`, `import-qif-split-transfer.integration.spec.ts` | B2 |
| 6 | The description is edited or cleared: still provisional | Update, transfer-update and bulk-update specs | B4, B5 |
| 7 | A confirmed transaction says `PENDING IMPORT` in its description: still confirmed, still a posted counterpart | `transfer-counterpart.spec.ts`, `transfer-rate-sql.spec.ts`, importer lookup spec | B3 |
| 8 | A later import confirms the amount | Importer specs | B2 |
| 9 | The reader confirms by hand, by the action and by an amount edit | Confirm endpoint spec, transfer service spec, E2E | B5, E1 |
| 10 | The same for split transfers | Each of the above has a split case | B2, B3, B5 |

Balances and net worth: a provisional leg on an account gives that account, the accounts total and the net worth totals a count of 1; a void or future-dated one does not (B6).

## 11. Rollout

Each task is deployable on its own. The order matters in one place: the description note is retired (B4) only after the importer and both readers use the column (B2, B3), after the reader can see and find provisional rows without the text (F1, S1). The backfill is repeated in B2 and B4 because a release that still writes the note can create rows between migrations; each run is a no-op on rows it has already handled.

During the rolling deploy of B4 a pod of the previous release matches pending rows by the column already, so stripping the text does not blind it.

Decided in issue #2400 (B4): the third backfill was dropped. Confirming an amount (the action, or a transfer edit stating the leg's amount) clears the flag and keeps the note, so a confirmed leg and an unflagged leg an older release wrote look alike, and action history is pruned too soon to tell them apart; a backfill by the text would have undone the reader's confirmations. The migration instead cuts the exact note out of every transfer leg that holds it, flagged or confirmed, and leaves the flag. The restore flags by the text only for an artifact older than `20261125150107` (before the importer wrote the column, so before anyone could confirm), and strips the note from any artifact older than the strip migration. The accepted cost: a leg a release before B2 wrote during B2's rollout, after its repeat ran, stays confirmed and loses its note. The strip runs once at container start, so a pod of the previous release importing during B4's rollout still writes the note (beside a correct flag); a migration authored after B4 has deployed repeats the strip (task Q), a no-op on rows already handled, and until then that text is inert.

## 12. Scope cuts

1. A reader-settable "this amount is an estimate" toggle (discussions #253, #1797).
2. A manual, assistant or MCP cross-currency transfer saved without a received amount is priced at the market rate by `resolveTransferFx` and is treated as confirmed: the reader saw the figure in the form. Marking those provisional is a separate proposal.
3. The Money importer's cross-currency trades priced at a market rate, and the KMyMoney importer's zero-amount legs with no rate: each has its own import warning and neither uses the marker.
4. The duplicate-merge flow (import and bank sync) matches on equal amounts and does not replace an amount, so a bank row does not confirm a provisional leg. Unchanged.
5. A separate "estimated" subtotal on reports.
6. Flagging the confirmed side's market-rate conversion while its counterpart is provisional. The confirmed amount is a fact; its conversion is an estimate in the same sense as any foreign row's.

## 13. Open questions

Each has a recorded default that the tasks implement; the maintainer may reverse one on its sub-issue before it is dispatched.

1. Reader-facing wording: "Estimated amount" / "Includes estimated amounts" (default) or "Provisional".
2. Scope cut 6: flag only a figure that contains the provisional leg itself (default), or also one that contains only its confirmed side.
3. The confirm action on a leg whose estimate the reader accepts leaves the stored rate as the importer wrote it (default), rather than recomputing it from the two amounts.
4. Whether the import result should count the provisional legs it created. Default: no new field; the badge and `is:provisional` are the way to find them.

## 14. Delivery

The build was one task per agent session and one PR per task, each based on `main`. Deploy classes: none (tests and docs), inert (a column, a field or an endpoint that changes no figure), neutral (rewrites a live path and preserves its behaviour), visible (changes a figure, a stored value or what a reader sees). Only B2 changed stored figures for new imports and only B4 rewrote existing descriptions.

| Task | Issue | What it delivered | Class |
| --- | --- | --- | --- |
| B1 | #2389 | The column, backfill, entity, support-backup rule, action-history column lists | inert |
| B2 | #2390 | The importer writes and matches the column; the plain path estimates at the historical rate and refuses without one | visible |
| B3 | #2391 | Both report readers read the column | neutral |
| B5 | #2392 | Confirm-amount endpoint, the transfer-edit rule, clearing when a leg stops being a transfer leg, undo | inert |
| S1 | #2393 | `is:provisional` in the transaction search | inert |
| B6 | #2394 | Provisional count on balances and net worth | inert |
| B7 | #2395 | Provisional count on custom reports, analytics, the assistant and MCP | inert |
| B8 | #2396 | Provisional count on built-in reports that read transfer legs, and budget transfer actuals | inert |
| F1 | #2397 | The row badge and the Confirm amount action | visible |
| F2 | #2398 | The mark and note on accounts, the register header and net worth | visible |
| F3 | #2399 | The note on custom reports, built-in reports, panels and budgets | visible |
| B4 | #2400 | The description note retired: not written, stripped, restore normalization, guard | visible |
| E1 | #2401 | End-to-end spec (import, badge, confirm) | none |
| Q | #2402 | Acceptance: every locale, website docs, release note, invariants catalogued, plan retired, the strip repeated | none |

Task Q also added `20261126180000_transactions_strip_pending_import_note_repeat.sql`, the strip of B4 repeated for legs a pod of the previous release wrote with the note during B4's rollout (decided on issue #2400). It is never a repeat of the flag backfill.
