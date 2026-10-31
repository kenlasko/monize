# Shared expense consumer audit

Current delivery boundary: `docs/specs/shared-expenses-ui-polish.md` section 0
supersedes the private-finance creation and Transactions handoff behavior below.
New booking is deferred; existing private records remain readable/unlinkable.
The accounting definitions below are retained for those accepted records.


This accompanies the [approved specification](shared-expenses.md) and
[invariants SE-001 through SE-012](../system-invariants.md#shared-expenses).
It describes the implementation's data sources, not a claim that every test
listed below has passed on every revision. The current verification record is
[the task list](../future-plans/shared-expenses-tasks.md).

## Two sources, with an explicit acceptance boundary

The group journal answers what the participants agreed. Private transactions
answer what the account owner accepted into Monize. `SharedReviewService` uses
`sharedReviewState` to compare each participant's current financial effect with
the fingerprint in their accepted posting. A note-only edit does not require
another booking. A changed share, payment, date, currency or reversal does.

An unaccepted change does not alter account balances, budgets or reports. The
global financial-page banner and `/shared-expenses/review` disclose that boundary
with a pending count and a link to the affected group's private review. Only
changes to accepted postings require financial review. An unbooked entry remains
an optional addition, including when its group rate is missing; it does not
contribute to the pending count. A successful zero-pending, zero-unavailable
check displays no banner, even with connected groups. Future-only unbooked drafts
do not count as a current booking. Revoked groups have a separate unavailable
count because their latest financial state cannot be checked. A request failure
has an error and retry action, never an invented zero count.

No consumer adds a live group position to an accepted settlement-account balance.
That would count the same claim twice and mix two different acceptance dates.

## Surface mapping

| Surface | Source and interpretation | Disclosure / verification |
| --- | --- | --- |
| Group overview, balances, activity and CSV | `shared-journal.ts`, `shared-balances.ts` and `shared-summary.ts`; persisted allocations and frozen rate tuples, separate known subtotal when FX is incomplete | Currency and incomplete-entry repair are part of the group result. Group CSV exports the journal, not private accounts. Numeric/summary tests and journal integration cover the calculations. |
| Register and account balance | Existing transactions; original matched bank ID stays in place. The transfer part points to the managed settlement account, while category-only residual splits retain their categories, notes and tags | The linked-row notice opens private review. Generic financial edits fail through the PSE01 database triggers, including bulk, rule, undo and model entry points. Booking integration reloads rows and balances. |
| Dashboard spending and income | Existing built-in report services and their transfer/split filters read accepted ledger rows | Shared activity uses Notifications; `SharedReviewContent` is confined to the explicit private review page. The dashboard shortcut opens groups; it does not inject journal amounts into dashboard totals. |
| Built-in spending, income and comparisons | `reportableTransactionAmountSql` excludes transfer/investment children; category reports net both signs. Managed settlement accounts have ordinary categorized consumption rows | A 300 payment with own share 100 reports cost 100. A subsequent repayment reports no income. The real-database booking/report case proves these amounts. |
| Cash Flow Sankey | Existing accepted cash flow, with settlement transfers named separately from consumption and ordinary income | `cash-flow-sankey-assembly.ts` names settlement flows; service tests check classification and conservation. Pending journal changes are available through Notifications and the explicit review page. |
| Budgets, period close and budget alerts | Existing budget spending query and category actuals read accepted ledger; configured excluded accounts stay excluded | Booking integration checks actuals 100, not 300, after the receipt and after repayment. Alerts use the same accepted ledger and do not create bookings from peer edits. |
| Custom reports and their exports | `ReportsService.narrowSplitLines` applies transfer selection at split granularity; `report-net-cells.ts` computes categorized signed cells | Existing account/category/date scopes retain their meaning. A report restricted to bank accounts excludes own costs booked in settlement accounts. Review-page copy explains how to include those accounts. No hidden live-group expansion of the report's scope. |
| Net worth and account history | Existing opening balances and accepted ledger movements include the managed receivable/payable once | Positive and negative settlement balances retain their sign. Net-worth tests cover the settlement account type; shared booking tests assert the source balance changes. Post-commit recomputation uses the existing invalidation entry point. |
| Account forecast | `BalanceForecastService` starts from the accepted ledger at today's close, then reads actual future transactions and resolved scheduled occurrences | Group repayment suggestions are not forecast cash. Database target triggers prevent scheduling on the managed settlement account; a real future payment belongs to an ordinary payment account. |
| AI financial tools | `ToolExecutorService` annotates the five names in `SHARED_LEDGER_TOOLS` through `SharedReviewService` | Context states accepted-booking basis, pending/unavailable counts and review URL; delegate context is owner-only without a group query. Service/executor tests exercise the same projection. |
| MCP tools and resources | Accounts, transaction list/comparison, budgets and reports adapters, plus financial summary and recent transactions resources, call that same annotation service | Model context omits group/account names and IDs. An unavailable review request has null counts and `REQUEST_FAILED`; it does not silently claim current finances. Adapter regression tests cover existing output branches. |
| Notifications | Shared activity produces generic group notices through the existing dispatch seam; private bank details are absent | Delivery receipts deduplicate events; recipient preferences and group mute apply. `MEMBER_REVOKED` exposes only the access-removal notice to the revoked recipient. Lifecycle integration covers this boundary. |
| Backup and support snapshot | `shared-backup.ts` captures an independent restore snapshot; restore remaps IDs and drops live grants/invitations | The live group and other participants' ledgers remain separate. Support rules redact private text; lifecycle integration restores both ordinary and support snapshots. |

## Numerical review fixture

With opening bank balance 1,000 and no existing claim, accepting a 300 payment
for a three-person equal expense yields bank 700, settlement account +200 and
own cost 100. A peer changing the accepted own share to 80 leaves those figures
unchanged while review is pending. After the owner accepts the new preview, the
settlement account becomes +220 and own cost 80, with bank still 700.

A 100 repayment received later moves bank to 800 and the accepted claim from
220 to 120; it creates no ordinary income. For a 350 bank basket containing a
300 shared expense, the extra 50 remains private consumption. Selecting portions
from pre-existing category splits must preserve their remaining metadata;
unlinking restores the original split IDs and values from `before_shape`.

The focused test files are
`backend/test/integration/shared-expenses-booking.integration.spec.ts`,
`backend/src/shared-expenses/shared-review.service.spec.ts`,
`backend/src/shared-expenses/shared-review-state.spec.ts`,
`backend/src/shared-expenses/shared-bank-splits.spec.ts` and
`frontend/src/components/shared-expenses/SharedReviewContent.test.tsx`.
The backend and frontend changed-test commands also select the modified adapter
and UI regression tests. PostgreSQL suites use one worker and no concurrent test
or build process, as required by the verification contract.
