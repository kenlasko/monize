# Bucket budget strategy

Design for a fifth budget strategy, **Bucket**: a budget owns a handful of
named buckets, each with a target (a share of income or a fixed amount per
period), every expense line belongs to one bucket, and the budget is judged
bucket by bucket instead of line by line. A bucket can optionally carry what
it did not spend into the next period. The task list is
[`bucket-budget-tasks.md`](./bucket-budget-tasks.md).

Status: **built** on branch `feat/bucket-budget` (2026-11-15), from the proposal written 2026-11-14 with the maintainer in session. The
four product choices in section 3 marked "(decided)" are the maintainer's
answers; the open questions in section 13 carry a recorded default each, and
the default is what gets built unless it is changed before the task that
implements it starts. It reports money per period and freezes figures at a
period close, so sections 4 to 9 are the specification
`docs/financial-calculation-contract.md` section 9 asks for.

## 1. Goal

- A **Bucket** strategy card in the budget wizard and a **Bucket** option on
  the budget settings form.
- **Buckets** a person defines per budget (name, target, carry-over), with two
  editable presets and a blank start.
- Every expense or transfer line of the budget is **assigned to one bucket**;
  what is not assigned is reported as "Unassigned", never dropped.
- A **Bucket allocation** card on the budget dashboard: per bucket, what it
  was given, what was carried in, what is spent and what is left.
- **Optional carry-over** per bucket: what is left at the period close is
  carried into the next period, up to an optional cap.
- Closed periods keep a **frozen bucket snapshot**.
- The AI assistant and the MCP `get_budget_status` tool return the same bucket
  figures.

### How the method works (research summary)

Bucket budgeting splits income into a few named pots and tracks each pot as a
whole. The versions in circulation differ in the pots, not in the mechanism:

| Version | Buckets | Target form |
|---|---|---|
| Three buckets (bank and adviser guides) | Fixed costs, variable spending, savings | Fixed costs as an amount, the rest by share |
| Barefoot-style four buckets | Daily expenses 60, splurge 10, long-term goals 10, safety and debt 20 | Shares of income |
| Spending buckets (bank "bucket" features) | Any named pot per purpose | Amounts; money stays in the pot until spent |

The common core, and what this design builds: user-named buckets, a target
that is a share or an amount, membership of spending in exactly one bucket,
and for the savings-like buckets a balance that survives the period. Linking a
bucket to a bank account (the "one account per bucket" advice) is out of scope
(section 12).

## 2. What exists, and what this composes

