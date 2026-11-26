# Signed monetary values in reports

Draft for [discussion #2404](https://github.com/kenlasko/monize/discussions/2404). The current contract is [INV-REPORT-004](../system-invariants.md#inv-report-004----a-categorys-cost-is-its-signed-sum-within-the-category). This proposal changes the meaning of some existing report fields. Approval and the compatibility decision below are pending.

## Financial definitions

- A cash movement carries its sign relative to the account selected by the report. For a Custom Report measuring net movement, sum the signed, eligible components in the reporting currency. Select the report population before aggregating. Form each total once from its underlying components using the [rounding contract](report-rounding-and-aggregation.md).
- The overall net for a fixed population is independent of sorting and disjoint grouping. A group may legitimately have a negative or zero net. Preserve the underlying qualifying activity, including when a group sums to zero. Overlapping tag groups require a deduplicated population for the headline. Reconcile component identity with [#2403](https://github.com/kenlasko/monize/discussions/2403).
- A classified spending measure is the negative of the signed sum of qualifying expense components. A classified income measure is the signed sum of qualifying income components. A refund retains its expense classification and an income reversal retains its income classification. A specialized report may show ordinary spending as positive. When refunds exceed purchases it must also represent negative net spending.
- Each metric specifies its own population, denominator and unit. A count counts the defined units. A mean uses its own signed numerator and defined count. A missing conversion propagates through the existing completeness contract. A fully known zero is a monetary value. The API, table, accessible chart data and exports use the same values for the same metric.

## First proposed behavior change

Custom Reports with `Direction = Both` and `Metric = Total Amount` expose net movement. Cover ungrouped totals and disjoint groupings. The ungrouped `No Aggregation` list is a comparison against the same inputs. Preserve a signed row for each group and an independently correct grand total. With transfers in scope, each qualified leg contributes its own signed value. With both legs included at consistent valuation, their combined net is zero.

For this first change, keep separate tests for the existing behavior of the other metric/direction combinations, including grouped `No Aggregation`, `Average`, `Count` and budget variance. Any later change to their semantics needs its own examples. A report configured with overlapping tags needs an independently derived headline before a signed total is released there. Confirm ownership of the shared component rule with the contributor working on #2403. Test non-overlapping tag groups too.

**Decision requested from Ken.** We propose applying the signed definition to existing saved `Both / Total Amount` reports on their next run, with a release note describing the change from sums of unsigned category amounts. For example, a saved report listing +1,000 in salary, −100 in purchases and +30 in refunds would change from 1,070 to 930. Its sort order can change too. A requirement to preserve the historical unsigned measure would require an explicit distinction in the saved configuration and visible labels before switching the default. Earlier work intentionally kept the unsigned aggregate. [Issue #1996](https://github.com/kenlasko/monize/issues/1996) · [PR #2000](https://github.com/kenlasko/monize/pull/2000)

**Reporting surfaces.** For the signed measure, use the existing net amount label, or net cash movement when transfers are included. Check the headline, rows, chart axis or fallback, tooltip, CSV/PDF where supported, and other consumers of the same result. When a pie cannot encode the signed data, the table or a signed chart must still expose the figures. A net of zero has no defined denominator for percentage-of-net shares.

**Recomputation and concurrent access.** The proposed change reads the saved configuration and the eligible ledger rows at execution time. There is no stored report result or balance to recalculate as part of this change. Compare groupings against the same ledger state; edits posted between requests can legitimately change the answer. Keep execution inside the existing scoped database access and test repeat execution of the same saved report. If rollout selects versioned behavior, define the version and its effect on existing configurations before enabling it.

## Acceptance examples

Fixtures below use one currency. Each expected value is calculated from the listed movements and their known classification. Compare each execution with the independent expected result as well as with the other views.

| Scenario | Expected result |
| --- | --- |
| Salary +1,000 and expense −700 | Net +300. Reordering the rows preserves +300. |
| Expense −700 alone | Net −700. |
| Purchase −100 and refund +30 | Net −70. Classified spending +70. |
| Purchase −100 and refund +150 | Net +50. Classified spending −50. |
| Purchase −100 and refund +100 | Net 0. Both operations remain accessible. |
| Income +100 and reversal −150 | Net income −50. The income category remains identifiable. |
| Purchase −100 in September, refund +100 in October | September −100, October +100, both months together 0. |
| Same additive metric with and without grouping | Example +1,000, −100, +30 gives +930 per full-period headline in all disjoint layouts and in the signed list. |
| Internal transfer −500 and +500 | Both accounts net to 0. Selecting just the source gives −500, just the destination +500, when transfers are included. |
| Expense budget 100, purchase −100 and refund +150 | Net actual spending −50. A remaining-budget measure defined as budget less actual gives 150. Verify each variance using its documented direction. |
| Equivalent qualifying standalone row and split component | Equal net, with each component counted once. With the same category and scope, a −5 fee contributes −5 in each representation. |
| Net spending by category and by payee | Same complete filtered population of −100 and +150 gives −50 in both reports. Category and payee rows remain identifiable. |
| Same metric in the table, chart and export | Retain the signs of both −100 and +100 and their zero total. Preserve access to rows on charts that cannot draw mixed signs. |

Additional controls for the first change include a known zero with records, a partial total when an FX rate is missing, a genuinely empty selection and a report opened from a previously saved configuration. Use the existing signed/precision rules for amounts that display as zero. The [implementation plan](../future-plans/report-sign-conventions.md) identifies where each family of tests belongs.
