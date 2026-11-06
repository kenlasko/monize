---
title: Split paths ask the reconciled lock on legs; one parent re-total helper
author: Node
date: 2026-11-06
branch: claude/issue-2039
cost: { minutes: 19, tokens: 253121 }
touches:
  - backend/src/transactions/reconciled-lock.guard.spec.ts
  - backend/src/transactions/transaction-split.service.spec.ts
  - backend/src/transactions/transaction-split.service.ts
  - backend/src/transactions/transactions.service.spec.ts
  - backend/test/integration/remove-split-line.integration.spec.ts
  - docs/financial-semantics.md
  - docs/system-invariants.md
  - backend/src/transactions/split-parent-total.spec.ts
  - backend/src/transactions/split-parent-total.ts
  - backend/src/transactions/transaction-transfer.service.ts
---

## Decided
- `deleteSplitSideEffects` locks every transfer leg (`lockTransactionRows`) and calls `assertReconciledRowsMutable` before its first write (the embedded `reverseAndRemoveEmbedded`). That one place covers `updateSplits`, update with splits, `remove`, `convertToTransfer` and `bulkDelete` (issue #2039). `reconciled-lock.guard.spec.ts` scans it with `beforeWrite: "reverseAndRemoveEmbedded("`.
- `removeSplit` decides everything before it writes: it reads the remaining lines under the parent lock (filtering out the removed id), works out the re-total and the collapse target, locks the removed and kept legs in one ascending batch, and asserts them.
- `retotalSplitParent` (`backend/src/transactions/split-parent-total.ts`) is the one parent re-total, used by `updateSplitTransferLeg` and `removeSplit`. It applies `deletionBalanceEffect` to `old - new`.
- On collapse, the line's tags join the parent's (raw `INSERT ... SELECT FROM transaction_split_tags ON CONFLICT DO NOTHING`), and its memo fills only a blank parent description (open question on #2039).

## Tried and ruled out
- Asserting the legs after the investment reversal: it still rolls back, but it breaks "a rejected command must not already have written".

## Watch out
- A split-transfer leg already links back to its parent (`leg.linkedTransactionId = parent.id`) before any collapse.
- In `transactions.service.spec.ts`, the `lockTransactionRows` double resolves missing ids through `transactionsRepository.find({})`, not the `findOne` queue.
- Split tags are written only by imports (and `setSplitTags`), not by `createSplits`. Integration specs insert `transaction_split_tags` directly.
- `addSplit` behaviour for short sets is still open (question asked on #2039).
