# Spec: a report figure is rounded once, from its own components

Status: proposed on `claude/issue-2384` (issue #2384, discussion #2382).
Rules 1 to 8 restate the contract the issue agreed; section 6 is a decision
the issue leaves open and the maintainer is asked to make.
Governs: every reporting-only money figure -- the built-in reports, the custom
report engine, the Cash Flow Sankey, the dashboard widgets and AI/MCP tools that
read them -- and the screen, CSV and PDF outputs of each.

Read `docs/specs/fx-conversion-completeness.md` (what `FxAggregate` is and how
completeness travels) and `docs/financial-semantics.md` section 4 (precision by
field) first. The staged work list is
`docs/future-plans/report-rounding-and-aggregation-tasks.md`.

## 1. The defect class

Issue #2360 made `FxAggregate` (`backend/src/common/fx-aggregate.ts`) hold each
converted component at twelve places and round to four only when the subtotal
is read, so "convert each row, then sum" and "sum the rows, then convert" agree.
The reports kept rounding one level up: a part's reading -- `knownSubtotal`, a
`roundMoney(...)` result, a four-place row value -- went into the next figure as
if it were a component. The total then depends on how the rows were grouped
before they were added:

- **Custom report.** A (group, category) cell was read at four places before its
  group added it (`backend/src/reports/report-net-cells.ts`), and the headline
  summed the rounded group values (`calculateSummary`). Two 100.01 EUR receipts
  at 1.2474 USD in one category totalled 249.5049 grouped by category (one cell)
  and 249.5050 grouped by payee or by month with two payees or two months (two
  cells of 124.7525).
- **Spending by Category.** The headline summed the rounded category rows, so the
  same rows totalled 249.5049 rolled up to the parent and 249.5050 with the two
  subcategories shown.
- **Cash Flow Sankey.** A parent and each of its children were read on their own.
  The parent read 249.5049 and its children 124.7525 + 124.7525, the closing
  identity (INV-SANKEY-001) failed, and the report answered a 500.

## 2. Three precisions

| Precision | Applies to | Rule |
| --- | --- | --- |
| Posted | a stored amount: a transaction's `amount`, a balance, a trade's `total_amount`, a transfer's two amounts, a row's own rate | `moneyDecimalsFor(currency.decimalPlaces)`, rounded by the write (`applyFxConversion`). Authoritative: a report never replaces it by an amount recomputed from a rate (INV-FX-002, INV-TRADE-001). |
| Calculation | a reporting-only conversion, and every sum, difference and negation of them | `FxAggregate`: each component on its decimal digits at twelve places (`toScaledUnits`), summed in a `BigInt`. Nothing is rounded to money precision inside a calculation. |
| Output | a figure handed to a reader or a consumer | Rounded once, from its calculation-precision value, at the precision it is presented at, half away from zero for both signs (`roundMoney`). Section 6 decides what that precision is on the wire. |

## 3. Rules

1. **A posted amount is the fact.** Rounding that executes or posts a
   transaction is the write's (`applyFxConversion`, `deriveInvestmentTotal`); a
   report reads the stored amount and converts it, and a row that carries its own
   rate converts at that rate (INV-FX-002).
2. **An intermediate figure folds as its aggregate, never as its reading.** A
   cell, a category, a month or a node enters the figure above it through
   `FxAggregate.merge` or `FxAggregate.mergeNegated`; never
   `agg.addConverted(part.knownSubtotal)`, `sumMoney(rows.map((r) => r.total))`
   or `roundMoney(a) + roundMoney(b)`. A row's rounded value is the row's answer
   and goes nowhere else.
3. **Each row converts at its own rate.** Amounts are summed before conversion
   only within one rate basis (`rateBasisColumnsSql` / `RATE_BASIS_GROUP_BY` in
   `backend/src/built-in-reports/report-currency.service.ts`); a sum over two
   rates is converted part by part (`splitByRateBasis`).
4. **A total is the single rounding of the exact sum of its components.** For an
   additive figure that holds each component once, it is the same whatever the
   grouping, the sort order, the view type or the export. A report's own
   definitions still decide which components it holds: a category nets within
   one group (INV-REPORT-004), so a grouping that changes what nets together can
   change what is kept; that is the report's definition, not rounding. A total
   need not equal the sum of the rounded rows above it: each row is within half
   a unit of its own value, and the total is the right figure. The same holds
   for a net or a variance on one row: the custom report's budget variance is
   actual less plan, rounded once, so it can sit a unit from the row's rounded
   `actual` less its rounded `budgeted`. One definition keeps the sum of what it
   shows and says so where it is computed: a tag bucket's window flows are the
   sum of its per-period flows (I8 of `docs/specs/report-tag-key-breakdown.md`).
   One residual is recorded rather than defined: the Monthly Comparison reads
   each month's figures from Income vs Expenses and Spending by Category, so its
   change is the difference of two rounded figures, rounded, and can sit a unit
   from the exact change until those reports hand it their aggregates.
5. **A direction or threshold decision reads the sign before rounding.** "Is this
   category spending", "is this net income", "is this figure zero" read
   `FxAggregate.sign`: a net of 0.00003 is money in though it reads 0.0000. A
   net that is float residue is zero: one under half of 0.00000001 (finer than
   any amount the ledger holds), or one within 2^-50 of its components' summed
   size, the most a sum of converted doubles can carry (16,768.69 at
   9731.4245182213 refunded in two parts nets to -0.00000002 in doubles).
6. **A presentation that must add up apportions.** Where parts must sum to their
   parent (the Sankey's links), the parent is its own single rounding and the
   parts are apportioned from it by largest remainder
   (`FxAggregate.apportionUnits`): each part is its value rounded down or up by
   at most one unit, ties to the lower key. A total is never rebuilt as the sum
   of its rounded parts.
7. **Completeness travels with the aggregate.** `merge` and `mergeNegated` carry
   the missing pairs and the unknown count; a total withheld for a missing rate
   stays withheld whichever grouping folded it
   (`docs/financial-calculation-contract.md` section 1).
8. **A small figure keeps its sign and its row.** Rounding never flips a sign and
   a row whose value reads as zero is still a row when its sign says it moved
   money (rule 5). Averages, ratios, percentages and returns are not additive
   and keep their own formulas, computed from the unrounded aggregates.

## 4. Numerical examples

USD reporting currency, EUR rows at 1.2474 unless stated.

| Case | Before | After |
| --- | ---: | ---: |
| Custom report, two 100.01 EUR receipts, one category, grouped by category | 249.5049 | 249.5049 |
| The same rows, two payees, grouped by payee | 249.5050 | 249.5049 |
| The same rows, two months, grouped by month | 249.5050 | 249.5049 |
| Spending by Category, two subcategories of 100.01 EUR each, rolled up | 249.5049 | 249.5049 |
| The same, subcategories shown | 249.5050 | 249.5049 (rows 124.7525 each) |
| Sankey depth 2, the same two subcategories | 500 | parent 249.5049, children 124.7525 + 124.7524 |
| Sankey, two such expense categories: expense total | 249.5050 | 249.5049 |
| A category of -100.00 EUR at 1.2 and +100.00 EUR at 1.2000003 | dropped (reads 0) | kept on the income side, reads 0.0000 |
| A lone component of -0.00005 | -0.0001 | -0.0001 (half away from zero, Discussion #2136) |
| +300000000000.03 and -300000000000.03 | 0 | 0 (Discussion #2343) |

The apportionment in row 6: each child is 124.752474, so each floors to
124.7524 with a remainder of 0.000074; the parent reads 249.5049, one unit more
than the floors' 249.5048, and the tie goes to the lower key.

## 5. Stage 1: what this branch changes

- `FxAggregate.mergeNegated`, `sign`, `unroundedSubtotal` (for a mean or a
  share) and `apportionUnits`.
- The Cash Flow Sankey (`cash-flow-sankey-assembly.ts`): each side's total is
  rounded once and its nodes, a depth-2 parent's children and a class's
  accounts are apportioned (rule 6); a category's side is judged on its sign
  (rule 5).
- The custom report (`report-net-cells.ts`, `report-rows.ts`): a cell folds
  into its group exactly; the headline, the average, the budget variance and
  the shares are worked out from the rows' aggregates; the transaction list's
  headline folds unrounded values.
- The built-in reports: Spending by Category, by Payee, the Monthly Spending
  Trend, Income by Source, Income vs Expenses (each period and the window, a
  tag bucket's per-period flows), Year over Year, Weekend vs Weekday, the Tax
  Summary, Recurring Expenses, Bill Payment History and the Monthly Comparison
  fold their parts' aggregates; each spending or income decision reads the sign.
- `convertDatedRows` / `convertRateParts` round each figure once from its
  dated parts, and `convertDatedRowAggregates` / `convertRatePartAggregates`
  hand the aggregates to a caller that folds further (the analytics summary).
- The AI aggregators: insights, forecast, and the analytics groups' direction
  decisions.
- The client's `sumConverted` (`frontend/src/lib/currency-total.ts`)
  accumulates its converted components with eight guard places, as
  `FxAggregate` does, so a client total of converted rows agrees with the
  server's.

## 6. Open decision: the precision of a figure on the wire

A report figure leaves the server rounded at four places
(`FIAT_MONEY_DECIMALS`), and the screen rounds it again at the currency's own
places (`useNumberFormat().formatCurrency`). That is two roundings in series:
2.50498 leaves as 2.5050 and shows as 2.51, where the direct rounding is 2.50.
It happens to a figure whose calculated value sits less than half a
ten-thousandth below a cent's midpoint, about one converted figure in two
hundred, and moves it by one cent. Rule 2 cannot reach it, because the second
rounding happens on another machine. The options:

- **(a) Keep four places on the wire** and record the one-cent double rounding
  as a documented residual of the screen.
- **(b) Round each report figure on the server at the reporting currency's own
  places** (2 for USD, 0 for JPY, 8 for BTC). Screen, CSV, PDF and the AI tools
  all see the same figure; the sub-cent detail a CSV shows today goes, and so
  does the Sankey's ten-thousandth unit, which becomes the currency's minor unit.
- **(c) Send each report figure at calculation precision** and round only at
  presentation: the screen at the currency's places, a CSV at the precision it
  documents. Additive identities then hold on the unrounded values and the
  Sankey needs no apportionment; client code that adds wire values must
  accumulate as `FxAggregate` does.

Until it is decided, stage 1 keeps (a).

## 7. Stage 2: the client and the exports

The client still builds several totals from rounded rows, rounds chart values to
whole units before a total or a CSV reads them, and writes some PDFs unformatted.
Those surfaces are listed, file by file, in
`docs/future-plans/report-rounding-and-aggregation-tasks.md`; each follows
rules 2, 4 and 8 and section 6's decision, and none changes a report's own
definition of what it counts.

## 8. Test matrix

| Rule | Test |
| --- | --- |
| 2, 4 | the custom report over generated ledgers (two currencies, a rate per date to ten places, income and expense categories, large amounts, values near a midpoint): the headline is the same grouped by category, payee, month and day and unaggregated, and equals one `FxAggregate` over every row. The categories are sign-consistent (no refunds), so no grouping changes what nets (rule 4); the section 4 rows for the custom report and Spending by Category |
| 5, 8 | a category netting 0.00003 is kept; one netting to a float residue is not, at a cent's scale and at 163 million; `FxAggregate.sign` over both bounds |
| 6 | the Sankey over generated two-currency ledgers: closes at depth 1 and 2, depth moves no total, each side's total equals one `FxAggregate` over that side's rows; the section 4 Sankey rows; `apportionUnits` keeps every part within one unit and sums to the whole's reading |
| 7 | `mergeNegated` carries missing pairs and the unknown count |
| client | `sumConverted` agrees with `FxAggregate` over the same converted components |

Each test is seen failing on the code before this branch
(`docs/financial-calculation-contract.md` section 8.2).
