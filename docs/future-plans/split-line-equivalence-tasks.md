# Tasks: a split line reads as the whole row it stands for

Plan: [`split-line-equivalence.md`](./split-line-equivalence.md).
Spec: [`docs/specs/split-line-equivalence.md`](../specs/split-line-equivalence.md).

| ID | Task | Depends on | Deploy impact | Recommended agent | Status |
| --- | --- | --- | --- | --- | --- |
| S0 | Spec, plan, task list, INV-REPORT-006 entry | -- | none | -- | done |
| T1 | Transfer rollups read the split transfer line | S0 | visible | sonnet, medium | done |
| T2 | The transfers filter reads the split transfer line, in analytics and the register | S0 | visible | opus, high | done |
| T3 | Tag filters select a line once (`EXISTS`) | S0 | visible | sonnet, high | done |
| T4 | Budget Health's income fallback drops the split transfer line | S0 | visible | sonnet, medium | done |
| T5 | Close: INV-REPORT-006 status, user guide, plan retired | T1-T4 | none | sonnet, medium | open |

## T1 transfer rollups

- [x] `getTransferRows` (`backend/src/built-in-reports/monthly-category-breakdown.service.ts`):
  add the split transfer lines as a second branch, the way
  `splitTransferLegsQuery` (`cash-flow-sankey.service.ts`) does, with the
  line's rate basis (`ownTransferLegs(userId, "$1", "ts")`).
- [x] `getTransfersByAccount` (`backend/src/transactions/transaction-analytics.service.ts`):
  the same, by the line's parent account.
- [x] Restate "reads the outgoing leg at 90 EUR" to 180; add the whole-vs-split
  parity case.
- [ ] Follow-up: the breakdown's whole-row transfer branch has no investment
  exclusion while its line branch must carry it (`investment-filter.guard.spec.ts`),
  so a transfer line on an investment-linked parent or in a brokerage sleeve is
  dropped while its counterpart counts. Import writes whole transfer rows in
  brokerage accounts; whether a split with a transfer line can live there is
  unverified. `getTransfersByAccount`, which the guard does not scan, gives its
  line branch the whole-row branch's scope, so its inbound and outbound net.
  The fix is one investment scope for both branches of the breakdown (the
  Sankey's, INV-SANKEY-003), which moves existing whole-row figures and needs
  its own agreement.

## T2 the transfers filter

- [x] Analytics `hasTransfer` arm: `transaction.isTransfer = true OR splits.transferAccountId IS NOT NULL`.
- [x] Register: the same arm in `findAll`, `computeSplitAwareSum` and
  `buildFilteredIdsSubquery`, so only the transfer line hydrates.
- [x] Restate the "+90" monthly-totals case to 0; add the register case.
- [x] `website/docs/transactions.md`: the Transfers filter lists a split by its transfer line.
- [ ] Decision for the maintainer: bulk update (`transaction-bulk-update.service.ts`,
  `applyCategoryFilters`) still selects whole transfer rows only under the
  Transfers filter. Selecting a split by its transfer line would let a
  filter-mode recategorization rewrite the split's category lines
  (`docs/specs/split-bulk-update.md` I2), so it waits for a rule on what a bulk
  edit of such a split does. Until then "select all matching" skips it.
- [ ] Follow-ups found in review, each older than T2 and shared with the
  category filter, which also hydrates only a split's matching lines: the
  register export (`register-export.ts`) writes the parent's amount beside the
  hydrated lines only; `amountFrom` / `amountTo` compare the parent's amount,
  not the shown line's; the `is:transfer` search term
  (`transaction-search.util.ts`) still matches whole transfer rows only.

## T3 tag filters

- [x] `createFilteredAnalyticsQuery` and `computeSplitAwareSum`: replace the two
  tag joins with `EXISTS` on the parent's tags or the line's tags.
- [x] The spec's tag example as an integration case on both reads.
- [ ] Follow-up, older than T3 and not fixed here: `getTransactionBreakdownByTagKey`
  inner-joins the parent's tags and groups by trimmed, case-insensitive value,
  so two tags on one row that give the same value (`scope:home`, `Scope: home`)
  count the row twice, and a split line's own tags are not read.
- [x] Left on joins on purpose: the register list (`findAll`),
  `buildFilteredIdsSubquery` and the bulk-update selector pick or hydrate rows
  and never sum over the join, so a repeated row changes no figure; an
  aggregate added on one of them moves it to `tagFilterExistsSql` first.

## T4 Budget Health

- [x] `getSavingsRate` income fallback (`backend/src/budgets/budget-health-reports.service.ts`):
  read at line grain and drop the split transfer line.
- [x] A split with a positive transfer line adds nothing to income.
- [ ] Follow-ups found in review, older than T4: the fallback applies no
  investment exclusion (`investmentExclusionSql`), so brokerage cash deposits
  count as income unless the account is excluded from the budget; a positive
  line in a budgeted expense category (a refund) lowers that category's
  expenses and also counts as fallback income, as a whole-row refund already
  did. Checked and correct: the budget generator's history queries
  (`budget-generator.service.ts`) read whole rows with a category and lines
  with a category, so a transfer line, which has none, never enters them.

## T5 close

- [ ] INV-REPORT-006 status and known gap.
- [ ] `website/docs/reports.md` where a figure changes.
- [ ] Follow-up recorded: whether `externalFlowSubtotalsSql` should read split
  lines (spec section 5).
- [ ] This plan pair retired.
