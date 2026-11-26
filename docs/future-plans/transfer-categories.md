# Transfer categories: a third category type

Plan for discussion #2387: categories gain a third type, **Transfer**, beside
Income and Expense. A transfer between a person's own accounts may carry only a
Transfer category, an ordinary transaction only an Income or Expense one, and
existing data is migrated automatically. The task list is
[`transfer-categories-tasks.md`](./transfer-categories-tasks.md).

Status: **planned** (2026-11-26), from the discussion and the maintainer's
answers in session. Section 3 holds those answers, marked "(decided)". Section
12 holds the questions still open, each with a recorded default; a default is
what gets built unless it is changed before the task that implements it starts.
Nothing here is built. Task S0 turns sections 4 to 9 into the approved
specification `docs/financial-calculation-contract.md` section 9 asks for,
before any implementation task starts.

## 1. Goal

- A category has a `type`: income, expense or transfer.
- A transfer carries at most one Transfer category, shared by both of its
  sides. An ordinary row or a split's category line carries only an Income or
  Expense category. Every entry point refuses a mismatch.
- A split's transfer line can carry a Transfer category, as a standalone
  transfer can.
- Existing categorized transfers are migrated with no action from the user,
  and their saved reports, rules, schedules and budgets keep working.
- The Monthly Category Breakdown lists categorized transfers under their
  Transfer category (the original ask of issue #740).
- Budgets can hold a line for a Transfer category, and report actual income,
  transfer funding and total funding as three figures.
- Custom reports can filter and group by Transfer category and measure
  transfers as outgoing, incoming or net.

## 2. What exists today

Facts found in the code on 2026-11-26. Re-locate by symbol, not by line.

| Fact | Where |
|---|---|
| The only type field is `categories.is_income`; a child always takes its parent's type, enforced in the service only | `backend/src/categories/categories.service.ts`, `database/schema.sql` |
| A transfer accepts any category; only ownership is checked (`assertCategoryOwned`) | `backend/src/transactions/transaction-transfer.service.ts` |
| `transferLegColumns` writes the same category on both sides when one person owns both; a cross-owner side gets none | `backend/src/transactions/transfer-leg-columns.ts` |
| Three paths write one side only: the plain `PATCH /transactions/:id`, bulk update (deliberately, per its comment) and the assistant's categorize action | `backend/src/transactions/transactions.service.ts`, `backend/src/transactions/transaction-bulk-update.service.ts`, `backend/src/ai/actions/ai-actions.service.ts` |
| A split's transfer line cannot carry a category: `chk_split_kind_exclusive` on `transaction_splits`, the same rule on `scheduled_transaction_splits`; the services drop a supplied category silently | `database/schema.sql`, `backend/src/transactions/transaction-split.service.ts` |
| Income and expense reports exclude every transfer, categorized or not (INV-REPORT-003) | `backend/src/built-in-reports/` |
| The Monthly Category Breakdown also excludes them; its Transfers group is per account. The transfer form, the DTO and the MCP tool text all say the category makes the transfer appear there, which is not true | `backend/src/built-in-reports/monthly-category-breakdown.service.ts`, `frontend/src/components/transactions/TransferTransactionFields.tsx` |
| Categorized transfers are counted by: the register's category filter, `getGroupedTotals`, the category detail page, a budget's category line, and a custom report with Include transfers | `backend/src/transactions/transaction-analytics.service.ts`, `backend/src/categories/category-detail.service.ts`, `backend/src/budgets/budget-spending.util.ts`, `backend/src/reports/reports.service.ts` |
| Rules refuse `set_category` on a transfer; `convert_to_transfer` clears the category by default and can leave one on the kept side only | `backend/src/transaction-rules/rule-effects.ts`, `backend/src/transactions/convert-to-transfer.ts` |
| A QIF import puts the payee's default category on a transfer's source side; a Money import passes the source row's category through | `backend/src/import/import-regular-processor.service.ts`, `backend/src/import/mny/map/map-transactions.ts` |
| A scheduled transfer may carry a category and posts it to both sides | `backend/src/scheduled-transactions/scheduled-transactions.service.ts` |
| About 60 backend and 40 frontend source files read `isIncome`; many read `!isIncome` to mean "expense" | both layers |
| `budget_categories.is_income` is its own column, not derived from the category | `backend/src/budgets/entities/budget-category.entity.ts` |

## 3. Product decisions

All (decided) by the maintainer on 2026-11-26.

1. **Strict both ways.** A transfer accepts only a Transfer category; an
   ordinary row or a split category line accepts only Income or Expense.
   Converting a row to or from a transfer clears a category of the wrong type.
2. **One category per transfer.** Every write path sets both sides together.
   Where the sides differ today, the outgoing side's category wins. A transfer
   between two owners keeps one category per owner, since a category belongs
   to one person.
3. **Migration copies under a "Transfer" parent.** A top-level Transfer
   category is created per person who needs one; each category used on a
   transfer, and the parents needed to keep its path, is copied beneath it;
   transfers are repointed; originals are left untouched even when now unused.
4. **Budgets.** A budget line may name a Transfer category, and the budget
   shows Actual Income, Transfer Funding and Total Budget Funding separately.
5. **Budget overlap: the category line wins.** A transfer whose Transfer
   category has its own line is counted there and left out of the per-account
   transfer line.
6. **Monthly Category Breakdown.** Categorized transfers are listed under
   their Transfer category; uncategorized ones stay as per-account rows. Both
   stay outside income, expenses and balance.
7. **Split transfer lines carry a category, in the first release.**
8. **Custom reports, in full.** Transfer categories in filters and grouping,
   plus an Outgoing / Incoming / Net measure for transfers.
9. **Wire shape.** A new `type` field is the source of truth. Responses keep
   `isIncome` (true only for income) as a read-only derived field; requests may
   send either, `type` winning.
10. **Defaults.** The default category import gains a short Transfer set, for
    new users only.
11. **Automation.** A rule's "Set the category" applies to a transfer when the
    category is a Transfer category, and "Convert to transfer" can name one. A
    payee's default category stays Income or Expense and stays off transfers.
12. **Delivery.** Six pull requests, grouped by area rather than one per
    task, each into `main` in order (the issue workers branch from `main`).
    `main` holds a half-built feature between the third and the fifth, so no
    release is cut until the sixth has merged.

## 4. Definitions

- **Category type**: `income`, `expense` or `transfer`. A child has its
  parent's type.
- **Transfer row**: a row with `is_transfer = true`, or a split line of kind
  `transfer`. The linked row a split's transfer line creates in the other
  account is a transfer row.
- **Category row**: any other row or split line that can hold a category.
- **Fits**: a category fits a transfer row when its type is `transfer`, and a
  category row when its type is `income` or `expense`. No category always fits.
- **The transfer's category**: the single category of a transfer whose sides
  one person owns. For a split's transfer line it is the line's category, and
  the linked row carries the same one.
- **Outgoing, incoming, net** of a Transfer category over a scope: the sum of
  the negative sides in scope, the sum of the positive sides in scope, and
  their signed sum. When both sides of one transfer are in scope its net is
  zero in one currency and the rate difference across two.

## 5. Invariants (new; IDs assigned in task S0)

| Working name | Statement | Mechanism |
|---|---|---|
| FIT | No stored row holds a category that does not fit it | One server helper called by every write path, a source-scanning guard that fails a category write that bypasses it, an integration matrix over every entry point, and a database backstop (section 12, Q4) |
| ONE | Both sides of a same-owner transfer hold the same category, as do a split's transfer line and its linked row | Written only through the transfer write helpers; the same integration matrix |
| TYPE | `type` and the parent's `type` agree; `is_income` equals `type = 'income'` while the column exists | Service rule as today plus a database trigger for the `is_income` mirror |
| READ | "Expense" is `type = 'expense'`, never `not income` | A typed helper per layer and a guard that fails a new raw `isIncome` read |
| INV-REPORT-003, unchanged | A transfer is a named flow, never income, expenses or net | Existing; the breakdown and custom report entries are amended |

## 6. Data contracts

### 6.1 `categories.category_type`

`VARCHAR(10) NOT NULL DEFAULT 'expense'`, checked against the three values,
backfilled from `is_income`. `is_income` stays for one release so a pod of the
previous release keeps working during a rolling deployment: a trigger keeps the
two in step (a write that changes only `is_income` sets the type; a transfer
type forces `is_income = false`). A later release drops the column, marked
`contract-after`; the API field `isIncome` stays, derived.

### 6.2 Split lines

Both split constraints are relaxed so a line of kind `transfer` may hold a
`category_id`. This only widens, so it is safe under a rolling deployment.
Override split JSON on `scheduled_transaction_overrides` gains the same
allowance.

### 6.3 Migration record

Two tables written by the migration and read by restore, the review screen and
a reversal:

- one row per copied category: owner, source category, Transfer copy (unique
  on the source);
- one row per repointed row: which row, the category it held, and the other
  side's category when it differed and was dropped.

Both need a row-level-security policy, a backup classification and a place in
"delete my data" (`database/CLAUDE.md`).

### 6.4 API

- Category responses: `type` plus derived `isIncome`. Create and update accept
  `type`; `isIncome` is accepted for compatibility and ignored when `type` is
  present. A type change is refused when a referencing row would no longer fit.
- Category list filters, the `income` / `expense` pseudo-ids and
  `GET /categories/income|expense` keep their meaning; a `transfer` type filter
  is added. The existing `transfer` pseudo-id keeps meaning "every transfer".
- Split line DTOs accept `categoryId` on a transfer line.
- Budget line DTOs accept a Transfer category; budget summaries return the
  three funding figures (section 8).
- Custom report config gains a transfer measure (section 8).
- MCP and assistant tools: `list_categories` gains the type; transfer and
  categorize tools refuse a category that does not fit, with the reason.

## 7. Migration

Written once as a database function taking a user, called by the migration for
every user and by the restore path for a restored backup of an older version.
It is idempotent: a second run copies nothing and repoints nothing.

For each person:

1. Collect the categories held by transfer rows: both sides of standalone
   transfers, linked rows of split transfer lines, scheduled transfers and
   their overrides.
2. If there are none, stop. No "Transfer" parent is created for a person who
   never categorized a transfer.
3. Create the top-level Transfer-type parent (name: section 12, Q1).
4. Copy each collected category and the ancestors its path needs under that
   parent, keeping name, icon, colour and description; record source and copy.
5. Repoint each transfer row to the copy. Where a same-owner transfer's sides
   differ, both take the outgoing side's copy (or the only one set) and the
   dropped category is recorded. A linked row of a split transfer line gives
   its category to the line as well.
6. Remap settings through the record:
   - scheduled transfers and their overrides: repointed;
   - saved custom reports with Include transfers on: the copy is added beside
     the original in every category filter that names the original;
   - rule conditions on a category: the copy is added where the condition
     could match a transfer; `convert_to_transfer` actions that keep the
     category get the copy named instead;
   - budget lines: section 12, Q3.
7. Leave untouched: amounts, dates, accounts, links, rates, statuses, tags,
   ids, every original category, and closed budget periods.

Example (from the discussion). Expense categories `Investments: Pension`,
`Investments: Brokerage` and `Travel`, each used on transfers and on ordinary
rows:

| Row | Before | After |
|---|---|---|
| Transfer to pension account, -500 | Investments: Pension | Transfer: Investments: Pension |
| Brokerage fee, -50 | Investments: Brokerage | unchanged |
| Funding a travel card, -2,000 | Travel | Transfer: Travel |
| Hotel, -300 | Travel | unchanged |

Checks the migration's integration suite asserts: every account balance and
every row's amount is unchanged; no row is left holding a category that does
not fit; a second run changes nothing; a backup taken before the upgrade
restores into the same end state.

Rolling deployment: a pod of the previous release can still write an Income or
Expense category onto a transfer for the length of the rollout. The function is
safe to run again, and a follow-up migration in the next release runs it once
more before the `is_income` column is dropped.

## 8. Behaviour by surface

| Surface | Change |
|---|---|
| Category form, list, detail | Third type in the picker, filter, pill and counts. Automatic sign does not apply to a Transfer category. The detail page of a Transfer category shows outgoing, incoming and net instead of spent or received |
| Category pickers | Offer only the types that fit the row: Transfer categories on a transfer form and a split's transfer line, Income and Expense elsewhere. Creating a category from typed text creates the fitting type |
| Transfer form, scheduled transfer form | Unchanged in layout; the hint and docs are corrected |
| Split editor | A transfer line gains an optional category beside its account |
| Bulk edit | A chosen category is applied to the rows it fits and the rest are reported as skipped; a transfer's other side follows |
| Conversion | To a transfer: an Income or Expense category is cleared unless the request names a Transfer one. To a transaction: a Transfer category is cleared |
| Reassign and delete | Reassigning rows to a category of another type is refused where a row would not fit |
| Rules | "Set the category" on a transfer with a Transfer category; a skip reason when it does not fit; "Convert to transfer" may name a Transfer category |
| Payee default category | Income or Expense only; never applied to a transfer, including on QIF import |
| Importers | Never write a category that does not fit. Money's category on a transfer: section 12, Q5 |
| Income and expense reports, Sankey | No change: transfers were already excluded or placed by account |
| Monthly Category Breakdown | Transfers group: Transfer categories with their tree, then per-account rows for uncategorized transfers; one group total |
| Register filters, grouped totals, MCP flow totals | A categorized transfer groups under its Transfer category and is labelled as a transfer, not as spending |
| Custom reports | Transfer categories in filters and as groups; a transfer measure of Outgoing, Incoming or Net. INV-REPORT-004's entry is amended and saved reports keep their figures |
| Budgets | A line may name a Transfer category and counts the outgoing net of its transfers; it wins over a per-account line for the same transfer. Income is reported as Actual Income, Transfer Funding and Total Budget Funding on the summary, period close, alerts, health and trend reports, the assistant and MCP |
| Assistant context and forecast | Categories print their type; a scheduled transfer is no longer read as income because of its category |
| Defaults | A Transfer set in the default import, translated like the rest |
| Backup, support backup, undo | New column and tables classified; undo's column lists gain the type and the split `kind` |

## 9. Missing-data policy

- A budget period closed before the upgrade stored one income figure. Its
  transfer funding is unknown, so the split is shown only for periods closed
  after the upgrade and the old figure keeps its existing caption.
- A transfer measure in a custom report follows the existing rule for a
  missing rate: the total is withheld and the known subtotal is named.

## 10. Test matrix

| Kind | Covers |
|---|---|
| Integration, real PostgreSQL | The migration (differing sides, cross-owner, mixed-use trees, split-line linked rows, schedules and overrides, re-run, balances); restore of an older backup; FIT and ONE across every entry point: form routes, plain patch, bulk edit, conversion both ways, split create/add/remove/collapse, scheduled posting and overrides, rules, the assistant, MCP, each importer, undo |
| Unit | The fit helper, type inheritance and type-change refusal, breakdown grouping, the three transfer measures, budget overlap and the three funding figures |
| Guards | No category write outside the helper; no new raw `isIncome` read |
| Frontend | Pickers by row kind, the category form, split editor transfer line, breakdown Transfers group, custom report builder, budget sections |
| E2E | Create a Transfer category; categorize a transfer and a split transfer line; see it in the breakdown; a budget line on a Transfer category |
| Docs | Website pages and their screenshots for every changed screen |

## 11. Scope cuts

- A second, Transfer-type default category on a payee.
- A switch on the Monthly Category Breakdown between "by category" and "by
  account".
- Deleting or merging the now-unused original categories automatically.
- Any change to how the Cash Flow Sankey places a transfer.

## 12. Open questions

Each default is what gets built unless changed before its task starts.

| # | Question | Default |
|---|---|---|
| Q1 | What is the migrated parent called, and what if a top-level category of that name exists? | "Transfer" in the person's language where the default-category translations have it, English otherwise; an existing category of the same name is left alone and the new parent is created beside it with the Transfer type |
| Q2 | Must a new Transfer category live under that parent? | No. Type is a field; the parent is only where the migration puts its copies |
| Q3 | How are budget lines migrated when a line's category was fed by categorized transfers? | A line whose category was used only on transfers is repointed to the copy. A line fed by both keeps its amount and gains a second line on the copy with a zero budget. Either way the person is told which budgets to review. Closed periods are not touched. Truth table and numbers in S0 |
| Q4 | Is FIT also enforced in the database? | Yes, as a constraint trigger on the four tables that hold a category for a row, if its cost on bulk imports measures acceptably in S0; otherwise service-level only, with the guard and the matrix |
| Q5 | What does a Money import do with a category on a transfer? | Find or create the same path as a Transfer category, so nothing in the source file is dropped |
| Q6 | What form does "reversible" take? | The migration record plus a documented reversal procedure; no automatic downgrade |
| Q7 | How are people told? | A "What's new" entry and release notes, and a one-time review list of the reports, rules and budgets the migration changed |

## 13. Risks

- **Reading `!isIncome` as "expense".** Any reader missed in the sweep counts a
  Transfer category as spending. The READ guard and the removal of the raw
  field from the types are the defence.
- **A write path missed by FIT or ONE.** The inventory in section 2 found
  three one-sided writers that were not obvious; the entry-point matrix is
  written before the helpers are wired in.
- **Budget figures moving on upgrade.** Q3 cannot keep every line identical;
  the review list is what makes the change visible.
- **Size.** One release touches the schema, every category reader, every
  transaction write path, three report engines, budgets, importers, the
  assistant, docs and all locales. `main` is not releasable between the
  third and fifth pull requests; a fix that must ship in that window is
  released from a branch cut before the third.
