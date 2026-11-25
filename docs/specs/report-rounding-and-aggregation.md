# Spec: a report figure is rounded once, from its own components

Status: approved on issue #2384 (2026-11-24; discussion #2382). Rules 1 to 8
restate the contract the issue agreed; section 6 records the maintainer's
choice of option (b). Stage 1 (section 5) landed with PR #2405; stage 2
(section 6, issue #2410) lands on `claude/issue-2410`; stage 3 (section 7)
follows in its own PRs.
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
| Calculation | a reporting-only conversion, and every sum, difference and negation of them | `FxAggregate`: each component on its decimal digits (`toScaledUnits`), held at its fifteen significant digits and never at fewer than twelve places, summed in a `BigInt` that counts to 10^-20. A component whose exact value has at most fifteen significant digits is held exactly; the client's `sumConverted` holds its components the same way. Nothing is rounded to money precision inside a calculation. |
| Output | a figure handed to a reader or a consumer | Rounded once, from its calculation-precision value, at the precision it is presented at, half away from zero for both signs (`roundMoney`). On the wire that is the reporting currency's own places (section 6): `FxAggregate.knownSubtotalAt(places)` / `totalAt(places)` for an aggregate, `reportFigure(value, places)` for anything else (`backend/src/common/report-figure.ts`). |

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
5. **A direction or threshold decision reads the sign before rounding.** "Is this
   category spending", "is this net income", "is this figure zero" read
   `FxAggregate.sign`: a net of 0.00003 is money in though it reads 0.0000. A
   net that is float residue is zero: one under half of 0.00000001 (finer than
   any amount the ledger holds), or one within 2^-51 of its components' summed
   size, over the 3 x 2^-53 a sum of converted doubles can carry (16,768.69 at
   9731.4245182213 refunded in two parts nets to -0.00000002 in doubles).
6. **A presentation that must add up apportions.** Where parts must sum to their
   parent (the Sankey's links), the parent is its own single rounding and the
   parts are apportioned from it by largest remainder
   (`FxAggregate.apportionUnits`): each part is its value rounded down or up by
   at most one unit, ties to the lower key. A total is never rebuilt as the sum
   of its rounded parts. This is a recorded choice with a cost: the Sankey
   apportions a whole side, so a category node can read one unit off its own
   rounding, and so off the same category in Spending by Category. The unit is
   the reporting currency's minor unit (section 6), a visible cent: two
   subcategories of 1.00 EUR at 1.2474 read 1.25 each in Spending by Category
   and 1.25 and 1.24 under their 2.49 parent in the Sankey. The choice stands
   (closure is the diagram's invariant, INV-SANKEY-001), and the page says so
   beside the node (`sankey.roundingNote`).
7. **Completeness travels with the aggregate.** `merge` and `mergeNegated` carry
   the missing pairs and the unknown count; a total withheld for a missing rate
   stays withheld whichever grouping folded it
   (`docs/financial-calculation-contract.md` section 1).
8. **A small figure keeps its sign and its row.** Rounding never flips a sign and
   a row whose value reads as zero is still a row when its sign says it moved
   money (rule 5). Averages, ratios, percentages and returns are not additive
   and keep their own formulas, computed from the unrounded aggregates.

## 4. Numerical examples

USD reporting currency, EUR rows at 1.2474 unless stated. "After" is the
figure on the wire at USD's two places (section 6); "Before" is what left the
server before stage 1, at four places, and in brackets what the screen then
showed.

| Case | Before | After |
| --- | ---: | ---: |
| Custom report, two 100.01 EUR receipts, one category, grouped by category | 249.5049 (249.50) | 249.50 |
| The same rows, two payees, grouped by payee | 249.5050 (249.51) | 249.50 |
| The same rows, two months, grouped by month | 249.5050 (249.51) | 249.50 |
| Two 1.00 EUR receipts, two payees, grouped by payee | 2.4948 (2.49) | 2.49 (rows 1.25 each) |
| Spending by Category, two subcategories of 100.01 EUR each, rolled up | 249.5049 (249.50) | 249.50 |
| The same, subcategories shown | 249.5050 (249.51) | 249.50 (rows 124.75 each) |
| Sankey depth 2, the same two subcategories | 500 | parent 249.50, children 124.75 + 124.75 |
| Sankey depth 2, two subcategories of 1.00 EUR each | parent 2.4948, children 1.2474 + 1.2474 | parent 2.49, children 1.25 + 1.24 |
| Sankey, two 100.01 EUR expense categories: expense total | 249.5050 (249.51) | 249.50 |
| A category of -100.00 EUR at 1.2 and +100.00 EUR at 1.2000003 | dropped (reads 0) | kept on the income side, reads 0.00 |
| A lone component of -0.005 | -0.0050 (-0.01) | -0.01 (half away from zero, Discussion #2136) |
| +300000000000.03 and -300000000000.03 | 0 | 0 (Discussion #2343) |
| 1.00 EUR at 2.50498 | 2.5050 (2.51) | 2.50 |
| JPY reader, two 1.00 EUR rows at 162.3456, two payees | 324.6912 (325) | 325 (rows 162 each); Sankey children 163 + 162 |

The apportionment in the 1.00 EUR Sankey row: each child is 1.2474, so each
floors to 1.24 with a remainder of 0.0074; the parent reads 2.49, one cent more
than the floors' 2.48, and the tie goes to the lower key. In yen each child of
162.3456 floors to 162 and the parent, 324.6912, reads 325.

## 5. Stage 1: what this branch changes

- `FxAggregate.mergeNegated`, `sign`, `unroundedSubtotal` (for a mean or a
  share) and `apportionUnits`.
- The Cash Flow Sankey (`cash-flow-sankey-assembly.ts`,
  `cash-flow-sankey-figures.ts`): each side's total is
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
- Monthly Category Breakdown accumulates as aggregates rather than floats; the
  monthly net worth and an account's portfolio gain are single differences
  (`FxAggregate.difference`); the transactions widget
  (`frontend/src/components/transactions/widget-shared.ts`) reads the server's
  `knownNet`, the known sides' single difference on a partial summary as on a
  complete one, rather than rebuilding it from the two rounded sides.
- `backend/src/common/report-rounding.guard.spec.ts` fails rule 2's mechanical
  forms: an `addConverted`, `add`, `sumMoney`, `+=`, `-=`, `+` or `-` over an
  aggregate's reading, and an `isNetSpending` over a reading or a `roundMoney`.
- The client's `sumConverted` (`frontend/src/lib/currency-total.ts`)
  accumulates its converted components with eight guard places, as
  `FxAggregate` does, so a client total of converted rows agrees with the
  server's.

## 6. Decision: a report figure is rounded on the server at its currency's places

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

**Decided on issue #2384: option (b), in its own PR (stage 2).** The question
posted on the issue on 2026-11-24 laid out (a), (b) and (c), recommended (b) in
its own PR, and recommended opening stage 1 as "Part of #2384" with stages 2
and 3 to follow; the maintainer replied "Go with the recommendations". Each
report figure is then the single rounding of its calculated value at the
reporting currency's own places, done on the server, so the screen's rounding
of it is the identity and the CSV, the PDF and the AI tools read the same
figure. Discussion #2382 also suggested two CSV modes (formatted and full
precision); the issue as filed left that out, and (b) does not include it: a
full-precision export would be its own proposal. Stage 1 kept four places on
the wire; stage 2 removes the one-cent double rounding.

**Stage 2 (issue #2410).** What it changes:

- **One read.** `FxAggregate.knownSubtotalAt(places)` and `totalAt(places)` read
  an aggregate once at the places given, `reportFigure(value, places)` rounds a
  figure that is not an aggregate (a mean, one converted row, a stored rollup)
  the same way, and `apportionUnits(parts, places)` apportions in `10^-places`
  units. The places are the screen's: `reportPlacesFor` / `reportPlacesOf` /
  `ReportCurrencyService.getReportPlaces` answer the ISO minor unit, else the
  currency row's `decimal_places` (2 for USD, 0 for JPY, 8 for a coin), which is
  what `useNumberFormat().formatCurrency` formats at. `knownSubtotal` and
  `total` keep reading four places for the figures that are not report figures;
  `report-rounding.guard.spec.ts` fails a `knownSubtotal` read in the report
  engines (`backend/src/built-in-reports`, `backend/src/reports`) outside a sort
  comparator.
  The accumulator kept twelve places then, so a reading at a coin's eight
  keeps four guard digits: sixteen fixed places kept the float noise of
  `amount * rate` and moved a custom report's share to 25.000000000000007.
  Issue #2414 found twelve fixed places too coarse for a small component
  (section 7): each is now held at its fifteen significant digits, past which
  a double's noise sits, and never at fewer than twelve places.
- **Every report figure reads there.** The built-in reports (Spending by
  Category and by Payee, the Monthly Spending Trend, Income by Source, Income
  vs Expenses with its tag buckets, Year over Year, Weekend vs Weekday, the Tax
  Summary, Recurring Expenses, Bill Payment History, the Monthly Comparison,
  the Monthly Category Breakdown, Spending Anomalies, the Uncategorized
  Transactions summary, the Duplicate Transactions report's potential impact,
  which added each group's amount in its own currency and now converts each
  extra copy at its own row's rate basis); the custom report, including the transaction list's
  `value`, which left unrounded; the Cash Flow Sankey, apportioned and closed in
  the currency's minor unit; the monthly net worth and what reuses it (the account summary's
  latest month, the assistant's net worth history, each month's change from
  the one before, `netWorthChange`, which the dashboard's month change reads,
  and the dashboard trivia's gains and falls, each a difference of two months'
  aggregates read once); Budget Health's savings
  figures, the budget trend and category trend, the seasonal patterns, the
  daily spending and the flex groups, at the budget currency's places; the
  portfolio summary (`PortfolioService.getPortfolioSummary`: the Investments
  page, the Portfolio Value and Investment Performance reports,
  `get_portfolio_summary`), whose reporting-currency totals and allocation read
  at the reporting currency's places, whose Total Gain
  (`totalGainOverNetInvested`) is the value less net invested read once, and
  whose accounts' totals read once at each account currency's money precision
  (four places for a fiat code, a coin's own), since the client still adds
  them to the cash balance; the Portfolio Value report's series (the daily series it
  and the dashboard draw, `getDailyInvestmentsReport`, the month-end sampled and
  the monthly series, and the by-security breakdown, whose security bands are
  apportioned from each point's securities subtotal as the Sankey's are and
  whose cash band is the point's total less that subtotal, so the total less
  the cash band is the invested value the daily series reports for the day);
  and the assistant's and MCP's
  report tools: `generate_report` hands out the reports' own figures, and the
  flow totals, the grouped breakdown and `compare_periods` read at the
  reporting currency's places, the summary lines of `compare_periods`,
  `list_transactions` and `get_portfolio_summary` printing them at those
  places.
- **Rules 4, 5 and 8 at the new precision.** A difference of two readings is a
  visible cent off at two places, so `compare_periods` works each change out
  from the two periods' aggregates and each percentage from the unrounded
  values, over a first period that reads as money at those places; Spending Anomalies folds its
  mean, category spikes and new-payee totals as aggregates instead of adding
  floats. The portfolio's value is its cash and its holdings folded before
  either is rounded, where it added the two readings; an account's net
  invested folds its parts; the gain's percentage, the allocation's shares and
  the CAGR divide the unrounded figures; the exposure-by-tag views regroup the
  allocation's shown slices and say so, summing them exactly. Every direction
  decision still reads `sign`, so a category netting
  0.003 reads 0.00 and keeps its row, and Budget Health gives a savings rate
  only over an income that reads as money at the budget's places.
- **Not report figures, unchanged.** Posted amounts, prices, quantities, rates
  and percentages; the transactions page's grouped and monthly totals and a
  category's or payee's detail breakdown, which keep four places; the AI
  insights and forecast prompts, which a model reads and does not hand out; the
  daily series the period result's P&L, TWR and MWR are worked out from
  (`getDailyInvestments`), which keeps four places so the returns are
  calculated, not read off rounded figures. Until stage 3 (issue #2413, which
  moved those totals to the server), the Foreign Currency Fees report's
  converted rows keep four places too, while the page adds them into its
  month and grand totals: read at two, three 2.50496 fees would total 7.50
  where they come to 7.51 (stage 3 moves those totals to the server).
- **Residuals.** A budget line's actual is a four-place reading
  (`CategorySpending`, INV-REPORT-005's known gap), so a budget figure is the
  two-place reading of a four-place one, as the screen read it before. The
  Monthly Comparison's investment figures come from
  `PortfolioPeriodResultService` at four places and are read at two. A
  holding's own figures in the portfolio summary (its value, cost and gain in
  the security's currency) are left as they were, and the Portfolio Value
  report's intraday (1D) view sums four-place contributions per bar. An
  account's totals stay at its currency's money precision while the
  Investments page's account groups and headline and the Accounts page add
  them to a cash balance on the client (stage 3): read at two places, that sum
  of two readings sat a cent off. The Cash Flow Sankey's unspent or deficit
  is the four side totals' readings netted in the minor unit, which closing
  the diagram needs (rule 6), so it can sit a unit or two off the period's
  net read once (Income vs Expenses' net for the same period).

## 7. Stage 3: the client and the exports

The client still builds several totals from rounded rows, rounds chart values to
whole units before a total or a CSV reads them, and writes some PDFs unformatted.
Those surfaces are listed, file by file, in
`docs/future-plans/report-rounding-and-aggregation-tasks.md`; each follows
rules 2, 4 and 8 and section 6's decision, and none changes a report's own
definition of what it counts.

Issue #2412 (the charts' whole units): a chart of report figures carries the
server's figures, so its table, tooltip, cards and CSV read them; a total or a
net reads the server's (`totals.knownNet`, a month's `netWorth`). The monthly
net worth gains `netWorthChangeFromStart`, each month less the series' first,
the two aggregates' difference read once, for the window's change the Net
Worth report and widget show: the difference of the two end readings sat a
unit off it as the month-on-month change did (rule 4).

Issue #2413 (totals the client summed from rounded rows): a total the
response carries is read, never rebuilt. The custom report's chart reads each
row's server `percentage`, and its Total row the server's headline. The Cash
Flow PDF totals each category table from its own report. Weekend vs Weekday
gains `weekendShare` / `weekdayShare`, divided from the two sides' unrounded
sums (rule 8). A total only the page can build, over the accounts or
schedules the reader's filters chose, folds the exact sums of its parts:
`ConvertedTotal.exact` carries what `sumConverted` accumulated, and
`combineTotals(totals, signs)` rounds the signed sum once. Before that, a net
worth was the assets' reading less the liabilities' reading, so 0.12495 of
assets and 0.00004 of liabilities read 0.1250 and 0.0000 and netted to
0.1250, where the net, 0.12491, reads 0.1249 (rule 2). Account Balances' chart
total and the Sankey's merged figures are summed once in the same way, and
those page totals round once at the currency's own places, where they read
four places and showed two. Weekend vs Weekday also sends each side's mean and
the gap between them (`weekendAverage`, `weekdayAverage`,
`averageDifference`).

Two reports had no server total to read, and gain one. The Monthly & Yearly
Breakdown takes `period=month|year` and the window the page shows, folds a
year's months as aggregates, and sends every row, section, group, balance,
transfer and overall figure and each average, read once
(`monthly-category-breakdown-totals.ts`); three 0.005 months total 0.02, where
the page's sum of the three readings was 0.03. Its funds block asks Income vs
Expenses for `bucket=year`, and each tag-bucket period carries its Balance
from the four aggregates. The Foreign Currency Fees report reads
`GET /transactions/fx-fee-totals`, which folds the chosen accounts' fees and
reads each month, quarter and year, the total and each average once: three
fees of 2.50496 total 7.51, where the four-place rows summed to 7.50 at two
places. A month that lost a fee for want of a rate makes every figure over it
a subtotal (rule 7): its column's `total`, the grand `total` and the
`periodAverage` are `null`, `knownTotal` and `knownPeriodAverage` carry what
converted, and the chart marks the cards and the column partial. The fee
summary's own converted rows then read at the currency's places.

Issue #2414 (the investment reports). Their totals group rows the server
sends one by one (a sale, a dividend, a holding) by a key only the page
chooses (a security, a month, a security type, a currency, an exchange), so
no response carries them: each is a page total. A page total is the exact
sum of its rows' figures, accumulated as `sumConverted` does and read once at
the display currency's places (`pageSum` in `frontend/src/lib/page-total.ts`);
a total over groups folds the groups' exact sums (`foldPageSums`), and a
share, a yield or a growth rate divides the exact sums (`pageRatio`, rule 8).
Two rows of 1.0007 and 1.0143 add to 2.0149999999999997 in doubles, which
read $2.01, where their sum, 2.015, reads $2.02. Realized Gains, Dividend
Income, Dividend Yield Growth, Security Type Allocation, Currency Exposure and
the geographic allocation build their totals this way; a security held in
several accounts rolls up at money precision (`aggregateHoldingsBySecurity`,
which Security Performance reads); Realized Gains marks a total partial when
it leaves a sale out (rule 7). The rows themselves are what the server sends,
at four places for a sale's figures and a holding's value (section 6's
residuals), so a page total is the single rounding of those rows' exact sum.
Portfolio Value's by-security tooltip prints the point's own `total` rather
than adding its bands, and a band absent from a point the server could not
finish is unknown: the table marks it, the CSV writes `N/A`, and the point's
total is withheld with it.

Two cases raised on the same issue. Income by Source divided a source's
reading by the income's: two receipts of 1.00 EUR at 1.2474 in two categories
read 1.25 each over 2.49 and showed 50.2% each. Each source now carries
`percentage`, divided on the server from the unrounded aggregates, so each
reads 50% (rule 8). And the accumulator held each converted component at
twelve places, which rounded a small component's own digits away: 7.681 EUR
at 1.2475589116 is exactly 9.5824999999996 USD, which twelve places read as
9.5825, so two receipts on two dates (or in any report that converts row by
row) summed to 19.165 and read 19.17, while one date's 15.362 EUR read 19.16
(rule 4 broken by the grouping). Each component is now held at its fifteen
significant digits, the most a double holds a decimal at (`DBL_DIG`), and
never at fewer than twelve places: one whose exact value has at most fifteen
significant digits is held exactly, the noise past them still drops, and a
component of 100 or more is held as before. What it cannot reach: a
component whose exact value needs more digits (a large amount at a rate of
ten places), or one divided by a row's own rate, is held at the double's
fifteen, so a sum within that of a midpoint can still read a unit off; only
an exact product of the decimal amount and rate would close the first, and
no decimal holds the second.

## 8. Test matrix

| Rule | Test |
| --- | --- |
| 2, 4 | the custom report over generated ledgers (two currencies, a rate per date to ten places, income and expense categories, large amounts, values near a midpoint): the headline is the same grouped by category, payee, month and day and unaggregated, and equals one `FxAggregate` over every row. The categories are sign-consistent (no refunds), so no grouping changes what nets (rule 4); the section 4 rows for the custom report and Spending by Category |
| 5, 8 | a category netting 0.00003 is kept; one netting to a float residue is not, at a cent's scale and at 163 million; `FxAggregate.sign` over both bounds |
| 6 | the Sankey over generated two-currency ledgers: closes at depth 1 and 2, depth moves no total, each side's total equals one `FxAggregate` over that side's rows; the section 4 Sankey rows; `apportionUnits` keeps every part within one unit and sums to the whole's reading |
| 7 | `mergeNegated` carries missing pairs and the unknown count |
| client | `sumConverted` agrees with `FxAggregate` over the same converted components |
| 6, stage 2 | `knownSubtotalAt`, `totalAt` and `apportionUnits` at 0, 2, 4 and 8 places; a 2.50498 figure reads 2.50 in Spending by Category, Income by Source, the custom report's headline and transaction list, the Sankey and `generate_report` over the real Spending by Category (`reports.tool.rounding.spec.ts`); a JPY report in whole yen and a JPY Sankey that closes; the Sankey property specs over CAD and JPY ledgers; the custom report's generated ledgers against one `FxAggregate` read at two places; the section 4 rows at two places |
| 2, 4, 8, stage 3 | the investment reports' page totals over rows whose float sum drifts below a half-cent (1.0007 and 1.0143 read 2.02), folded groups of 0.005, shares of two equal 1.2474 parts at 50%; Portfolio Value's unknown band and tooltip total; Income by Source's two equal sources at 50%; two 7.681 EUR receipts at 1.2475589116 read 19.16 on one date and on two in `FxAggregate`, Income by Source, the custom report and `sumConverted`; the custom report's generated ledgers against an exact decimal reference (each amount times its rate in integers) under every grouping, and each category's share against its exact ratio |

Each test is seen failing on the code before its stage
(`docs/financial-calculation-contract.md` section 8.2).
