# Spec: a split line reads as the whole row it stands for

Status: proposed for discussion #2403 (2026-11-25). Category-independent part
only: the Transfer category type (discussion #2387) is out of scope, and so is
every rule that depends on it.
Governs: every read that sums or counts posted transactions by transfer status
or by tag -- the register's summary and running balance, the analytics
summaries and charts, the built-in reports, the budget reports, and the AI and
MCP tools that read them.

Read `docs/financial-semantics.md` section 2 ("Transfers") and
`docs/specs/split-cross-currency-transfer.md` section 1 first. The staged work
list is `docs/future-plans/split-line-equivalence-tasks.md`.

## 1. The defect class

A transfer is stored in two shapes (`docs/financial-semantics.md` section 2):

- **A whole transfer** is two `transactions` rows with `is_transfer = true`,
  each linked to the other.
- **A split transfer line** is a `transaction_splits` row with
  `transfer_account_id` set. Its parent has `is_split = true` and
  `is_transfer = false`. Its counterpart in the other account is a whole row
  with `is_transfer = true`, linked to the parent.

A read that selects transfers with `is_transfer = true` alone sees the
counterpart (the incoming side) and misses the line (the outgoing side). It
reports half of the transfer. Issues #2335, #2337 and #2345 fixed this on some
surfaces; the sweep of 2026-11-25 found it on four more (section 5).

A second, unrelated defect has the same root: a tag filter that joins the
parent's tags and the line's tags and then sums repeats the line once per
matching tag pair, so one line can count twice or more.

## 2. Rules

1. **A split line counts as the whole row it stands for.** A transfer line is a
   transfer leg on its parent's account, with the line's signed amount and
   the parent's date, status and currency. A category line is a categorised
   row. Every read that classifies rows as transfers, income or expenses
   classifies a line by itself, never by its parent.
2. **Each leg counts once.** A transfers-only read includes whole transfer rows
   and split transfer lines, and no other line of the same split. When both
   accounts of a same-currency transfer are in scope, its legs net to zero.
3. **A tag filter selects, it does not multiply.** A line matches when its
   parent or the line itself carries a selected tag. It then counts once, at
   its own amount, however many selected tags match. The filter is an
   `EXISTS` test, never a join that a `SUM` reads through.
4. **The parent is never counted beside its lines.** A read takes either the
   parent row or its lines (`COALESCE(split.amount, t.amount)`), never both.
5. **Income and expense exclude the transfer line, not the split.** A read that
   excludes transfers drops the transfer line and keeps the other lines of the
   same split (INV-REPORT-003).
6. **The register and its figures agree.** Under the transfers filter the
   register lists a split whose transfer line matches, as it lists a split
   whose category line matches a category filter: only the matching line
   hydrates, and the filtered total is the line's amount, not the parent's.

## 3. Numerical example

The fixture of `backend/test/integration/report-transfer-fx-surfaces.integration.spec.ts`,
reporting currency EUR, rate EUR->USD 1.25 on 2026-03-01:

| Row | Account | Amount | Shape |
| --- | --- | --- | --- |
| A | US Chequing | -100 USD | whole transfer out, rate 0.9 |
| B | EU Savings | +90 EUR | whole transfer in, linked to A |
| C | US Chequing | -160 USD | split parent: groceries -60, transfer line -100 |
| D | EU Savings | +90 EUR | counterpart of C's transfer line, rate 0.9 |

Each outgoing leg is converted at its own row's rate (INV-FX-002), so A and
C's line each read 90 EUR.

| Read | Today | After |
| --- | --- | --- |
| Monthly Category Breakdown, US Chequing, "from" row | 90 | 180 |
| `list_transactions` with `transfersOnly`, US Chequing outbound | 100 USD | 200 USD |
| Analytics monthly totals under the "transfer" filter (both accounts) | 90, 3 rows | 0, 4 rows |
| Register under the "transfer" filter | lists A, B, D | lists A, B, C, D; C hydrates only its -100 USD line |
| Expenses (any report) | 48 | 48 (groceries only; rule 5 already holds) |

Tag example: C carries tag T1 and its groceries line carries T1 and T2. A
filter on {T1}, transfers excluded, joins one row per line tag, and the
parent's T1 passes both, so today the groceries line sums twice (-120 USD);
after, once (-60 USD).

## 4. Missing data

No new missing-data case. A transfer line's conversion follows the rules its
whole row follows: its own rate first, the market rate on its date second, and
an unknown when neither exists (INV-FX-002, `FxAggregate`). A line whose
counterpart the reader cannot see still counts on its own account, as a whole
leg does (INV-SANKEY-002's "(unlinked account)" case).

## 5. Surfaces

Found by the sweep of 2026-11-25. Each task in the task list fixes one group.

| Surface | Code | Defect |
| --- | --- | --- |
| Monthly Category Breakdown, transfer rows | `getTransferRows`, `backend/src/built-in-reports/monthly-category-breakdown.service.ts` | omits the transfer line |
| AI and MCP `list_transactions` with `transfersOnly` | `getTransfersByAccount`, `backend/src/transactions/transaction-analytics.service.ts` | omits the transfer line |
| Analytics "transfer" filter (summary, grouped totals, monthly totals, tag-key breakdown) | `createFilteredAnalyticsQuery`, same file | omits the transfer line |
| Register under the "transfer" filter, its filtered total and running balance | `findAll`, `computeSplitAwareSum`, `buildFilteredIdsSubquery`, `backend/src/transactions/transactions.service.ts` | omits the transfer line |
| Analytics and register tag filters | `createFilteredAnalyticsQuery`, `computeSplitAwareSum` | multiplies a line per matching tag pair |
| Budget Health savings rate, income without an income line | `getSavingsRate`, `backend/src/budgets/budget-health-reports.service.ts` | counts a split parent's positive transfer line as income |

Already correct, and the pattern to follow: the Cash Flow Sankey
(`wholeTransferLegsQuery` / `splitTransferLegsQuery`), Income vs Expenses'
tagged transfer flows, the budget transfer builders
(`backend/src/budgets/budget-spending.util.ts`), the custom report
(`netLinesOf`), and the tag-key filter (`buildTagKeyFilterClause`, an `EXISTS`).

Not in scope, with the reason:

- The Transfer category type and anything that reads it: discussion #2387.
- `loadTransferHistory` (`backend/src/scheduled-transactions/transfer-estimate-ledger.ts`)
  estimates a scheduled whole transfer from past whole transfers; a split is
  not that history.
- `externalFlowSubtotalsSql` (`backend/src/securities/external-flow.util.ts`)
  leaves out a split parent with an ordinary line altogether. Whether a
  portfolio's external flow should read split lines is a question for the
  portfolio contract, not this spec; the task list records it as a follow-up.

## 6. Test matrix

Every case fails on the code before its task (`docs/financial-calculation-contract.md`
section 8.2).

| Case | Kind | Where |
| --- | --- | --- |
| Section 3, each "After" figure | integration | `report-transfer-fx-surfaces.integration.spec.ts`, updated where it pins "Today" |
| A whole transfer and the equivalent split transfer line give the same transfer figure | integration | same file |
| Both accounts in scope: transfers-only net is 0 | integration | same file |
| Only the sending account: the outgoing amount; only the receiving: the incoming | integration | same file |
| A mixed split with transfers excluded keeps its category line | integration | already covered (`getLlmFlowTotals`, 48) |
| A line matching two tags, its parent matching one: counts once | integration | `tag-filter-sum-once.integration.spec.ts`: analytics summary and register filtered total |
| Budget Health: a split with a positive transfer line adds nothing to income | unit + integration | `budget-health-reports.service.spec.ts` |
| No `is_transfer = true` transfers-only read without the split-line arm | guard | a source scan beside `report-rounding.guard.spec.ts`, if the arms share one helper |

INV-REPORT-006 in `docs/system-invariants.md` records the rule and its status.
