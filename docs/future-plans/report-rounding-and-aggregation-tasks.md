# Tasks: a report figure is rounded once, from its own components

Plan: [`report-rounding-and-aggregation.md`](./report-rounding-and-aggregation.md).
Spec: [`docs/specs/report-rounding-and-aggregation.md`](../specs/report-rounding-and-aggregation.md).

## 1 backend folds and the client accumulator (issue #2384)

- [x] Spec, plan, task list; `docs/financial-calculation-contract.md` rule; `docs/system-invariants.md` entry.
- [x] `FxAggregate.mergeNegated`, `sign`, `apportionUnits`, with tests.
- [x] Cash Flow Sankey: sides rounded once, nodes, children and accounts apportioned; side judged on the sign; two-currency property spec.
- [x] Custom report: cells fold exactly; headline, average, budget variance and percentages from the aggregates; the transaction list's headline folds unrounded values; property spec over groupings.
- [x] Built-in reports: Spending by Category, by Payee, Monthly Spending Trend; Income by Source, the period rows and tag buckets; Year over Year savings; Weekend vs Weekday; Tax Summary; Recurring Expenses; Bill Payment History; Monthly Comparison; `convertDatedRows`.
- [x] AI aggregators: insights, forecast, transaction analytics.
- [x] Client `sumConverted` accumulates as `FxAggregate` does.

- [x] Monthly Category Breakdown accumulates as aggregates; the monthly net worth and an account's portfolio gain are single differences (`FxAggregate.difference`); the transactions widget reads the server's net.
- [x] `report-rounding.guard.spec.ts` holds rule 2's mechanical forms.
- [x] The Monthly Comparison's changes from the months' aggregates rather than their rounded figures (the spec's rule 4 residual, issue #2407).
- [x] The assistant's and MCP's flow totals (`convertedFlowFields`) and the portfolio summary's headline gain are single differences.
- [ ] The transactions widget's net for a partial summary still subtracts the two rounded known sides: the server could send a known net beside `knownIncome` / `knownExpenses` (an additive field on the analytics summary and its MCP schema).
- [x] Budget Health (`backend/src/budgets/budget-health-reports.service.ts`): a month's income with no income line is one aggregate over its native rows and its converted foreign parts (`convertRatePartAggregates`), the toggle's transferred-in income folds in from its aggregate (`resolveOutsideTransferIncomeAggregate`), savings is `FxAggregate.difference` and the rate is worked out from the unrounded figures (issue #2408). The income-line and expense sides still add each line's own four-place actual, as the budget page shows it.

## 2 the precision of a figure on the wire

- [x] The maintainer's choice of the spec's section 6 option: (b), a report figure rounded on the server at the reporting currency's own places (issue #2384, 2026-11-24).
- [ ] Its implementation, in its own PR: every report figure (built-in, custom, Sankey, AI/MCP report tools) rounded once at `currency.decimal_places` on the server; the Sankey's unit becomes the currency's minor unit, and a category node apportioned from its side can then read a cent off the same category in Spending by Category (the spec's rule 6 choice, to be said beside the node); fixtures and the section 4 examples restated at currency places.

## 3 client surfaces

Found by the sweep of 2026-11-24; each is confirmed and fixed in its own PR.

Totals built from rows the client rounded to whole units, and CSVs that write those whole units:

- [ ] `frontend/src/components/reports/MonthlySpendingTrendReport.tsx`: the table footer, cards and PDF cards sum `Math.round` rows; the response carries `totals`.
- [ ] `frontend/src/components/reports/IncomeVsExpensesReport.tsx` and `IncomeVsExpensesTable.tsx`: savings and the CSVs from `Math.round` values; the response carries `net` and `totals`.
- [ ] `frontend/src/components/reports/NetWorthReport.tsx`, `frontend/src/components/dashboard/NetWorthChart.tsx`: the tooltip's net and the change from rounded parts; the CSV writes whole units.
- [ ] `frontend/src/components/dashboard/AssetsVsLiabilities.tsx`: a slice under 0.50 is dropped and the share denominator sums rounded slices.
- [ ] `frontend/src/components/reports/TaggedBalanceTooltip.tsx`: a tagged outflow under 0.50 disappears from the tooltip.
- [ ] `frontend/src/components/reports/YearOverYearReport.tsx`: the CSV writes rounded monthly cells, a missing month as 0.
- [ ] `frontend/src/components/dashboard/MonthlySpendingTrendWidget.tsx`, `frontend/src/components/dashboard/PortfolioValueWidget.tsx`: a whole-unit value shown through a full-precision formatter.

Totals the client sums where the server has one, or has none to give:

- [ ] `frontend/src/components/reports/ReportChart.tsx`: the share denominator and the fallback total are client sums; for an average metric a sum of averages.
- [ ] `frontend/src/components/reports/CashFlowReport.tsx`: the PDF's total rows come from another endpoint than its rows.
- [ ] `frontend/src/components/reports/AccountBalancesReport.tsx`: `chartTotal` is a float sum shown as "Total" with no partial marker; the CSV writes formatted strings.
- [ ] `frontend/src/components/reports/MonthlyCategoryBreakdownReport.tsx`, `frontend/src/lib/monthly-funds-summary.ts`: every total is built on the client from rounded rows.
- [ ] `frontend/src/components/reports/RealizedGainsReport.tsx`, `DividendIncomeReport.tsx`, `DividendYieldGrowthReport.tsx`, `SecurityPerformanceReport.tsx`, `SecurityTypeAllocationReport.tsx`, `CurrencyExposureReport.tsx`, `frontend/src/lib/geographic-allocation.ts`: float totals over client-converted rows.
- [ ] `frontend/src/components/reports/PortfolioValueReport.tsx`: the tooltip total from bands; the CSV writes an unknown band as 0.
- [ ] `frontend/src/components/reports/sankey-layout.ts`: merged links and the "Other" node are float sums (presentation only; INV-SANKEY-005 keeps them off the figures).
- [ ] `frontend/src/components/reports/ForeignCurrencyFeesReport.tsx`: month and grand totals re-sum rounded server totals.
- [ ] `frontend/src/components/reports/WeekendVsWeekdayReport.tsx`: the share denominator is a client sum of two server totals.
- [x] `frontend/src/components/reports/UpcomingBillsReport.tsx`: totals through `sumEffectiveOccurrences` (fixed by the accumulator in stage 1).
- [ ] `frontend/src/lib/currency-total.ts`: `combineTotals` combines its totals' rounded values (a net worth of rounded assets less rounded liabilities); its callers are `frontend/src/app/accounts/page.tsx`, `frontend/src/app/bills/page.tsx`, `AccountBalancesReport.tsx` and `frontend/src/components/transactions/register-style-data.ts`.

Exports:

- [ ] `frontend/src/components/reports/BillPaymentHistoryReport.tsx`, `RecurringExpensesReport.tsx`, `DuplicateTransactionReport.tsx`, `RealizedGainsReport.tsx`: the PDF prints raw numbers (`frontend/src/lib/pdf-export-tables.ts` formats nothing).
- [ ] `frontend/src/components/reports/MonteCarloReport.tsx`: the CSV writes `toFixed(2)` strings.
- [ ] `frontend/src/components/reports/InvestmentReportViewer.tsx`: the CSV writes an unrounded product.
- [ ] One documented export precision in `docs/frontend/financial-figures.md`, following section 6.
