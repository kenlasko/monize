# Plan: a split line reads as the whole row it stands for

Executes [`docs/specs/split-line-equivalence.md`](../specs/split-line-equivalence.md)
(discussion #2403); read the spec first. The task list is
[`split-line-equivalence-tasks.md`](./split-line-equivalence-tasks.md).

## Assumptions (verified against the tree, 2026-11-25)

- A split's parent has `is_transfer = false`; its transfer line is
  `transaction_splits.transfer_account_id IS NOT NULL`, and the counterpart
  whole row links to the parent (`docs/financial-semantics.md` section 2).
- The Cash Flow Sankey, Income vs Expenses' tagged flows, the budget transfer
  builders and the custom report already read split transfer lines; nothing in
  them changes.
- The analytics query (`createFilteredAnalyticsQuery`) and the register sum
  (`computeSplitAwareSum`) already read at line grain through
  `COALESCE(split.amount, t.amount)`, so adding the line to a transfers-only
  arm needs no new grain.
- The register's category filter already hydrates only the matching lines of a
  split and shows a partial total; the transfers filter follows it (spec
  rule 6), so the frontend needs no change.
- `report-transfer-fx-surfaces.integration.spec.ts` pins today's half-transfer
  figures (the 90 EUR "from" row, the +90 transfer-filter total); the tasks
  restate them.
- No schema, migration, endpoint or response shape changes.

## Stages

One PR per task, each based on `main`, in the task list's order. None depends
on another's code; the order only keeps the integration spec's edits apart.

1. **Transfer rollups read the line** (T1): Monthly Category Breakdown's
   transfer rows and `getTransfersByAccount`.
2. **The transfers filter reads the line** (T2): the analytics arm and the
   register's list, sum and filtered-ids subquery, together, so the register
   and its figures keep agreeing.
3. **Tag filters select once** (T3): `EXISTS` in place of the two tag joins.
4. **Budget Health's income fallback drops the transfer line** (T4).
5. **Close** (T5): INV-REPORT-006 to the status the tree supports, the user
   guide where a figure changes, plan retired.

## What to run

- Backend: `npm run lint && npx tsc --noEmit && npm run typecheck`, the specs
  the task touches, `npm run test:changed`, and, because each task changes a
  query, `npm run build && npm run test:integration -- report-transfer-fx-surfaces`
  plus the integration specs of the touched service.
- Frontend: nothing unless a task changes a response type.
