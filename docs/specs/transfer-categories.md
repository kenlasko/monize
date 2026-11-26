# Spec: Transfer categories

Status: proposed for discussion #2387 (2026-11-26), pull request 1 of 5 in
`docs/future-plans/transfer-categories-tasks.md`. The maintainer's merge of this
document is the approval the later pull requests are held to. Nothing here is
built yet.

Governs: every path that writes a category onto a ledger row or a schedule, the
category type itself, and every read that shows a transfer by its category: the
Monthly Category Breakdown, custom reports, budgets, the register's category
filter and grouped totals, the category detail page, and the AI and MCP tools
that read them.

Read first: `docs/future-plans/transfer-categories.md` (the plan; its section 3
holds the maintainer's decisions, which this document does not reopen),
`docs/financial-semantics.md` section 2 ("Transfers"),
`docs/specs/split-line-equivalence.md` (a split line reads as the whole row it
stands for) and `docs/specs/budget-transfer-income.md` (the transfer income
lines and the `transfersInAsIncome` toggle, issue #2141).

## 1. Definitions

- **Category type**: `income`, `expense` or `transfer`. A child has its
  parent's type.
- **Transfer row**: a whole row with `is_transfer = true`, a split line with
  `transfer_account_id` set, or the whole row such a line creates in the other
  account. The same words cover a scheduled transfer, a scheduled split's
  transfer line and an override line of either.
- **Category row**: any other row or line that can hold a category: an ordinary
  row, a split's category line, a scheduled ordinary transaction, a scheduled
  split's category line. A split parent and an investment line hold no
  category, as today.
- **Fits**: a category of any type fits a transfer row; only an `income` or
  `expense` category fits a category row; no category always fits.
- **The transfer's category**: for a transfer whose two legs one person owns,
  the one category both legs hold. For a split's transfer line, the line's
  category, which its linked row holds too. A transfer between two owners has
  one per owner: each leg holds its owner's.
- **A category write**: a request whose category differs from the stored
  category of the leg it names. A request that resends the stored value writes
  no category (`AGENTS.md`: "a change is a value difference, not a field being
  present").
- **Outgoing, incoming, net** of a set of transfer legs in a scope: the sum of
  the negative legs as a magnitude, the sum of the positive legs, and the
  signed sum of all of them (positive when more arrived than left).

## 2. Invariants

Each is in `docs/system-invariants.md` as `unenforced` until the pull request
that builds its mechanism moves it.

| ID | Working name | Statement | Built in |
|---|---|---|---|
| INV-CATEGORY-001 | FIT | No category row holds a Transfer category | PR 3 (service helper, matrix); the database backstop with the type in PR 2 (section 13) |
| INV-CATEGORY-002 | ONE | A category write on a transfer sets both of its legs to that category (a split's transfer line and its linked row likewise); across two owners it sets the writer's leg only. Legs that differed before this work keep their values until the next category write | PR 3 |
| INV-CATEGORY-003 | TYPE | A category's type equals its parent's, and `is_income` equals `type = 'income'` while the column exists | PR 2 |
| INV-CATEGORY-004 | READ | "Expense" is read as `type = 'expense'`, never as "not income" | PR 2 |
| INV-REPORT-003 | unchanged | A transfer leg is never income, expenses or net. Its entry is amended in PR 4 to name the breakdown's Transfer category rows and the custom report's transfer measure as named flows | PR 4 |
| INV-REPORT-004 | amended | Under a transfer measure, a category's transfer legs net within that category (section 8); otherwise transfers are still not netted | PR 4 |

## 3. The fit table

| What holds the category | Transfer | Income or Expense | None |
|---|---|---|---|
| A whole transfer leg | fits | fits (as today) | fits |
| A split's transfer line, and its linked row | fits | fits | fits |
| An ordinary row | refused | fits | fits |
| A split's category line | refused | fits | fits |
| A scheduled transfer, a scheduled split's transfer line, an override of either | fits | fits | fits |
| A scheduled ordinary transaction, a scheduled split's category line, an override of either | refused | fits | fits |
| A payee's default category | refused | fits | fits |
| A loan's interest category and its fee categories | refused | fits | fits |
| An asset account's asset category (the QIF, OFX and CSV importer writes it on the account's ordinary rows) | refused | fits | fits |
| A loan's principal and overpayment categories (settings the loan views match rows against; no path writes them onto a row) | fits | fits | fits |
| A rule's `set_category` action, a budget line, a custom report filter | any type; whether it fits is decided for each row it reaches | | |

A refusal answers 400 with a translated message naming the category ("Savings
contributions is a Transfer category; it can go only on a transfer"). It runs
inside the transaction that would write, before the first write
(`docs/financial-calculation-contract.md` section 7). Where a command applies to
many rows and the plan says so (bulk edit, a rule run), the rows the category
does not fit are skipped with a reason rather than refusing the command.

## 4. Truth tables by entry point

Each row gives the outcome with a Transfer category, an Income or Expense
category, and none. "Both legs" means the transfer's two legs when one person
owns them, and the writer's leg only across two owners. "(today: ...)" marks a
row whose current behaviour this work changes; every other outcome is what the
code does now. The code was located by symbol on 2026-11-26.

### 4.1 Transactions and transfers

| Entry point | Code | Transfer | Income or Expense | None |
|---|---|---|---|---|
| Create a transaction: `POST /transactions`, bulk create's ordinary rows, quick-add's save | `createWithOutcome` in `backend/src/transactions/transactions.service.ts` | refused | written | written; the payee's default category applies as today |
| Create a transfer: `POST /transactions/transfer`, bulk create's transfer rows, assistant and MCP `create_transfer` | `prepareTransfer`, `transferLegColumns` (`backend/src/transactions/transfer-leg-columns.ts`) | both legs | both legs | none on either |
| Edit a transfer: `PATCH /transactions/:id/transfer`, assistant and MCP `update_transfer` | `updateTransfer` in `backend/src/transactions/transaction-transfer.service.ts` | both legs | both legs | both cleared |
| Edit the linked row of a split's transfer line through the transfer route | `updateSplitTransferLeg` | the row and the line (today: the row only) | the row and the line (today: the row only) | both cleared |
| Plain patch of an ordinary row: `PATCH /transactions/:id` | `TransactionsService.update` | refused | written | cleared |
| Plain patch of a transfer leg | same | both legs (today: the named leg only) | both legs (today: the named leg only) | both cleared (today: the named leg only) |
| Plain patch of the linked row of a split's transfer line | same | the row and the line (today: the row only) | the row and the line (today: the row only) | both cleared |
| Bulk update: `POST /transactions/bulk-update` | `backend/src/transactions/transaction-bulk-update.service.ts` | written to each selected transfer leg and its other leg; each selected category row is skipped with a reason | every selected row; a transfer's other leg follows (today: the selected leg only) | every selected row cleared; a transfer's other leg follows (today: the selected leg only) |
| Convert to a transfer: `POST /transactions/:id/convert-to-transfer` | `convertToTransfer` in `backend/src/transactions/transaction-conversion.service.ts` | both legs | both legs | none on either: a request naming no category clears the row's, as today |
| Convert to a transaction: `POST /transactions/:id/convert-to-transaction` | `convertToTransaction` | the kept leg's Transfer category is cleared in the same statement that clears `is_transfer`; a request naming a Transfer category is refused (today: the kept leg keeps any category) | kept, as today; a request may name another | none |
| Reassign: `POST /categories/:id/reassign` | `reassignTransactions` in `backend/src/categories/categories.service.ts` | to a Transfer category: refused, nothing moved, when any row, line or schedule it would move is a category row | to an Income or Expense category: as today, transfers included | -- |

The structural fields of a transfer leg (amount, account, date, rate) stay
refused on the plain patch, as `assertNoStructuralTransferLegEdit` does today;
only the category gains a second leg. `JointRegisterService.assertPlainRow`
keeps refusing transfer rows on the joint register.

### 4.2 Splits

| Entry point | Code | Transfer | Income or Expense | None |
|---|---|---|---|---|
| Create or replace a split: `PUT /transactions/:id/splits`, a patch carrying splits, a rule's split | `updateSplits`, `createSplitsInternal` in `backend/src/transactions/transaction-split.service.ts` | a transfer line: the line and its linked row (today: dropped silently); a category line: refused | either kind of line: written; a transfer line's linked row follows (today: a transfer line's category is dropped) | none |
| Add a line: `POST /transactions/:id/splits` | `addSplit` | a transfer line: the line and the row it creates (today: the insert fails on `chk_split_kind_exclusive`); a category line: refused | same as Transfer for a transfer line; a category line: written | none |
| Remove a line, leaving two or more | `removeSplit` | no category is written; a removed transfer line's linked row is deleted, as today | | |
| Remove a line, leaving one | same | the remaining transfer line: the parent becomes a transfer holding the line's category, and its linked row already holds it (today a transfer line holds none, so the parent gets none) | the remaining transfer line: as Transfer; the remaining category line: the parent takes its category, as today | none |
| Bulk recategorize a split parent | `bulkRecategorizeCategorySplits` | its category lines are skipped with a reason; its transfer lines are not touched, as today | its category lines, as today | its category lines cleared |

### 4.3 Scheduled transactions

| Entry point | Code | Transfer | Income or Expense | None |
|---|---|---|---|---|
| Create or update a scheduled transfer | `backend/src/scheduled-transactions/scheduled-transactions.service.ts` | kept | kept, as today (issue #743) | none |
| Create or update a scheduled ordinary transaction | same | refused | written | written |
| Switch a schedule from transfer to ordinary | same | the Transfer category is cleared in the same write, on the schedule and on each of its overrides (`category_id` and every split JSON line) | kept | -- |
| A scheduled split's lines | `createSplits` | a transfer line: kept (today: dropped silently); a category line: refused | either kind: kept (today: dropped on a transfer line) | none |
| An override's category and split lines | `buildOverrideSplits` in `backend/src/scheduled-transactions/scheduled-transaction-override.service.ts` | fits the schedule's kind, or each line's kind; refused where it does not (today: stored as sent) | stored | stored |
| Post an occurrence | `post` | a transfer: both legs (the inline value, then the override's, then the schedule's, as today); a split's transfer line: the line and its linked row (today: dropped); a line that does not fit refuses the post and the occurrence stays due | same | none |

The category written at schedule, split and override time is also checked for
ownership, which the sweep found missing at write time (only the post checks
it today). The fit helper checks ownership and fit together. The database
backstop checks an override's `category_id` when the override is written, not
when its schedule changes kind; the switch above is held by the service, and a
line that still does not fit is refused at the post.

### 4.4 Automation

| Entry point | Code | Transfer | Income or Expense | None |
|---|---|---|---|---|
| Rule `set_category` | `refusal` in `backend/src/transaction-rules/rule-effects.ts` | a transfer leg: both legs, and a split's transfer line's linked row with its line (today: refused, `row_is_transfer_leg`); a category row: skipped with a reason that names the type; a split parent: refused, as today | a category row: written; a transfer leg: both legs (today: refused) | -- (the action always names one) |
| Rule `convert_to_transfer` | `convertRowToTransfer` in `backend/src/transactions/convert-to-transfer.ts` | the action may name one: both legs | named, or kept with `clearCategory: false`: both legs (today: the kept row only, the new leg gets none) | `clearCategory: true` (the default): none on either, as today |
| A rule that settles a loan installment | `backend/src/loan-installments/plan-loan-settlement.ts` | the interest line: refused, through the loan's own check; a principal transfer line: the template's value | the template's values | none |
| Assistant and MCP `create_transaction`, `update_transaction` on a category row | `backend/src/transactions/transaction-tool-prep.service.ts`, `backend/src/mcp/tools/transactions.tool.ts` | refused; the tool result says why | written | written |
| Assistant and MCP `update_transaction` on a transfer | routed to the transfer edit | both legs | both legs | both cleared |
| Assistant and MCP bulk and each-row updates | `prepareUpdateBulk` | transfers are skipped, as today; category rows are skipped with the reason | as today | as today |
| Assistant categorize action | `executeCategorize` in `backend/src/ai/actions/ai-actions.service.ts` | as the plain patch (nothing outside its spec builds the action today, `buildCategorizeTransaction`) | | |

A category a person or a model names by text (a rule's path, a tool's category
name, an import's category path) resolves among the categories that fit the row
it lands on; on a transfer, a Transfer category of that path is preferred.

### 4.5 Importers and other writers

| Entry point | Code | Transfer | Income or Expense | None |
|---|---|---|---|---|
| QIF, OFX and CSV | `processTransaction` in `backend/src/import/import-regular-processor.service.ts` | a category row whose path names only a Transfer category is imported uncategorized and counted in the result as a category that did not fit | category rows: as today | a transfer gets no payee default (today: the payee's default lands on this file's leg only) |
| Microsoft Money (.mny) | `backend/src/import/mny/map/map-transactions.ts` | Money has no Transfer type, so the importer creates none | a transfer: the file's category written to both legs; when the file's two legs differ, the outgoing leg's (today: each leg its own) | none |
| KMyMoney | `backend/src/import/kmy/map/kmy-row-builder.ts` | -- | -- | transfers get none, as today |
| Bank sync | `backend/src/bank-sync/bank-sync-writer.service.ts` | -- | ordinary rows take the payee default, as today | -- |
| Email receipts | `backend/src/ai-review/ai-review-work.service.ts` | category lines only: refused | as today | as today |
| Shared expenses posting | `backend/src/shared-expenses/shared-finance-write.ts` | category lines: refused | as today | the bank row and its counterpart hold none, as today |
| Payee default: create, update, backfill, apply to all | `backend/src/payees/payee-backfill.util.ts` | refused | as today; never applied to a transfer (backfill and apply to all already exclude them) | as today |
| Loan setup: interest and fee categories | `assertLoanInterestCategory` (`backend/src/accounts/loan-interest-category.ts`), `assertLoanFeeCategories` (`backend/src/loan-fees/loan-fee-terms.ts`) | refused (today: ownership only) | as today | as today |
| Backup restore | `backend/src/backup/backup-restore-database.service.ts` | restored as stored; a file whose category row holds a Transfer category is refused whole by the database backstop | as stored | as stored |
| An API create retried with its `externalId` | `findOwnTransferByExternalId` | writes nothing, as today | | |

### 4.6 Category management

| Change | Outcome |
|---|---|
| A category, or a parent and its subtree, becomes Transfer | refused while a category row, a scheduled category row, an override line on one, a payee default, an asset account's asset category or a loan's interest or fee category holds it or a descendant |
| A Transfer category becomes Income or Expense | allowed: every holder is a transfer row, and a transfer accepts any type |
| Which overrides count as holders | only those that can still post (`original_date` on or after the schedule's `next_due_date`), as the account-delete count reads them: a spent override never posts and is not shown, so counting it would refuse the change with no way out |
| Moving a category under a parent of another type | the child takes the parent's type (INV-CATEGORY-003), under the same refusal as a type change |
| Delete | as today: refused while anything references it |

A type change invalidates, after its commit, the cached actuals of every budget
with a line on the category or its subtree, because the overlap rule of section
6.3 reads the type (INV-CACHE-001).

### 4.7 Undo

| Undo of | Outcome |
|---|---|
| A transaction update that wrote both legs | both legs return to their recorded values, which may differ, as they may have before the write |
| A bulk update | every row the update wrote, other legs included |
| A transfer create or delete | both legs as recorded, as today |
| A transaction delete with split lines | each line returns with its `kind` (`backend/src/action-history/action-history.service.ts`; today the restore names no `kind`, so a transfer line would default to `category`; reported by the sweep, not reproduced) |
| A rule run | both legs of a `set_category` on a transfer (`backend/src/action-history/rule-run-undo.ts`) |
| Anything that would put a Transfer category on a category row | refused; it cannot arise without a conversion, whose undo is already refused (`assertConversionUndoable`) |

### 4.8 One category per transfer, in detail

- The legs are written in one transaction, locked in the order
  `docs/concurrency-and-idempotency.md` section 5 sets: transactions before
  splits, a transfer's two legs in ascending account id.
- Across two owners each leg is its owner's: the writer's leg is set, and the
  other owner's is neither read nor written. `transferLegColumns` already gives
  a cross-owner leg no category on create.
- Legs that differ today (the plain patch, bulk update, a QIF import or a rule
  conversion wrote one) keep their values until the next category write, which
  sets both. Opening the transfer form on such a transfer and saving without
  changing the category writes no category (section 1, "a category write").
- A category write never moves money, so it changes no balance and invalidates
  only what a category change invalidates today.

## 5. What stays exactly as it is

A transfer holding an Income or Expense category is counted where it is
counted today, and every figure below is the same before and after this work.
This is also the regression fixture: with no Transfer category in the data,
every report, budget and import returns what it returned before.

Fixture, all in CAD, one person, March 2026. Expense category "Investments".

| Row | Account | Amount | Category |
|---|---|---|---|
| F | Chequing | -20 | Investments (a brokerage fee) |
| T1 | Chequing | -1,000 | Investments (transfer out) |
| T2 | Brokerage | +1,000 | Investments (T1's other leg) |

| Surface | Scope | Figure |
|---|---|---|
| Register filtered by Investments | Chequing | F and T1, filtered total -1,020 |
| Register filtered by Investments | all accounts | F, T1, T2, filtered total -20 |
| Grouped totals by category (`getGroupedTotals`) | Chequing | Investments -1,020 |
| Grouped totals by category | all accounts | Investments -20 |
| Category detail, Investments | all accounts | 3 transactions |
| Budget line on Investments, Brokerage excluded | budget accounts | spent 1,020 |
| Budget line on Investments, Brokerage in the budget | budget accounts | spent 20 |
| Custom report, by category, Expenses only, Include transfers | all accounts | Investments 1,020 (F's cell 20 and T1's cell 1,000; T2's cell is not spending) |
| Custom report, by category, Both, Include transfers | all accounts | Investments 2,020 (each transfer leg is its own cell, `backend/src/reports/report-net-cells.ts`) |
| Custom report without Include transfers, Spending by Category, Income vs Expenses | any | Investments 20 |
| Monthly Category Breakdown | all accounts | Investments row 20; Transfers group: Chequing out 1,000, Brokerage in -1,000 |
| Cash Flow Sankey | Chequing | expenses: Investments 20; outflow to Savings & investments 1,000 |

A budget line on an Expense category and a per-account transfer line naming
the same destination both count such a transfer, today and after: the overlap
rule of section 6.3 applies only to a Transfer category. A person who wants it
counted once moves the transfer to a Transfer category.

## 6. Budgets

### 6.1 A line on a Transfer category

A budget line may name a Transfer category, as an outgoing line or an income
line (`budget_categories.is_income`, which stays the line's own column). Its
actual is read exactly as a category line's is today
(`queryCategorySpending`, `backend/src/budgets/budget-spending.util.ts`): the
signed net of the rows and split lines holding that category, in the budget's
accounts, in the period, VOID excluded, converted into the budget's currency.
An outgoing line reads `max(-net, 0)`, an income line `max(net, 0)`. The
category is matched by its own id, with no roll-up of subcategories, as every
category line is today.

A transfer between two budget accounts holding the category nets to zero on
its line: money that stayed inside the budget left nothing. A transfer that
left for an excluded account reads its full amount.

An outgoing line on a Transfer category is an expense-side line like a
per-account outgoing transfer line: it counts in `totalBudgeted` and
`totalSpent`.

### 6.2 The three funding figures

For one budget and period, with each line's actual as above (clamped as today):

- **Actual Income** is the sum of the actuals of the income lines that name an
  Income or Expense category. A transfer holding an Income category under such
  a line is in it, as it is in the line today.
- **Transfer Funding** is the sum of the actuals of the transfer income lines
  (per account, issue #2141) and of the income lines that name a Transfer
  category, plus the `transfersInAsIncome` figure, clamped as today.
- **Total Budget Funding** is Actual Income plus Transfer Funding. It is the
  figure the summary calls `totalIncome` and the period close stores as
  `actual_income` today, unchanged for a budget with no Transfer category line.

Every surface that shows one income figure today (the summary, the
income-shortfall alert, the savings rate, the trend and health reports, the
assistant and MCP) keeps the figure it shows, an income line on a Transfer
category counted wherever a transfer income line is; the surfaces that list
income add the two parts beside the total. The income-linked base
(`resolveBudgetIncome`) still nets the signed figures of every income line,
Transfer category income lines included, and clamps the whole, as today.

### 6.3 The overlap rule: the category line wins

A transfer leg holding a Transfer category that has a line in the budget is
counted on that line and left out of every per-account transfer line (outgoing
or income) and out of the `transfersInAsIncome` figure. A leg holding a
Transfer category with no line in the budget is counted by the per-account
lines exactly as an uncategorized transfer is today. The leg's own category
decides (`t.category_id` for a whole leg, `s.category_id` for a split line).

The category line takes the transfer whichever way it moves: an outgoing line
on "Savings contributions" nets a withdrawal back from savings against the
contributions, and that withdrawal is not Transfer Funding. A person who wants
withdrawals counted as funding gives them a category of their own.

### 6.4 Truth table

Budget accounts: Chequing, Credit card. Excluded: HISA, Mortgage, Brokerage.

| Period's transfer | Its category | Lines in the budget | Counted on |
|---|---|---|---|
| Chequing -> HISA 500 | Transfer: Savings contributions | outgoing line on it, and "Transfers to HISA" | its line 500; the HISA line 0 |
| Chequing -> HISA 500 | Transfer: Savings contributions | "Transfers to HISA" only | the HISA line 500 |
| Chequing -> HISA 500 | Transfer: Savings contributions | outgoing line on it only | its line 500 |
| Chequing -> HISA 500, then HISA -> Chequing 300 | Transfer: Savings contributions, both | outgoing line on it, and "Transfers from HISA" | its line 200; the income line 0 for both |
| Chequing -> Credit card 800 | Transfer: Card payments | outgoing line on it | 0 (both legs are in the budget) |
| Chequing -> Mortgage 1,500 | Expense: Mortgage | line on Mortgage, and "Transfers to Mortgage" | both 1,500, as today |
| HISA -> Chequing 1,000 | Transfer: Reserve draws | income line on it, and "Transfers from HISA" | its line 1,000, in Transfer Funding; the HISA line 0 |
| Brokerage -> Chequing 400, toggle on, no line names Brokerage | Transfer: Reserve draws | income line on it | its line 400; the toggle 0 for it |
| Brokerage -> Chequing 250, toggle on | none | none naming Brokerage | the toggle 250 |
| Chequing -> HISA 500, VOID | any | any | nothing |

### 6.5 Numerical example

One budget, CAD, monthly, `transfersInAsIncome` on, accounts and exclusions as
in 6.4.

| Line | Kind | Planned |
|---|---|---|
| L1 Salary | income, Income category | 5,000 |
| L2 Groceries | expense | 600 |
| L3 Mortgage | expense, Expense category | 1,600 |
| L4 Savings contributions | outgoing, Transfer category | 500 |
| L5 Transfers to HISA | outgoing, per account | 300 |
| L6 Transfers from HISA | income, per account | 1,000 |
| L7 Reserve draws | income, Transfer category | 400 |

| Row in the period | Counted on |
|---|---|
| a. Salary +5,000 | L1 5,000 |
| b. Groceries -450 (Credit card) | L2 450 |
| c. Chequing -> Mortgage 1,500, Expense: Mortgage | L3 1,500 |
| d. Chequing -> HISA 500, Transfer: Savings contributions | L4 500 |
| e. Chequing -> HISA 200, no category | L5 200 |
| f. HISA -> Chequing 1,000, no category | L6 1,000 |
| g. Brokerage -> Chequing 250, no category | toggle 250 |
| h. Brokerage -> Chequing 400, Transfer: Reserve draws | L7 400 |
| i. Chequing -> Credit card 800, Transfer: Card payments | nothing (no line, both accounts in the budget) |

| Figure | With the overlap rule | Without it | Today (d and h uncategorized, no L4, no L7) |
|---|---|---|---|
| L5 Transfers to HISA | 200 | 700 | 700 |
| Toggle | 250 | 650 | 650 |
| Actual Income | 5,000 | 5,000 | -- |
| Transfer Funding | 1,000 + 400 + 250 = 1,650 | 1,000 + 400 + 650 = 2,050 | -- |
| Total Budget Funding (`totalIncome`) | 6,650 | 7,050 | 6,650 |
| `totalSpent` (L2 + L3 + L4 + L5) | 450 + 1,500 + 500 + 200 = 2,650 | 3,150 | 450 + 1,500 + 700 = 2,650 |
| `totalBudgeted` | 600 + 1,600 + 500 + 300 = 3,000 | 3,000 | 2,500 |
| Income-linked base | max(5,000 + 1,000 + 400 + 250, 0) = 6,650 | 7,050 | 6,650 |

Without the rule, d and h would each count twice. With it, moving d and h to
Transfer categories with lines of their own moves figures between lines and
leaves both totals where they were.

### 6.6 Period close

The close stores, beside `actual_income` (Total Budget Funding, unchanged), the
Transfer Funding part. A closed period's Actual Income is `actual_income` less
that part. A period closed before the upgrade has no stored part: section 10.

## 7. Monthly Category Breakdown

The Transfers group lists, first, each Transfer category that holds a transfer
in scope, with its tree, then the per-account rows for every other transfer,
including one holding an Income or Expense category (decision 6). Each leg is
counted once, on one row. A Transfer category has an outgoing row and an
incoming row, as an account does, so a transfer whose two legs are both in
scope still shows what moved: a single net row would read zero for every
contribution between two accounts in scope, which is the view issue #740 asked
for. Rows use the group's existing signs: outgoing positive (a source of
funds), incoming negative. A parent's rows sum its children's, per direction.
The group's total, the summary's transfer line and the overall line are the
figures of today, because every leg is still in the group exactly once.
Category rows, income, expenses and balance never include a transfer
(INV-REPORT-003); a split's transfer line is already excluded from the
category rows (`backend/src/built-in-reports/monthly-category-breakdown.service.ts`).

Example, CAD, March 2026:

| Transfer | Category |
|---|---|
| Chequing -> HISA 500 | Transfer: Savings contributions |
| HISA -> Chequing 200 | Transfer: Savings contributions |
| Chequing -> HISA 100 | none |
| Chequing -> Mortgage 1,500 | Expense: Mortgage |

| Row | Today, all accounts | After, all accounts | Today, Chequing only | After, Chequing only |
|---|---|---|---|---|
| Savings contributions, outgoing | -- | 700 | -- | 500 |
| Savings contributions, incoming | -- | -700 | -- | -200 |
| Chequing, outgoing | 2,100 | 1,600 | 2,100 | 1,600 |
| Chequing, incoming | -200 | -- | -200 | -- |
| HISA, outgoing | 200 | -- | -- | -- |
| HISA, incoming | -600 | -100 | -- | -- |
| Mortgage, incoming | -1,500 | -1,500 | -- | -- |
| Group total | 0 | 0 | 1,900 | 1,900 |

The transfer form's hint, `CreateTransferDto` and the MCP tool text say today
that a category puts a transfer in the breakdown, which has never been true;
PR 4 makes it true for a Transfer category and PR 5 corrects the text
(`frontend/src/components/transactions/TransferTransactionFields.tsx`).

## 8. Custom reports

### 8.1 Filters and grouping

A Transfer category may be chosen in a report's category filter and is a
group of its own when grouping by category. It holds only transfer legs, so
without Include transfers or a transfer measure it matches nothing; the
builder turns Include transfers on when one is chosen, and the server does not
infer it (a saved report means what it says).

With Include transfers and no measure, every report reads transfer legs as
today: each leg is its own cell, judged by the report's direction, under the
category it holds. A Transfer category is one more category there.

### 8.2 The transfer measure

The report configuration gains `transferMeasure`: absent, `OUTGOING`,
`INCOMING` or `NET`. Every saved report has none and returns the figures it
returns today.

With a measure, the report reads transfer legs only: whole transfer legs and
split transfer lines (INV-REPORT-006), whatever category they hold, in the
report's account scope and filters. The direction and Include transfers do not
apply to it, and the builder hides them. One cell per (group, category) holds
the legs; `OUTGOING` reads the negative legs as a magnitude, `INCOMING` the
positive legs, `NET` the signed sum. Legs holding no category are a "No
category" group, never mixed with ordinary uncategorized rows. COUNT counts the
legs a measure reads; AVERAGE divides the figure by that count; BUDGET_VARIANCE
is refused with a measure (400); metric NONE lists the legs the measure reads,
each with its own sign, under the existing signed-list rule
(`frontend/src/lib/custom-report-measure.ts`).

Each leg converts as it does today (`createConverter`,
`backend/src/reports/transfer-counterpart.ts`): at the transfer's own two
amounts when the other leg is in the reporting currency, so the two legs are
equal and opposite; otherwise at its own rate or the market rate on its date
(INV-FX-002), which can leave a residual.

### 8.3 Numerical example

Accounts Chequing and HISA in CAD, Brokerage in USD. Reporting currency CAD.

| Transfer | Category |
|---|---|
| Chequing -> HISA 500 | Transfer: Savings contributions |
| HISA -> Chequing 200 | Transfer: Savings contributions |
| Chequing -1,370 CAD -> Brokerage +1,000 USD | Transfer: Investment contributions |
| Chequing -> HISA 100 | none |

Grouped by category:

| Group | Scope | Outgoing | Incoming | Net |
|---|---|---|---|---|
| Savings contributions | all accounts | 700 | 700 | 0 |
| Savings contributions | Chequing | 500 | 200 | -300 |
| Investment contributions | all accounts | 1,370 | 1,370 (the USD leg at the transfer's own amounts) | 0 |
| Investment contributions | Brokerage | 0 | 1,370 | 1,370 |
| No category | all accounts | 100 | 100 | 0 |
| No category | Chequing | 100 | 0 | -100 |

Cross-currency with no leg in the reporting currency: the same Investment
contributions transfer reported in EUR, market rates on its date CAD->EUR
0.67 and USD->EUR 0.92. The Chequing leg reads -1,370 x 0.67 = -917.90, the
Brokerage leg +1,000 x 0.92 = +920.00.

| Scope | Outgoing | Incoming | Net |
|---|---|---|---|
| all accounts | 917.90 | 920.00 | +2.10 (the rate difference, not money that moved) |
| Chequing | 917.90 | 0 | -917.90 |

The same in EUR with no USD->EUR rate within `FX_MAX_RATE_AGE_DAYS`: section
10.

## 9. Other read surfaces

| Surface | After this work | Built in |
|---|---|---|
| Register category filter, grouped totals (`backend/src/transactions/transaction-analytics.service.ts`), MCP flow totals | a transfer holding a Transfer category, a whole leg or a split's transfer line, is listed and grouped under it, labelled a transfer; one holding an Income or Expense category is counted as today (section 5); a split's transfer line holding no category stays out of the grouped totals, as today, where it would read as Uncategorized. What a category filter matches changes on every surface at once (the register list and its totals, bulk update's filter selection, the balance windows, the search's category term), so a chart still adds up to the register list it sits on | PR 4 |
| Category detail (`backend/src/categories/category-detail.service.ts`) | a Transfer category shows outgoing, incoming and net, not spent or received; a split's transfer line holding the category is read (today the query drops every split transfer line) | PR 4 |
| The `income` and `expense` filter pseudo-ids | keep their meaning; a Transfer category is in neither; `transfer` keeps meaning every transfer | PR 2 |
| Income and expense reports, Spending by Category, Cash Flow Sankey | no change: transfers are already excluded or placed by account | -- |
| Loan payment detector (`backend/src/accounts/loan-payment-detector.service.ts`) | a line is the interest line only when it is not a transfer line (today: any line with a category that is not the loan's transfer line) | PR 3 |
| Assistant context and forecast | categories print their type; a scheduled transfer is not read as income because of its category | PR 3 |
| Every `isIncome` reader | moves to a typed helper (INV-CATEGORY-004); a Transfer category is never read as spending | PR 2 |

## 10. Missing-data policy

- **A budget period closed before the upgrade** stored one income figure. Its
  Transfer Funding part is unknown, not zero: the period shows the stored
  `actual_income` under its existing caption and no split. A period closed
  after the upgrade shows all three.
- **A budget line on a Transfer category with a leg that has no rate** follows
  the category line rule of today: its figure is the known subtotal, its
  category is named in `incompleteCategoryIds`, and `resolveCategorySpentOrNull`
  answers `null`. A total that includes it is withheld where the summary
  withholds one today.
- **A custom report under a transfer measure** follows the existing rule for a
  missing rate: a cell's currency part with an unconverted leg is left out
  whole, the summary's `total` is `null` with `knownTotal` named, and the gap
  names the currency. In the EUR example of section 8.3 with no USD->EUR rate,
  Investment contributions reads Outgoing 917.90 (its one leg converted),
  Incoming unknown, and Net unknown with -917.90 as its known part. A measure
  row with a part left out is marked incomplete in the response and labelled
  so on screen: a net missing one side is never shown as the net
  (INV-DISPLAY-002).
- **A transfer whose other leg the reader cannot see** (cross-owner, deleted,
  never linked) counts on its own account, as a leg does today
  (INV-SANKEY-002's "(unlinked account)").
- No figure defaults a missing rate to 1 or a missing category to a type.

## 11. Versioning, recomputation and the rolling deployment

- **Schema.** `category_type` is added and backfilled from `is_income` in PR 2
  (`true` to income; `false` and `NULL` to expense, the column being nullable),
  so every existing category is Income or Expense and every existing row
  already fits. `is_income` stays one release for the previous pods and is
  dropped later as a `contract-after` change; the API field `isIncome` stays,
  derived.
- **The type mirror** (INV-CATEGORY-003) is a categories trigger, because a
  pod of the previous release writes `is_income` alone and moves categories
  without knowing the type:
  - a category with a parent takes the parent's type on every insert and on
    every update of `parent_id`, whatever the write said (the current
    release's service refuses a request naming another type for a child);
  - a top-level write that sets the type sets `is_income` to `type = 'income'`;
    one that sets only `is_income` sets the type to income when true, and to
    expense when false unless it is already transfer;
  - a type change, a move included, cascades to the subtree, and each category
    that becomes transfer is checked against its holders (section 4.6) in the
    same statement.
- **Split constraints.** `chk_split_kind_exclusive` and
  `chk_scheduled_split_kind_exclusive` are relaxed so a transfer line may hold
  a `category_id`. The change only widens.
- **The previous release during a rollout** does not know the type: it reads a
  Transfer category as an expense (its `is_income` is false) and offers it in
  every picker. The database backstop (section 13) is what refuses its write
  of one onto a category row. A previous pod's figures are transiently wrong
  for a Transfer category, which no row could hold before the upgrade.
- **Sequencing.** The backstop ships with the type, in PR 2's migration, so
  that no release between PR 2 and PR 3 lets a category row take a Transfer
  category. Until PR 3's service refusal exists the backstop's SQLSTATE 23514
  must reach the client as a 400, not a 500. Neither refuses data that exists:
  no stored row holds a Transfer category, and an update whose values leave
  both the category and the row's kind as they were does not fire the
  trigger (its `WHEN` compares `OLD` and `NEW`, section 13.1).
- **Recomputation.** Reports and budgets read on request; nothing new is
  materialized except the period close's Transfer Funding part, frozen with
  the period like `actual_income`. Cached budget actuals are invalidated after
  a category write as today, and after a type change (section 4.6).
- **Backups.** The new column is classified for backup and support backup in
  PR 2. A backup from before the upgrade restores without conversion.

## 12. Concurrency

- **FIT against a type change.** The fit check, in the service helper and in
  the database backstop, reads the category row `FOR SHARE`. A type change
  updates the category row, which takes its row lock, and then checks its
  holders. Whichever commits first, the other sees it: a row write waits for a
  pending type change and then reads the new type; a type change waits for a
  pending row write and then sees the row. Without the lock both pass on their
  own snapshots. The foreign key's own `FOR KEY SHARE` does not conflict with
  an update of a non-key column, so it gives no protection here.
- **What the lock costs besides time.** The share lock is held to the end of
  the writing transaction, so any update of the category row itself (a
  rename, a colour, a move, a type change) waits for a running write that
  used it, a long import included. A category edit takes no ledger row lock,
  so this is a wait, not a deadlock. If the wait proves a problem, an advisory
  lock keyed by the category, shared in the trigger and exclusive in a type
  change, removes it for every edit but a type change; that variant was not
  measured.
- **ONE.** Both legs are written in one transaction, in the lock order of
  section 4.8. Two concurrent category writes to the two legs of one transfer
  serialize on the first leg; the later write sets both legs.
- **Retry.** A category write is idempotent: repeating it writes the same
  values, and a resent value is not a write at all.

## 13. Open questions, settled

| # | Question | Answer |
|---|---|---|
| Q1 | Must a Transfer category live under one "Transfer" parent? | **No, default confirmed.** The type is a field, so a required parent would say it a second time and need a guard of its own to keep the two in step. Top-level Transfer categories are useful ("Credit card payments"), and the unique key (user, name, parent) already lets a top-level Transfer category share a name with an Expense one. The default set for new users sits under one parent so it groups in pickers; nothing requires it. |
| Q2 | Is FIT also enforced in the database? | **Yes, default confirmed, as a `BEFORE` row trigger that locks the category `FOR SHARE` rather than as a constraint trigger.** Measured below. |
| Q3 | How are people told? | **A "What's new" entry and the release notes, default confirmed.** Nothing changes on upgrade, so there is nothing to tell any one person about their data; the entry says the type exists and how to move a transfer to one (edit, bulk edit, a rule). |

### 13.1 The Q2 measurement

The trigger checks a row only when it is a category row holding a category
(`NEW.category_id IS NOT NULL AND NEW.is_transfer IS NOT TRUE` on
`transactions`, the column being nullable; `NEW.transfer_account_id IS NULL`
on `transaction_splits`), on an insert, and on an update that changes the
category or the row's kind. The update trigger compares `OLD` with `NEW` in
its `WHEN`: `UPDATE OF` alone fires whenever a column is in the `SET` list,
even with the value it already had. The link back-patch of the Money import
and every update of other columns never fire it. The measured variants used
`NOT NEW.is_transfer` and `UPDATE OF` without the comparison; neither changes
an insert's cost.

Method: PostgreSQL 18.7 in a container on the development worker, the schema
of `database/schema.sql` with PR 2's `category_type` column and the relaxed
split constraint added, one user, 150 categories (100 expense, 20 income, 30
transfer). Each run starts from a fresh copy of the seeded database. Two import
shapes, each in one transaction:

- **Chunked**, as the Money importer writes
  (`backend/src/import/mny/writers/write-transactions.ts`, 500 rows per
  `INSERT`): 50,000 transactions (80% ordinary, 10% transfers, 10% split
  parents) and 10,000 split lines, of which 42,500 are checked (37,500 ordinary
  rows holding a category and 5,000 category lines).
- **Single-row**, as the QIF, OFX and CSV path writes: 5,000 one-row
  `INSERT` statements, 4,750 holding a category.

Median of five runs, the variants alternated; the database time of the
statements, not of a whole import (the application's per-row work is outside
it):

| Variant | Chunked, ms | vs none | Single-row, ms | vs none |
|---|---|---|---|---|
| Round 1: no trigger | 10,176 | -- | 2,334 | -- |
| Round 1: `BEFORE` row trigger, reads `NEW` | 11,034 | +8.4% | 2,597 | +11.3% |
| Round 1: constraint trigger, reads `NEW` | 10,931 | +7.4% | 2,483 | +6.4% |
| Round 1: constraint trigger, no `WHEN` filter | 11,146 | +9.5% | -- | -- |
| Round 2: no trigger | 10,464 | -- | 2,341 | -- |
| Round 2: constraint trigger, reads `NEW` | 11,232 | +7.3% | -- | -- |
| Round 2: constraint trigger, re-reads the row, locks the category | 12,959 | +23.8% | 2,979 | +27.3% |
| Round 2: `BEFORE` row trigger, locks the category | 10,691 | +2.2% | 2,537 | +8.4% |

Runs of one variant spread by 1 to 14% (23% once), mostly from one slow run,
so a difference of a few points between two variants is noise: the `BEFORE`
trigger without a lock measured slower than the one with it, which is not a
saving. A type change, checked by the categories trigger against a database
of 5,000 rows, took under 10 ms per statement, client overhead included.

Why not the constraint trigger the plan named. A constraint trigger is the
only kind that can be deferred, but a deferred check must re-read the row
(`NEW` is stale by commit), and every variant must lock the category to be
correct against a concurrent type change (section 12). That correct
constraint trigger cost a quarter of the insert time. The likely cause, not
isolated further, is the extra lookup of the row and the order of the locks:
the foreign key's check has already taken a weaker lock on the category when
the trigger asks for a stronger one, on every row. The `BEFORE` trigger takes
its lock before the foreign key's check runs, costs about what the variants
without a lock cost, and reads exactly the row being written.
What it gives up is deferral, which no path needs: a write that turns a
transfer into a category row (conversion, a schedule's switch) clears a
Transfer category in the same statement, and the integration matrix holds
that.

The shape PR 2 builds, for `transactions`; `transaction_splits` tests
`NEW.transfer_account_id IS NULL`, the two schedule tables do the same with
their own columns, and an override's `category_id` is checked against its
schedule's `is_transfer` (the override's split JSON is held by the service
only, and a line that does not fit is refused at the post at the latest):

```sql
CREATE FUNCTION refuse_transfer_category_on_category_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE category_kind text;
BEGIN
  -- FOR SHARE: a concurrent type change waits for this row, or this row for it
  SELECT c.category_type INTO category_kind FROM categories c
   WHERE c.id = NEW.category_id FOR SHARE;
  IF category_kind = 'transfer' THEN
    RAISE EXCEPTION 'a Transfer category goes only on a transfer'
      USING ERRCODE = '23514', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_transactions_category_fits_insert
  BEFORE INSERT ON transactions
  FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.is_transfer IS NOT TRUE)
  EXECUTE FUNCTION refuse_transfer_category_on_category_row();

CREATE TRIGGER trg_transactions_category_fits_update
  BEFORE UPDATE OF category_id, is_transfer ON transactions
  FOR EACH ROW WHEN (NEW.category_id IS NOT NULL AND NEW.is_transfer IS NOT TRUE
    AND (OLD.category_id IS DISTINCT FROM NEW.category_id
         OR OLD.is_transfer IS DISTINCT FROM NEW.is_transfer))
  EXECUTE FUNCTION refuse_transfer_category_on_category_row();
```

`SECURITY DEFINER` with a pinned `search_path`, as the attachment tombstone
trigger in `database/schema.sql` is: under RLS the caller's scope would hide a
category it does not own and the check would pass silently. The categories
trigger of section 11 refuses a change to `transfer`, a move included, while a
category row holds the category or a descendant. Restore sets
`app.preserve_timestamps` rather than disabling triggers, so the backstop
holds there too.

## 14. Test matrix

Every case fails on the code before its pull request
(`docs/financial-calculation-contract.md` section 8.2).

| Case | Kind | Pull request |
|---|---|---|
| Section 4, every row, each with a Transfer, an Income or Expense, and no category: what each leg and line holds afterwards | integration, real PostgreSQL | PR 3, written failing first |
| A refused write leaves nothing written | integration | PR 3 |
| The backstop refuses a Transfer category on each category-row table, allows it on each transfer-row table, and does not fire on an update of another column | integration | PR 2 |
| A type change and a row write race: one wins, the other is refused | two connections | PR 2 |
| The schema change leaves every row, category and figure as it was | integration | PR 2 |
| `type` and `is_income` stay in step both ways; a child takes its parent's type; a previous-release write (`is_income` only, a create or a move under a Transfer parent) leaves the type right | integration | PR 2 |
| A switch of a schedule to ordinary clears its overrides' Transfer categories | integration | PR 3 |
| The fit helper; type change and move refusals; the loan interest and fee checks | unit | PR 2, PR 3 |
| No category write outside the fit helper | source scan | PR 3 |
| No new raw `isIncome` read | source scan | PR 2 |
| Section 5's figures, with no Transfer category in the data, on every surface listed | integration | PR 4 |
| Section 6.4, every row, and section 6.5's figures, with and without the overlap rule | unit (`backend/src/budgets/budget-transfer-income.spec.ts` beside its kin) and integration | PR 4 |
| The period close stores the Transfer Funding part; a period closed before shows one figure | integration | PR 4 |
| Section 7's table, both scopes | integration | PR 4 |
| Section 8.3, every row, both currencies, and the missing-rate case of section 10 | unit (`backend/src/reports/reports.service.spec.ts`) and integration | PR 4 |
| A saved report with no measure returns the figures it returned before | integration | PR 4 |
| Category detail reads a split's transfer line holding the category | integration | PR 4 |
| The loan payment detector does not read a transfer line as interest | unit | PR 3 |
| Each importer's existing fixtures import as before; a Money transfer whose legs differ takes the outgoing leg's category on both | integration | PR 3 |
| Pickers by row kind, the category form, the split editor's transfer line, the breakdown's Transfers group, the report builder, the budget sections | frontend | PR 2 to PR 4 |
| Create a Transfer category; categorize a transfer and a split transfer line; see it in the breakdown; a budget line on it | E2E | PR 5 |

## 15. Choices this specification makes

The plan's decisions left these open; each is stated above and listed here so
the review can find them:

1. A resent category is not a write (section 1), on every path, the transfer
   form included: saving that form without changing the category no longer
   copies one leg's category onto a differing other leg.
2. The breakdown gives a Transfer category an outgoing and an incoming row
   (section 7), not one net row.
3. Actual Income and Transfer Funding are split by line, not by row (section
   6.2): an income line on an Income category is Actual Income even where
   transfers feed it.
4. A Transfer category line takes its transfers in both directions and nets
   them (sections 6.3 and 6.4).
5. A transfer measure makes a report of transfer legs only (section 8.2).
6. An import's category path that names only a Transfer category on a
   category row imports uncategorized and is reported (section 4.5); a Money
   transfer whose legs differ takes the outgoing leg's category.
7. Undo restores both legs to their recorded values, differing ones included
   (section 4.7).
8. The database backstop is a `BEFORE` trigger with a lock, and ships with the
   type in PR 2 (sections 11 and 13).

## 16. Out of scope

- Everything in the plan's section 11.
- Found by the sweep and not changed here, each reported in this pull request:
  a category reassign does not touch scheduled overrides (neither
  `category_id` nor the split JSON); a category delete counts no override
  references; the deleted-split undo names no `kind` (section 4.7); scheduled
  writes do not check category ownership (section 4.3).
