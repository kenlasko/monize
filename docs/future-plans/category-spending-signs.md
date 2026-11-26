# Preserve a classified expense category’s net sign

This independent change under [discussion #2404](https://github.com/kenlasko/monize/discussions/2404) concerns Spending by Category. [PR #2427](https://github.com/kenlasko/monize/pull/2427) covers Custom Reports. The [financial definition](../specs/category-spending-signs.md) applies after the report has identified an expense category.

## Reproduction and history

A PostgreSQL 18.7 check at upstream commit `db2ad3e` used one USD account, merchant and expense category on the same date. A purchase of 100 and classified refund of 30 produced net spending of 70. With a refund of 150 the report omitted the category and reported zero. The expected category and headline are both −50. [PR #1135](https://github.com/kenlasko/monize/pull/1135) introduced per-category netting in August 2026 and filtered out nonpositive groups, in part to exclude income categories. An expense category is already identifiable when its refunds exceed its purchases.

The payee report uses a separate purchase-only definition. The [trivia design](https://github.com/kenlasko/monize/blob/5b2940791047b03fbe06f79087d9020b3da37010/docs/future-plans/trivia-variety.md#35-the-purchase-predicate-is-written-once) records why individual purchase facts share that population. This branch makes no change to that metric.

## Acceptance

- Purchase −100 plus refund +30 in the same expense category produces spending of 70.
- Refunds of +100 and +150 against that purchase produce a visible zero and a visible −50 respectively. A refund from an earlier period can produce a negative figure on its own.
- Preserve signed component values and report-currency precision through category grouping, rollup and the headline. Keep missing rates distinguishable from a known zero.
- Check table, charts and direct report consumers on positive, zero and negative results. Preserve access to signed values where positive-size chart geometry cannot express the sign.
- Exercise existing income, uncategorized and purchase-only controls. The change creates no new category rule, treatment for unclassified credits or merchant-ranking feature.
