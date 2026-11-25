# Tasks: a split line reads as the whole row it stands for

Plan: [`split-line-equivalence.md`](./split-line-equivalence.md).
Spec: [`docs/specs/split-line-equivalence.md`](../specs/split-line-equivalence.md).

| ID | Task | Depends on | Deploy impact | Recommended agent | Status |
| --- | --- | --- | --- | --- | --- |
| S0 | Spec, plan, task list, INV-REPORT-006 entry | -- | none | -- | done |
| T1 | Transfer rollups read the split transfer line | S0 | visible | sonnet, medium | done |
| T2 | The transfers filter reads the split transfer line, in analytics and the register | S0 | visible | opus, high | open |
| T3 | Tag filters select a line once (`EXISTS`) | S0 | visible | sonnet, high | open |
| T4 | Budget Health's income fallback drops the split transfer line | S0 | visible | sonnet, medium | open |
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

## T2 the transfers filter

- [ ] Analytics `hasTransfer` arm: `transaction.isTransfer = true OR splits.transferAccountId IS NOT NULL`.
- [ ] Register: the same arm in `findAll`, `computeSplitAwareSum` and
  `buildFilteredIdsSubquery`, so only the transfer line hydrates.
- [ ] Restate the "+90" monthly-totals case to 0; add the register case.

## T3 tag filters

- [ ] `createFilteredAnalyticsQuery` and `computeSplitAwareSum`: replace the two
  tag joins with `EXISTS` on the parent's tags or the line's tags.
- [ ] The spec's tag example as an integration case on both reads.

## T4 Budget Health

- [ ] `getSavingsRate` income fallback (`backend/src/budgets/budget-health-reports.service.ts`):
  read at line grain and drop the split transfer line.
- [ ] A split with a positive transfer line adds nothing to income.

## T5 close

- [ ] INV-REPORT-006 status and known gap.
- [ ] `website/docs/reports.md` where a figure changes.
- [ ] Follow-up recorded: whether `externalFlowSubtotalsSql` should read split
  lines (spec section 5).
- [ ] This plan pair retired.
