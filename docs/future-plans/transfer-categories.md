# Transfer categories: a third category type

Plan for discussion #2387: categories gain a third type, **Transfer**, beside
Income and Expense. A Transfer category goes only on a transfer. A transfer may
hold a Transfer category or, as before this work, an Income or Expense one, so
existing data needs no migration. The task list is
[`transfer-categories-tasks.md`](./transfer-categories-tasks.md).

Status: **planned** (2026-11-26), from the discussion and the maintainer's
answers in session. Section 3 holds those answers, marked "(decided)". Section
12 holds the questions still open, each with a recorded default; a default is
what gets built unless it is changed before the task that implements it starts.
Nothing here is built. PR 1 turns sections 4 to 9 into the approved
specification `docs/financial-calculation-contract.md` section 9 asks for,
before any implementation starts.

Revised the same day after the reply from the author of issue #740 in the
discussion. The first version was strict in both directions and migrated every
categorized transfer to a copy under a "Transfer" parent. The maintainer took
one point from that reply: people keep the Income and Expense categories they
already use on transfers. The migration went with it. The reply's other
proposals (warning icons, suggested fixes, linking unlinked pairs, a settings
switch) are not adopted.

## 1. Goal

- A category has a `type`: income, expense or transfer.
- A Transfer category can be put only on a transfer. Every entry point refuses
  it on an ordinary row or on a split's category line.
- A transfer carries at most one category of any type, shared by both of its
  sides.
- A split's transfer line can carry a category, as a standalone transfer can.
- Nothing stored changes on upgrade. A transfer that holds an Income or
  Expense category keeps it and is counted where it is counted now.
