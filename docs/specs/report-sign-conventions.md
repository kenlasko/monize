# Signed monetary values in reports

Draft for [discussion #2404](https://github.com/kenlasko/monize/discussions/2404). The related invariant is [INV-REPORT-004](../system-invariants.md#inv-report-004----a-categorys-cost-is-its-signed-sum-within-the-category). This proposal changes the meaning of some existing report fields. The first change and its effect on saved reports are proposed for maintainer review.

## Financial definitions

- A cash movement carries its sign relative to the account selected by the report. For a Custom Report measuring net movement, sum the signed, eligible components in the reporting currency. Select the report population before aggregating. Form each total once from its underlying components using the [rounding contract](report-rounding-and-aggregation.md).
- The overall net for a fixed population is independent of sorting and disjoint grouping. A group may legitimately have a negative or zero net. Preserve the underlying qualifying activity, including when a group sums to zero. Overlapping tag groups require a deduplicated population for the headline. Reconcile component identity with [#2403](https://github.com/kenlasko/monize/discussions/2403).
- A classified spending measure is the negative of the signed sum of qualifying expense components. A classified income measure is the signed sum of qualifying income components. A refund retains its expense classification and an income reversal retains its income classification. A specialized report may show ordinary spending as positive. When refunds exceed purchases it must also represent negative net spending.
- Each metric specifies its own population, denominator and unit. A count counts the defined units. A mean uses its own signed numerator and defined count. A missing conversion propagates through the existing completeness contract. A fully known zero is a monetary value. The API, table, accessible chart data and exports use the same values for the same metric.

## First proposed behavior change

Custom Reports with `Direction = Both` and `Metric = Total Amount` expose net movement. Cover ungrouped totals and disjoint groupings. The ungrouped `No Aggregation` list is a comparison against the same inputs. Preserve a signed row for each group and an independently correct grand total. With transfers in scope, each qualified leg contributes its own signed value. With both legs included at consistent valuation, their combined net is zero.

For other metric and direction combinations, the first change retains the existing definitions, including grouped `No Aggregation`, `Average`, `Count` and budget variance. Under `Both / Total Amount`, a tag may show a component that also appears under another tag. The headline includes each eligible component once. On this tag headline the count includes a parent transaction once across its eligible splits. Category grouping retains its existing split-line counts. A missing rate withholds the full headline. For this signed total, the same category/currency components are excluded from the known subtotal across all groupings. Other categories and currencies still contribute.

The §4.2 follow-up applies the same signed amounts to grouped No Aggregation and to the numerator of Average Amount. Direction and Category Type select postings before the calculation. Grouped No Aggregation adds those postings. Ungrouped No Aggregation still lists them individually. Average divides their signed sum by the existing unit count for the grouping and rounds the quotient at reporting precision. Tags can overlap: the additive headline includes each posting once, while the weighted average retains its existing group counts.

With both accounts and transfers included in the [March CAD fixture](transfer-categories.md#5-what-stays-exactly-as-it-is), the expected Investments row and headline are:

| Direction | Grouped No Aggregation | Average Amount | Count |
| --- | ---: | ---: | ---: |
| Both | −20 | −6.67 | 3 |
| Incoming | +1,000 | +1,000 | 1 |
| Outgoing | −1,020 | −510 | 2 |

**Why this changes an earlier decision.** On 3 November 2026, [issue #1996](https://github.com/kenlasko/monize/issues/1996) limited the change requested in [discussion #1978](https://github.com/kenlasko/monize/discussions/1978) to signed transaction lists and clearer labels. [PR #1997](https://github.com/kenlasko/monize/pull/1997) implemented that scope. On 7 November [the original reporter confirmed the beta fixed the transaction list](https://github.com/kenlasko/monize/discussions/1978#discussioncomment-19461603). [Ken’s decision record](https://github.com/kenlasko/monize/blob/db2ad3e2f76439df5f362612ceb440e637794b7e/.trail/learnings/2026-11-03-custom-reports-both-direction-lists-keep-ken.md) gives three reasons for deferring signed aggregates. They would change saved reports and INV-REPORT-004, pie charts need positive slice sizes, and the signed list met the original request. The record explicitly notes that the unsigned total can change with grouping. [Review PR #2000](https://github.com/kenlasko/monize/pull/2000) corrected the labels for grouped `No Aggregation` and retained that definition.

**Decision requested from Ken.** Apply the signed definition to both new and previously saved `Both / Total Amount` reports on their next run. For salary +1,000 in one category and a purchase −100 and refund +30 in another, the previous total was 1,070. The proposed net is 930. Descending amount sort can also move the expense row. A saved percentage sort ranks by signed amount in its saved ascending or descending direction because the signed net has no percentage-of-total shares. The saved configuration needs no migration. Keeping the old measure for some reports would require a separately identifiable choice and label. The [user guide](../../website/docs/reports.md#direction-and-category-type) explains the change.

**Reporting surfaces.** For the signed measure, use the existing net amount label, or net cash movement when transfers are included. Check the headline, rows, chart axis or fallback, tooltip, CSV/PDF where supported, and other consumers of the same result. When a pie cannot encode the signed data, the table or a signed chart must still expose the figures. Signed groups have no percentage-of-total shares. A new client uses the signed-total marker from the execution response to distinguish a new net from an older server’s unsigned result. Coordinate the frontend and backend rollout so users on older clients reload the updated interface.

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

## Net income sources and net spending by payee

[Ken approved both breakdowns](https://github.com/kenlasko/monize/discussions/2404#discussioncomment-19932193). For one income source, a receipt of 100 and a reversal of 150 produce a source row of −50 and total income of −50. For one payee and expense category, a purchase of 100 and a refund of 150 produce net spending of −50 in both breakdowns. An exact reversal leaves an active zero row. A chart limit may restrict the drawing; the full population determines the total. A mixed-sign breakdown has no part-of-whole percentage. Both reports retain their currency and missing-rate disclosures. Purchase frequency and the largest individual purchase retain their separate definitions.

## Tax Summary and classified income reversals

The [tax reporting proposal](https://github.com/kenlasko/monize/discussions/2404#discussioncomment-19932437) applies the assigned category to both signs. Tax Summary nets activity within its leaf category before combining display rows under their parent. For a deductible expense of 100 with a refund of 150, the category, total expenses and deductible expenses each show −50. For an income receipt of 100 with a reversal of 150, the source and total income each show −50. That income activity contributes zero spending in both the category and payee breakdowns. An exact reversal leaves a zero row under the assigned classification. Uncategorized tax receipts and payments remain separate by movement direction. Existing conversion, missing-rate and rounding rules apply to each result. This changes report calculations only.

## Saved Custom Report filters

[Ken approved the migration table](https://github.com/kenlasko/monize/discussions/2404#discussioncomment-19935046) for existing saved configurations. Direction selects movements (Both, Incoming or Outgoing). Category Type selects their economic classification (All, Income, Expense or Uncategorized). A transaction list here is No Grouping with No Aggregation. All grouped reports, including grouped No Aggregation, use the aggregate mapping.

| Saved configuration | Direction | Category Type |
| --- | --- | --- |
| Expenses Only, individual transaction list | Outgoing | All |
| Income Only, individual transaction list | Incoming | All |
| Expenses Only, aggregated report | Both | Expense |
| Income Only, aggregated report | Both | Income |
| Both, any layout | Both | All |

With an expense purchase of −100 and a refund of +30, the outgoing list selects the purchase. Signed Total Amount for the expense category includes both and reads −70. For a receipt of +100 and a reversal of −150 in one income category, the incoming list selects the receipt and the signed income category total reads −50. An uncategorized payment qualifies for Outgoing with All and falls outside Both with Expense. Apply the filters to eligible posting components, including individual split lines. Keep the existing account, date, transfer, currency conversion and completeness rules.

Exercise each mapping against a previously saved configuration on reopen, execution and save. Repeating that cycle must preserve the mapping, unrelated filters and selected layout. Explain changes to signs, totals and included transactions to users before migration.

## Grouped spending in list_transactions

Apply the [economic category and movement direction distinction](https://github.com/kenlasko/monize/discussions/2404#discussioncomment-19935046) to the MCP and assistant breakdown. For the same date and account selection, `direction: "expenses"` sums negated signed postings in expense categories, including refunds. `direction: "outgoing"` sums the magnitudes of debit postings across category types, including uncategorized debits. Both follow the existing exclusion of transfers. The independent cash-flow summary includes both directions.

For purchases totaling 100 USD and a refund of 30 USD with one payee and expense category, the category, payee and month each show 70 USD in expenses or 100 USD outgoing. A refund of 150 USD produces −50 USD expenses and 100 USD outgoing, with +50 USD net cash flow. When the purchase is in November and the 30 USD refund is in December, monthly expenses are 100 USD and −30 USD. Payees below the existing disclosure threshold remain in the anonymous bucket.
