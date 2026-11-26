# Financial signs in report calculations

Review draft for [#2404](https://github.com/kenlasko/monize/discussions/2404). The [proposed contract](../specs/report-sign-conventions.md) holds the financial definitions, worked examples and saved-report decision. The [task list](report-sign-conventions-tasks.md) tracks delivery.

## Current behavior and first review

On baseline `db2ad3e`, `ReportsService.execute` selects eligible transactions and delegates grouped settlement to `backend/src/reports/report-net-cells.ts`. That function folds the magnitude of each category cell for Both. Splitting a purchase and its refund over two months creates two cells. The signed transaction list follows a separate path. Existing backend unit and database integration tests explicitly check the current convention. The viewer distinguishes signed lists and unsigned aggregates through `frontend/src/lib/custom-report-measure.ts`. A saved report stores direction, metric and sort settings; its configuration has no version for the sign convention.

A PostgreSQL 18.7 baseline ran four saved configurations per scenario: the transaction list, an ungrouped total, a category total and a monthly total. In the seven Both scenarios, all seven lists matched the signed reference. Five of the 21 aggregate results matched. The two-month full refund returned 0 by category and 200 by month; the category retained both transactions. The linked transfer had a list net of 0 and an aggregate of 1,000 in all three layouts. A separate Expenses Only control returned +700 for a single −700 row, including in the list. That control belongs to the later direction-filter decision. These checks ran with single-currency USD rows through `ReportsService.execute` and the repository's database test harness.

The behavior in this draft PR is the first reviewable proposal. Apply signed totals on rerun, including to previously saved reports, and update INV-REPORT-003 (account movement and transfers) and INV-REPORT-004 (category aggregation). INV-REPORT-005 supplies the rounding rule. Maintainer acceptance of this compatibility choice is pending.

## Client checks independent of the compatibility decision

With the current frontend and a signed response supplied at the API boundary, the viewer, CSV and PDF retain a negative amount. All three still label a Both / Total Amount aggregate “Total of unsigned category amounts.” With September −100 and October +100, the table lists both months and shows zero, while the aggregate pie draws no sectors. The signed transaction-list control draws two sectors for those same values. Test the renderer with mixed values, a negative value alone and a known zero. Use the same definition of the measure in the headline, table, geometry, tooltip and exports. Assert the actual cells written to CSV and PDF.

The demo Custom Report named “Income vs Expenses” is an existing fixture of Both / Total Amount by month in `backend/src/database/demo-seed-data/reports.ts`. Include this configuration in compatibility checks, along with a report restored from an older backup. The integration test executes and reloads an existing-format saved configuration with no sign setting or schema migration, including its amount sort.

## Delivery sequence

1. **Custom Reports.** Change the shared handling of Both / Total Amount and its consumers together. Audit every group-by route, saved-report viewer and export that reads this metric. Use the remaining metrics as controls for accidental changes to shared code. Work with #2403 on which components are included in split transfers and overlapping tag groups. A release covering overlapping groups must show a correct overall total when an operation appears in multiple groups.
2. **Economic reporting.** Establish each report's population and sign convention, including the handling of uncategorized activity. Compare Spending by Category and Spending by Payee on identical eligible transactions; an explicitly purchase-only measure needs its own label and population. Cover negative or zero category nets in Income by Source and Tax Summary, and follow the same values through dashboard and analytics consumers.
3. **Budget actuals.** Trace the net actual through the shared budget calculation, variance, trend and displayed totals. Separate economic spending from transfer funding. Verify the defining budget equation with a refund greater than current-period purchases.
4. **Release coordination.** Run the common fixture through all affected surfaces, including reports saved before the change. Confirm which earlier report values, labels and sorting change. Develop in reviewable PRs and agree on a release boundary before exposing incompatible definitions across surfaces. Dependency and SQL schema changes have no place in the first slice unless approved separately.

## Verification points

- Run the service unit suites for `report-net-cells` and `reports.service`. Exercise saved report execution against PostgreSQL using `backend/test/integration/report-custom-net-and-search.integration.spec.ts`; include both transfer legs and their individual account scopes.
- Assert row identity, count, sign, subtotal and headline. Exercise the specific filter or grouping through the public execution method. Permute row order and partition one population by disjoint keys, using an independent signed sum. Compare signed rows when the aggregate net is zero.
- Verify signed labels and rendering in `custom-report-measure.test.ts`, `CustomReportViewer.test.tsx` and `ReportChart.test.tsx`. Check displayed values and exported cells for the same inputs, including negative and mixed-sign groups.
- Before requesting review, run each affected layer's checks listed in `AGENTS.md`, rebase on the current upstream main, and link the approving discussion. Execute database-backed suites serially on a disposable database.