- The Monthly Category Breakdown lists transfers that hold a Transfer category
  under that category (the original ask of issue #740).
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
| The Monthly Category Breakdown also excludes them from its category rows; its Transfers group is per account. The transfer form, the DTO and the MCP tool text all say the category makes the transfer appear there, which is not true | `backend/src/built-in-reports/monthly-category-breakdown.service.ts`, `frontend/src/components/transactions/TransferTransactionFields.tsx` |
| Categorized transfers are counted by: the register's category filter, `getGroupedTotals`, the category detail page, a budget's category line, and a custom report with Include transfers | `backend/src/transactions/transaction-analytics.service.ts`, `backend/src/categories/category-detail.service.ts`, `backend/src/budgets/budget-spending.util.ts`, `backend/src/reports/reports.service.ts` |
| Rules refuse `set_category` on a transfer; `convert_to_transfer` clears the category by default and can leave one on the kept side only | `backend/src/transaction-rules/rule-effects.ts`, `backend/src/transactions/convert-to-transfer.ts` |
| A QIF import puts the payee's default category on a transfer's source side; a Money import passes the source row's category through | `backend/src/import/import-regular-processor.service.ts`, `backend/src/import/mny/map/map-transactions.ts` |
| A scheduled transfer may carry a category and posts it to both sides | `backend/src/scheduled-transactions/scheduled-transactions.service.ts` |
| About 60 backend and 40 frontend source files read `isIncome`; many read `!isIncome` to mean "expense" | both layers |
| `budget_categories.is_income` is its own column, not derived from the category | `backend/src/budgets/entities/budget-category.entity.ts` |
| The loan payment detector reads a split line that has a category and is not the loan's own transfer line as the interest line | `backend/src/accounts/loan-payment-detector.service.ts` |
| A loan's interest and fee categories are checked for ownership only (`assertLoanInterestCategory`, `assertLoanFeeCategories`) | `backend/src/accounts/loan-interest-category.ts`, `backend/src/loan-fees/loan-fee-terms.ts` |

## 3. Product decisions

All (decided) by the maintainer on 2026-11-26. Items 1, 3, 6, 11 and 12 were
revised that day; the introduction says why.

1. **Strict one way.** A Transfer category goes only on a transfer. A transfer
   accepts a category of any type. An ordinary row or a split's category line
   accepts only Income or Expense. Converting a transfer to an ordinary
   transaction clears a Transfer category.
2. **One category per transfer.** Every write path sets both sides together.
   A transfer between two owners keeps one category per owner, since a
   category belongs to one person.
3. **No migration.** Existing transfers, categories, saved reports, rules,
   schedules and budgets are left as they are. A person moves a transfer to a
   Transfer category by editing it, by bulk edit or by a rule.
4. **Budgets.** A budget line may name a Transfer category, and the budget
   shows Actual Income, Transfer Funding and Total Budget Funding separately.
   A line on an Income or Expense category keeps counting the transfers that
   hold that category.
5. **Budget overlap: the category line wins.** A transfer whose Transfer
   category has its own line is counted there and left out of the per-account
   transfer line.
6. **Monthly Category Breakdown.** A transfer holding a Transfer category is
   listed under it in the Transfers group. Every other transfer, including one
   holding an Income or Expense category, stays in its per-account row. The
   whole group stays outside income, expenses and balance.
7. **Split transfer lines carry a category, in the first release.**
8. **Custom reports, in full.** Transfer categories in filters and grouping,
   plus an Outgoing / Incoming / Net measure for transfers.
9. **Wire shape.** A new `type` field is the source of truth. Responses keep
   `isIncome` (true only for income) as a read-only derived field; requests may
   send either, `type` winning.
10. **Defaults.** The default category import gains a short Transfer set, for
    new users only.
11. **Automation.** A rule's "Set the category" applies to a transfer with a
    category of any type, and "Convert to transfer" can name one. A payee's
    default category stays Income or Expense and stays off transfers.
12. **Delivery.** Five pull requests, grouped by area rather than one per
    task, each into `main` in order (the issue workers branch from `main`).
    No pull request refuses data that already exists, so `main` can be
    released after any of them.

## 4. Definitions

- **Category type**: `income`, `expense` or `transfer`. A child has its
  parent's type.
- **Transfer row**: a row with `is_transfer = true`, or a split line of kind
  `transfer`. The linked row a split's transfer line creates in the other
  account is a transfer row.
- **Category row**: any other row or split line that can hold a category.
- **Fits**: a category of any type fits a transfer row; only an `income` or
  `expense` category fits a category row. No category always fits.
- **The transfer's category**: the single category of a transfer whose sides
  one person owns. For a split's transfer line it is the line's category, and
  the linked row carries the same one.
- **Outgoing, incoming, net** of a Transfer category over a scope, counting
  the transfers that hold it: the sum of the negative sides in scope, the sum
  of the positive sides in scope, and their signed sum. When both sides of
  one transfer are in scope its net is zero in one currency and the rate
  difference across two.

## 5. Invariants (new; IDs assigned in PR 1)

| Working name | Statement | Mechanism |
|---|---|---|
| FIT | No category row holds a Transfer category | One server helper called by every write path, a source-scanning guard that fails a category write that bypasses it, an integration matrix over every entry point, and a database backstop (section 12, Q2) |
| ONE | A category write on a same-owner transfer sets both sides to the same category, as it does a split's transfer line and its linked row. Sides that differed before this work stay as stored until the transfer's category is next written | Written only through the transfer write helpers; the same integration matrix |
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

### 6.3 API

- Category responses: `type` plus derived `isIncome`. Create and update accept
  `type`; `isIncome` is accepted for compatibility and ignored when `type` is
  present. A type change is refused when a referencing row would no longer fit
  (a category held by an ordinary row cannot become a Transfer category).
- Category list filters, the `income` / `expense` pseudo-ids and
  `GET /categories/income|expense` keep their meaning; a `transfer` type filter
  is added. The existing `transfer` pseudo-id keeps meaning "every transfer".
- Split line DTOs accept `categoryId` on a transfer line, of any type.
- Budget line DTOs accept a Transfer category; budget summaries return the
  three funding figures (section 8).
- Custom report config gains a transfer measure (section 8).
- MCP and assistant tools: `list_categories` gains the type; write
  tools refuse a Transfer category on a category row, with the reason.

## 7. Existing data

Nothing is migrated. The schema change in 6.1 backfills `category_type` from
`is_income`, so every existing category is Income or Expense and every existing
row already fits.

- A transfer holding an Income or Expense category keeps it, and every report,
  budget, rule and filter counts it as it did before.
- A same-owner transfer whose sides hold different categories keeps both until
  its category is next written; that write sets both sides.
- A backup from an older version restores without a conversion step.

Rolling deployment: a pod of the previous release does not know the type and
offers a Transfer category in every picker as if it were an expense. The
database backstop (section 12, Q2) is what refuses that write during the
rollout.

## 8. Behaviour by surface

| Surface | Change |
|---|---|
| Category form, list, detail | Third type in the picker, filter, pill and counts. Automatic sign does not apply to a Transfer category. The detail page of a Transfer category shows outgoing, incoming and net instead of spent or received. A loan's interest and fee categories refuse a Transfer category |
| Category pickers | On a transfer form and a split's transfer line: all three types, Transfer categories listed first. Elsewhere: Income and Expense only. Creating a category from typed text creates a Transfer category on a transfer and an Income or Expense one elsewhere |
| Transfer form, scheduled transfer form | Unchanged in layout; the hint is corrected to say a Transfer category is what lists the transfer by category in the Monthly Category Breakdown |
| Split editor | A transfer line gains an optional category beside its account. The loan payment detector reads a line as interest only when it is not a transfer line |
| Bulk edit | A chosen category is applied to the rows it fits and the rest are reported as skipped; a transfer's other side follows |
| Conversion | To a transfer: as today (the category is cleared unless the request keeps or names one), and a kept category is written to both sides. To a transaction: a Transfer category is cleared, an Income or Expense one is kept |
| Reassign and delete | Reassigning rows to a Transfer category is refused when any of them is a category row |
| Rules | "Set the category" applies to a transfer with a category of any type, on both sides; a skip reason when a Transfer category meets a category row; "Convert to transfer" may name a category of any type |
| Payee default category | Income or Expense only; never applied to a transfer, including on QIF import |
| Importers | Never write a Transfer category onto a category row. A Money import keeps the source row's category on a transfer and writes it to both sides |
| Income and expense reports, Sankey | No change: transfers were already excluded or placed by account |
| Monthly Category Breakdown | Transfers group: Transfer categories with their tree, then per-account rows for every other transfer; one group total |
| Register filters, grouped totals, MCP flow totals | A transfer holding a Transfer category groups under it and is labelled as a transfer, not as spending. One holding an Income or Expense category is counted as today |
| Custom reports | Transfer categories in filters and as groups; a transfer measure of Outgoing, Incoming or Net. INV-REPORT-004's entry is amended. A saved report returns the figures it returned before |
| Budgets | A line may name a Transfer category and counts the outgoing net of its transfers; it wins over a per-account line for the same transfer. A line on an Income or Expense category counts what it counts today. Income is reported as Actual Income, Transfer Funding and Total Budget Funding on the summary, period close, alerts, health and trend reports, the assistant and MCP |
| Assistant context and forecast | Categories print their type; a scheduled transfer is no longer read as income because of its category |
| Defaults | A Transfer set in the default import, translated like the rest |
| Backup, support backup, undo | New column classified; undo's column lists gain the type and the split `kind` |

## 9. Missing-data policy

- A budget period closed before the upgrade stored one income figure. Its
  transfer funding is unknown, so the split is shown only for periods closed
  after the upgrade and the old figure keeps its existing caption.
- A transfer measure in a custom report follows the existing rule for a
  missing rate: the total is withheld and the known subtotal is named.

## 10. Test matrix

| Kind | Covers |
|---|---|
| Integration, real PostgreSQL | The schema change leaves every existing row and figure as it was; FIT and ONE across every entry point: form routes, plain patch, bulk edit, conversion both ways, split create/add/remove/collapse, scheduled posting and overrides, rules, the assistant, MCP, each importer, undo |
| Unit | The fit helper, type inheritance and type-change refusal, the loan interest line and category checks, breakdown grouping, the three transfer measures, budget overlap and the three funding figures |
| Guards | No category write outside the helper; no new raw `isIncome` read |
| Regression | With no Transfer category in the data, every report, budget and import fixture returns what it returned before |
| Frontend | Pickers by row kind, the category form, split editor transfer line, breakdown Transfers group, custom report builder, budget sections |
| E2E | Create a Transfer category; categorize a transfer and a split transfer line; see it in the breakdown; a budget line on a Transfer category |
| Docs | Website pages and their screenshots for every changed screen |

## 11. Scope cuts

- Any automatic change to existing transfers, categories, reports, rules or
  budgets.
- A warning or suggestion on a transfer that holds an Income or Expense
  category, an "ignore" memory for one, and a setting to turn them off.
- Detecting two unlinked ordinary transactions that cancel out and linking
  them into one transfer.
- A setting that makes a transfer accept Transfer categories only.
- A second, Transfer-type default category on a payee.
- A switch on the Monthly Category Breakdown between "by category" and "by
  account".
- Any change to how the Cash Flow Sankey places a transfer.

## 12. Open questions

Each default is what gets built unless changed before its task starts.

| # | Question | Default |
|---|---|---|
| Q1 | Must a Transfer category live under one "Transfer" parent? | No. Type is a field; the default set for new users happens to sit under one parent |
| Q2 | Is FIT also enforced in the database? | Yes, as a constraint trigger on the tables that hold a category for a category row, if its cost on bulk imports measures acceptably in PR 1; otherwise service-level only, with the guard and the matrix |
| Q3 | How are people told? | A "What's new" entry and release notes |

## 13. Risks

- **Reading `!isIncome` as "expense".** Any reader missed in the sweep counts a
  Transfer category as spending. The READ guard and the removal of the raw
  field from the types are the defence.
- **A write path missed by FIT or ONE.** The inventory in section 2 found
  three one-sided writers that were not obvious; the entry-point matrix is
  written before the helpers are wired in.
- **A category on a split's transfer line read as something else.** The loan
  payment detector is the known reader; the split-line step greps for others
  that assume a line with a category is a category line.
- **Two meanings in one report.** A transfer may sit under a Transfer category
  or under an Expense category, so a category total still depends on how the
  person categorized. This is the ambiguity the discussion set out to remove,
  kept by decision 1 for people who budget by cash flow.
- **Size.** The work touches the schema, every category reader, every
  transaction write path, three report engines, budgets, importers, the
  assistant, docs and all locales.