| Piece | Where | Role here |
|---|---|---|
| `BudgetStrategy` enum, `budgets.strategy VARCHAR(30)`, no CHECK | `backend/src/budgets/entities/budget.entity.ts`, `database/schema.sql` | Gains `BUCKET`; no column change |
| `budget_categories` (the budget's lines) | `backend/src/budgets/entities/budget-category.entity.ts` | Gains nullable `bucket_id` |
| `CategoryGroup` NEED/WANT/SAVING and `Budget503020Summary` | same entity; `frontend/src/components/budgets/Budget503020Summary.tsx` | Untouched. The closest precedent, but its figures are computed in the browser; buckets are computed on the server |
| Flex groups (`flex_group` free text) | `backend/src/budgets/budget-activity-reports.service.ts`, `frontend/src/components/budgets/BudgetFlexGroupCard.tsx` | Untouched and orthogonal: a line can be in a flex group and a bucket |
| Line actuals, in the budget's currency | `queryCategorySpending`, `resolveCategorySpent`, `resolveBudgetIncome` in `backend/src/budgets/budget-spending.util.ts` | The only source of `spent` and of actual income; no new actuals query |
| Live line breakdown | `BudgetsService.getSummary` in `backend/src/budgets/budgets.service.ts` | The bucket read model sums its rows |
| Period create, close, line rollover | `backend/src/budgets/budget-period.service.ts` | The close also freezes buckets and writes the next period's carry-in, in the same transaction |
| Period snapshot tables | `budget_periods`, `budget_period_categories` | A sibling `budget_period_buckets` |
| Wizard (analyze, categories, configure, review) | `frontend/src/components/budgets/BudgetWizard.tsx` and its step components | Bucket setup and a per-line bucket picker when the strategy is Bucket |
| Wizard apply | `BudgetGeneratorService.apply` in `backend/src/budgets/budget-generator.service.ts` | Accepts buckets and each line's bucket key |
| LLM status shape | `getLlmBudgetStatus` in `backend/src/budgets/budget-reports.service.ts`; `backend/src/mcp/tool-output-schemas.ts` | Gains an optional `buckets` array |

Name collision to keep in mind: `queryCategorySpendingBuckets` and
`budget-spending-buckets.ts` are about **time** buckets. Every new symbol in
this feature is `BudgetBucket...` or `budget_bucket...`, never a bare `Bucket`.

## 3. Product decisions

1. **Custom buckets with presets (decided).** Buckets are user-defined per
   budget. The wizard offers "Three buckets", "Four buckets (60/10/10/20)" and
   "Start from scratch"; a preset only pre-fills the editor (section 10).
   Rejected: a fixed three-bucket set; account-based buckets.
2. **A target is a percent of income or a fixed amount (decided).**
   `PERCENT` (greater than 0, at most 100, two decimals) or `AMOUNT` (greater
   than 0, in the budget's currency, per period). Buckets of both kinds can
   sit in one budget.
3. **Carry-over is a per-bucket option (decided).** `carry_over` off: the
   bucket starts every period at its allocation. On: what is left at the close
   is carried in to the next period, limited by an optional `carry_cap`.
4. **50/30/20 is left alone (decided).** `category_group`, its picker and its
   widget do not change, and no existing budget is migrated.
5. **Bucket income** is the figure a `PERCENT` target is a share of
   (section 4). It is the actual income of the period for an income-linked
   budget, otherwise the budget's base income, otherwise the sum of the income
   lines' budgeted amounts. When that is zero the allocation of a percent
   bucket is **unknown** (`null`) and the card says to set a base income; it is
   never shown as zero.
6. **Targets are not forced to add up.** The server reports `totalAllocated`
   and `unallocated` (bucket income minus the allocations); the card flags
   over-allocation. A request is refused only for an out-of-range target, never
   because the set does not total 100 percent: an amount bucket and a live
   income make "adds up" a moving fact, not a validation.
7. **Membership.** A non-income line belongs to at most one bucket of its own
   budget (`budget_categories.bucket_id`, nullable). Income lines cannot be
   assigned. Unassigned lines are summed into an `unassigned` block.
8. **Carry keeps its sign.** With carry-over enabled, an overspent bucket
   passes its shortfall to the next period. The optional cap limits a surplus.
   See [Signed budget actuals](../specs/signed-budget-actuals.md).
9. **Bucket carry and line rollover are independent.** A bucket's balance is
   built from its allocation and its lines' spending only; a line's
   `rollover_in` never enters it. A person who wants balances to accumulate at
   bucket level leaves line rollover off.
10. **Limits.** At most 12 buckets per budget; name 1 to 50 characters, unique
    within the budget ignoring case and surrounding space.
11. **Deleting a bucket** unassigns its lines (`ON DELETE SET NULL`) and keeps
    its closed-period snapshots, which carry the bucket's name as it was.
12. **Changing strategy** never deletes buckets. They are shown only while the
    strategy is Bucket. A Bucket budget with no buckets shows an empty state
    linking to the edit page.
13. **Bucket writes are not in the undo history**, the same as budget lines
    today (only the `budgets` row is recorded).
14. **The health score does not change.** Its Needs weighting reads
    `category_group` only.

## 4. Definitions

- **Line**: a `budget_categories` row. **Member line** of bucket B: a line
  with `is_income = false` and `bucket_id = B.id`.
- **Bucket income** `I` for a period: `resolveBudgetIncome(...)` when
  `income_linked`; else `base_income` when it is greater than 0; else the sum
  of `amount` over the income lines; `null` when the chosen figure is not
  greater than 0.
- **allocated**: `roundMoney(I * target_value / 100)` for `PERCENT` (`null`
  when `I` is `null`); `target_value` for `AMOUNT`.
- **planned**: sum of the member lines' allocations before line rollover
  (a percentage line of an income-linked budget is already an amount).
- **spent**: sum of the member lines' `spent` (each line already a signed net
  through `resolveCategorySpent`). It can be negative when refunds exceed
  spending.
- **carriedIn**: the reported period's `budget_period_buckets.carry_in` for the
  bucket; 0 when the bucket has no row yet or `carry_over` is off.
- **available**: `allocated + carriedIn - spent`; `null` when `allocated` is.
- **percentUsed**: `spent / (allocated + carriedIn) * 100`, two decimals; 0
  when the denominator is not greater than 0; `null` when `allocated` is.
- **carryOut** (at close only): 0 when `carry_over` is off or `allocated` is
  `null`; otherwise `available`, limited to `carry_cap` from above when set.

All sums go through `sumMoney` and every derived amount through `roundMoney`,
with the budget currency's decimals.

## 5. Invariants

New section "Budgets" in `docs/system-invariants.md`, each with its matrix row
in `docs/verification-contract.md` section 3.

| ID | Statement | Mechanism |
|---|---|---|
| INV-BUDGET-001 | Every bucket figure on every surface (dashboard card, period snapshot, assistant, MCP) is produced by one pure function | `computeBudgetBucketFigures` in `budget-bucket-figures.util.ts` is the only place the section 4 arithmetic is written; the live read and the period close both call it; no client component adds, subtracts or divides bucket figures |
| INV-BUDGET-002 | A line's bucket belongs to the line's own budget, and an income line has none | The check runs inside the `withScopedDb` transaction of every write that sets `bucket_id` (add line, update line, bulk update, wizard apply), before the write; an integration test drives a foreign bucket id through each route |
| INV-BUDGET-003 | A closed period's bucket figures are frozen, and the next period's `carry_in` equals the closed period's `carry_out` | Both are written inside the existing period-close transaction, under the `FOR UPDATE` lock on the period row that already serialises a close; nothing rewrites a `budget_period_buckets` row whose period is `CLOSED` |

## 6. Data contracts (new)

### 6.1 Table `budget_buckets`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `budget_id` | `UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE` | |
| `name` | `VARCHAR(50) NOT NULL` | stored trimmed |
| `target_type` | `VARCHAR(10) NOT NULL` | `PERCENT` or `AMOUNT`, with a CHECK |
| `target_value` | `NUMERIC(24, 8) NOT NULL` | CHECK greater than 0; the percent upper bound is the service's |
| `carry_over` | `BOOLEAN NOT NULL DEFAULT false` | |
| `carry_cap` | `NUMERIC(24, 8)` | nullable; CHECK greater than 0 when present |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | |
| `created_at`, `updated_at` | timestamps | `update_updated_at_column` trigger |

`UNIQUE(budget_id, name)`; the case-insensitive rule of decision 10 is checked
in the service inside the write's transaction. Index on `budget_id`. RLS:
indirect, the `budget_categories_isolation` shape (an `EXISTS` back to
`budgets.user_id`).

### 6.2 Column `budget_categories.bucket_id`

`UUID REFERENCES budget_buckets(id) ON DELETE SET NULL`, nullable, with a
partial index where it is not null. Expand-only.

### 6.3 Table `budget_period_buckets`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `budget_period_id` | `UUID NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE` | |
| `bucket_id` | `UUID REFERENCES budget_buckets(id) ON DELETE SET NULL` | null once the bucket is deleted |
| `bucket_name` | `VARCHAR(50) NOT NULL` | name at the time the row was last written |
| `target_type`, `target_value` | as 6.1 | frozen at close |
| `income_basis` | `NUMERIC(24, 8)` | bucket income at close; null while open or unknown |
| `allocated_amount` | `NUMERIC(24, 8)` | null while open, and when unknown at close |
| `carry_in` | `NUMERIC(24, 8) NOT NULL DEFAULT 0` | written when the period is created |
| `actual_amount` | `NUMERIC(24, 8) NOT NULL DEFAULT 0` | spent, frozen at close |
| `carry_out` | `NUMERIC(24, 8) NOT NULL DEFAULT 0` | frozen at close |
| `created_at`, `updated_at` | timestamps | |

`UNIQUE(budget_period_id, bucket_id)`. RLS: indirect, the two-hop
`budget_period_categories` shape. Unassigned spending is not snapshotted.

Row lifecycle: a period's creation inserts one row per bucket that has a
nonzero carry to receive; the close upserts one row per bucket that exists at
that moment (a bucket created mid-period gets its row then, `carry_in` 0) and
fills the frozen columns.

### 6.4 Bucket CRUD (all under the existing budgets controller)

- `GET /budgets/:id/buckets` -- the budget's buckets, ordered by `sort_order`
  then name. Delegates may read.
- `POST /budgets/:id/buckets` -- `{ name, targetType, targetValue, carryOver?, carryCap?, sortOrder? }`.
- `PATCH /budgets/:id/buckets/:bucketId` -- any subset of the same fields.
- `DELETE /budgets/:id/buckets/:bucketId`.

Refusals (each inside the write's transaction, each a `tr(...)` message):
budget or bucket not the caller's (404); 13th bucket; duplicate name; percent
above 100; `carryCap` without `carryOver`.

The budget read (`GET /budgets/:id`) returns `buckets` beside `categories`,
and each line carries `bucketId`. The line DTOs (create, update, bulk) accept
`bucketId` (a UUID or `null`), held by INV-BUDGET-002.

### 6.5 `GET /budgets/:id/reports/bucket-status`

```jsonc
{
  "periodStart": "2026-11-01",
  "periodEnd": "2026-11-30",
  "currencyCode": "CAD",
  "income": 5000,            // null when unknown
  "incomeSource": "BASE_INCOME", // ACTUAL | BASE_INCOME | INCOME_LINES | NONE
  "totalAllocated": 4700,    // null when any bucket's allocation is unknown
  "knownAllocated": 4700,    // the partial sum, always a number
  "unallocated": 300,        // income - totalAllocated; null when either is
  "buckets": [
    {
      "bucketId": "…", "name": "Savings",
      "targetType": "PERCENT", "targetValue": 20,
      "carryOver": true, "carryCap": null,
      "allocated": 1000, "carriedIn": 250, "planned": 900,
      "spent": 400, "available": 850, "percentUsed": 32,
      "lineCount": 3
    }
  ],
  "unassigned": { "planned": 120, "spent": 80, "lineCount": 1 }
}
```

`totalAllocated` follows "a subtotal is not a total": it is `null` when one
allocation is unknown, and `knownAllocated` carries the partial sum. Delegates
may read. An empty `buckets` array is a valid answer for any strategy.

### 6.6 Wizard apply

`ApplyGeneratedBudgetDto` gains `buckets?` (at most 12; each
`{ key, name, targetType, targetValue, carryOver?, carryCap?, sortOrder? }`,
`key` a client-chosen string of at most 40 characters, unique in the request)
and each category entry gains `bucketKey?`. A `bucketKey` naming no bucket of
the request is refused. The budget row, its buckets and its lines are written
in one `withScopedDb` transaction (today the budget and its lines are separate
transactions; this change makes the whole apply one).

### 6.7 Period detail

The period detail read (`GET /budgets/:id/periods/:periodId`) returns
`periodBuckets` (the 6.3 rows). The UI shows them for a `CLOSED` period only.

### 6.8 LLM shape

`LlmBudgetStatusResult` gains `buckets?`, present only when the budget has
buckets and the strategy is `BUCKET`:
`[{ name, targetType, targetValue, allocated, carriedIn, spent, available, percentUsed }]`
plus `bucketIncome` and `unallocated`. Both adapters (assistant and MCP) and
the MCP output schema change in the same commit.

## 7. Truth tables

### A. Bucket income

| `income_linked` | `base_income` | Income lines' budgeted sum | Actual income | `income` | `incomeSource` |
|---|---|---|---|---|---|
| true | any | any | 4200 | 4200 | ACTUAL |
| true | any | any | 0 | null | NONE |
| false | 5000 | any | any | 5000 | BASE_INCOME |
| false | null or 0 | 4800 | any | 4800 | INCOME_LINES |
| false | null or 0 | 0 | any | null | NONE |

### B. Allocation and availability

| Target | `income` | `allocated` | `available` | `percentUsed` |
|---|---|---|---|---|
| PERCENT 20 | 5000 | 1000 | 1000 + carriedIn - spent | spent / (1000 + carriedIn) |
| PERCENT 20 | null | null | null | null |
| AMOUNT 1200 | any, including null | 1200 | 1200 + carriedIn - spent | spent / (1200 + carriedIn) |

### C. Carry at close

| `carry_over` | `allocated` | `available` | `carry_cap` | `carry_out` |
|---|---|---|---|---|
| false | any | any | any | 0 |
| true | null | null | any | 0 |
| true | known | 850 | null | 850 |
| true | known | 850 | 500 | 500 |
| true | known | -150 | any | -150 |
| true | known | 0 | any | 0 |

### D. Membership writes

| Line | `bucketId` in the request | Result |
|---|---|---|
| expense or transfer | a bucket of the same budget | set |
| expense or transfer | `null` | cleared |
| expense or transfer | a bucket of another budget, or another person's | refused, nothing written |
| income | any non-null | refused, nothing written |
| any | field absent | unchanged |

## 8. Numerical examples

Budget in CAD, not income-linked, `base_income` 5000. Recorded 2026-11-14.

| Bucket | Target | Carry | allocated | carriedIn | spent | available | percentUsed | carryOut at close |
|---|---|---|---|---|---|---|---|---|
| Fixed costs | PERCENT 50 | off | 2500.00 | 0 | 2400.00 | 100.00 | 96.00 | 0 |
| Everyday | AMOUNT 1200 | off | 1200.00 | 0 | 1350.00 | -150.00 | 112.50 | 0 |
| Savings | PERCENT 20 | on, no cap | 1000.00 | 250.00 | 400.00 | 850.00 | 32.00 | 850.00 |

`totalAllocated` 4700.00, `unallocated` 300.00. The next period opens with
Savings `carry_in` 850.00; with a `carry_cap` of 500 it opens with 500.00.

Rounding: income 3333.33, PERCENT 33.33 gives
`roundMoney(3333.33 * 33.33 / 100)` = 1110.9989 at four decimals.

Unknown income: the same three buckets with `base_income` null and no income
lines give Fixed costs and Savings `allocated` null, `totalAllocated` null,
`knownAllocated` 1200.00, `unallocated` null; Savings carries 0 at the close.

## 9. Missing-data policy

| Missing | Live answer | At close |
|---|---|---|
| Bucket income (section 4 gives `null`) | percent buckets: `allocated`, `available`, `percentUsed` null; the card names the fix ("Set a base income on the budget, or add an income category") with a link to the edit page | `allocated_amount` and `income_basis` null, `carry_out` 0 |
| No open-period row for the bucket | `carriedIn` 0 (nothing was carried) | row inserted with `carry_in` 0 |
| A line with no bucket | counted in `unassigned` | not snapshotted |
| A rate missing on a line's rows | the line's `spent` is what `queryCategorySpending` converted, as on every other budget surface today; the line read exposes no completeness flag, so the bucket read cannot add one (the named gap in INV-FX-001 that section 12 leaves alone) | same |
| Strategy is Bucket, no buckets | empty state linking to the edit page | nothing written |

## 10. Frontend structure

- **Types and client**: `BudgetStrategy` gains `'BUCKET'`; `BudgetBucket`,
  `BudgetBucketStatus`, `BudgetPeriodBucket` in `frontend/src/types/budget.ts`;
  bucket methods on `budgetsApi` in `frontend/src/lib/budgets.ts`.
- **Every strategy list gains the fifth entry**: `STRATEGIES` and
  `STRATEGY_VALUES` in `BudgetForm.tsx`, `STRATEGY_VALUES` in
  `BudgetWizardAnalysis.tsx`, `STRATEGY_LABELS` and `STRATEGY_DESCRIPTIONS` in
  `budget-labels.ts`, and the four per-strategy key groups of `budgets.json`
  (`form.strategyOptions`, `wizardAnalysis.strategies`,
  `wizardStrategy.strategyDescriptions`, `strategyCard.strategies`).
- **Presets** in `budget-bucket-presets.ts`: a constant of
  `{ id, buckets: [{ nameKey, targetType, targetValue, carryOver }] }`. The
  names are translation keys resolved once when the preset is applied; from
  then on the name is the person's data.

  | Preset | Buckets |
  |---|---|
  | Three buckets | Fixed costs 50%, Everyday spending 30%, Savings 20% (carry on) |
  | Four buckets (60/10/10/20) | Daily expenses 60%, Splurge 10%, Long-term goals 10% (carry on), Safety and debt 20% (carry on) |
  | Start from scratch | none |

- **`BudgetBucketEditor.tsx`**: the list of buckets with name, target type,
  target value, carry-over and cap; add, edit and remove. It edits an
  in-memory list (the wizard) or calls the CRUD routes (the edit page) through
  the callbacks it is given. Money and percent inputs are the existing form
  inputs (`docs/frontend/forms-and-formatting.md`).
- **Wizard**, when the strategy is Bucket: the categories step shows the
  preset picker and the editor above the category list, and each selected
  expense or transfer row gets a bucket select (the place the 50/30/20 picker
  occupies); the review step lists buckets with their line counts and warns
  about unassigned lines. `WizardState` gains `buckets`.
- **Edit page** (route `/budgets/[id]/edit`): a "Buckets" section holding the
  editor, shown while the strategy is Bucket; `BudgetCategoryForm.tsx` gains a
  bucket select fed by the budget's buckets, shown under the same condition.
- **Dashboard**: `BudgetBucketSummary.tsx`, rendered by `BudgetDashboard.tsx`
  when the strategy is Bucket, reading `GET .../reports/bucket-status`. One
  row per bucket: name, target caption ("20% of income" or the amount),
  carried-in caption when not zero, a `BudgetProgressBar` of spent against
  allocated plus carried in, available, and the unassigned row when it has
  lines. It renders the server's figures and computes none (INV-BUDGET-001).
- **Period detail**: `BudgetPeriodDetail.tsx` lists the frozen bucket rows of
  a closed period.
- **Docs link**: a `budgetBuckets` entry in `frontend/src/lib/docs-links.ts`
  pointing at the new "Buckets" heading of `website/docs/budgets.md`.

## 11. Test matrix

| Subject | Kind | Cases |
|---|---|---|
| `computeBudgetBucketFigures` | unit | every row of truth tables A, B and C; the section 8 examples to the cent; negative `spent`; float-accumulation case (ten lines of 0.1) |
| Bucket CRUD | unit | each refusal of 6.4; trimmed and case-insensitive duplicate; 12 then 13 buckets |
| Membership | unit + PG integration | truth table D through add, update, bulk and apply (INV-BUDGET-002) |
| Period close | unit + PG integration | carry chain over two closes on real PostgreSQL; cap; bucket created mid-period; bucket deleted before close; unknown income; a closed row is not rewritten by a later bucket edit (INV-BUDGET-003) |
| New tables | PG integration (existing suites) | `rls-enforcement` indirect map, `schema-entity-parity`, backup round trip, support-backup golden columns |
| Wizard apply | unit | buckets and lines in one transaction; unknown `bucketKey` refused with nothing written |
| LLM shape | unit | `buckets` present only for a Bucket budget with buckets; MCP output schema accepts it; tool-list byte budget holds |
| Frontend | vitest | every strategy list shows Bucket; editor add/edit/remove and validation; preset application; wizard payload carries `buckets` and `bucketKey`; summary card renders null allocation as the "set a base income" message, never 0; unassigned row |

## 12. Explicit v1 scope cuts

- **No bucket alerts.** A bucket-level warning needs a new notification type,
  email copy in every locale and another key in the
  `idx_notifications_fingerprint` unique index; it is its own proposal.
- **No link between a bucket and a bank account**, and no tracking of
  transfers that "fund" a bucket.
- **No drag-to-reorder**; `sort_order` follows creation order and can be
  edited later.
- **No undo history** for bucket writes (decision 13).
- **No bucket trend report** and no bucket column in the existing reports.
- **No completeness flag** on bucket figures beyond what the line read has.
- **No change to 50/30/20, flex groups, the health score or the generator's
  suggested amounts.** The generator does not suggest buckets.
- **No Playwright spec for the wizard**; the existing budgets E2E spec defers
  the wizard already.

## 13. Open questions

| # | Question | Recorded default |
|---|---|---|
| B1 | For a budget that is not income-linked, should a percent bucket follow planned income (decision 5) or the income actually received this period? | Planned (base income, else income lines): the allocation is known on day one |
| B2 | Should an overspent carry-over bucket start the next period in the red? | Yes, a negative closing balance reduces the next period’s available budget ([#2404](../specs/signed-budget-actuals.md)) |
| B3 | Should bucket-level alerts follow as a second proposal? | Yes, separately, after this ships |
| B4 | Should assigning a line be required before a Bucket budget can be created in the wizard? | No; the review step warns and the dashboard shows Unassigned |

## 14. Companion task list

[`bucket-budget-tasks.md`](./bucket-budget-tasks.md).
