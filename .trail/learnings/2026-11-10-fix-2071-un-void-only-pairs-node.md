---
title: "Fix #2071: un-void only pairs VOID-ness, not the chosen reconciliation status"
author: Node
date: 2026-11-10
branch: claude/issue-2071
cost: { minutes: 18, tokens: 259256 }
touches:
  - backend/src/securities/investment-transactions.service.spec.ts
  - backend/src/transactions/transaction-bulk-update.service.spec.ts
  - backend/src/transactions/transaction-bulk-update.service.ts
  - backend/src/transactions/transaction-reconciliation.service.spec.ts
  - backend/src/transactions/transaction-split.service.spec.ts
  - backend/src/transactions/transaction-split.service.ts
  - backend/src/transactions/transaction-transfer.service.spec.ts
  - backend/src/transactions/transaction-transfer.service.ts
  - backend/src/transactions/void-status-transition.util.ts
  - docs/system-invariants.md
---

## Decided
- A VOID-crossing status write on a transfer pair must only mirror VOID-ness itself. Entering VOID still writes VOID onto the counterpart leg; leaving VOID now writes `{ status: UNRECONCILED, reconciledDate: null }` onto the counterpart instead of the status the user chose for their own leg. Fixed in four call sites that each independently wrote `{ status: newStatus }` onto a counterpart: `applyVoidTransitionToMirrorLeg` (void-status-transition.util.ts, shared by the status route, the generic PATCH update, and the investment cash-leg crossing in investment-transactions.service.ts), `applyParentStatusToTransferCounterparts` (transaction-split.service.ts, split-parent propagation), the inline pairing in `TransactionTransferService.updateTransfer`, and the bulk path's single UPDATE in transaction-bulk-update.service.ts (now split into two UPDATEs: eligibleIds get the chosen status, dragged-in mirror legs get VOID or UNRECONCILED).
- The investment cash leg of a trade shares this exact rule (same helper, same comment in the source: "same helper, same rules... as a transfer's mirror leg"), so a pre-existing test asserting the cash leg inherited the trade's CLEARED on un-void was itself the same bug class and had to be updated to expect UNRECONCILED.

## Tried and ruled out
- Tracking a "status before VOID" column to restore the counterpart's prior sub-status on un-void: no such column exists, and the issue's own expected behavior is UNRECONCILED, not a remembered prior state.

## Watch out
- `updateSplitTransferLeg` and the cross-owner transfer paths (`updateFrozenTransferLeg`, cross-owner connected flow) do NOT share this bug: they either refuse a status change that would cross VOID alone, or never write a counterpart's status at all (cross-owner reconciliation is already fully per-ledger, not mirrored). Don't "fix" those too.
- `trail check` flags several false positives on this diff purely from the literal string "reconciledDate"/"reconciled_date" colliding with an unrelated Oct-30 learning about the stale-reconciliation classifier (`MAX(reconciled_date)` vs `LEAST(...)` in stale-reconciliation.ts) -- not a real conflict, just a keyword collision.
