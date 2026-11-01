---
title: Transaction/Transfer tab switch loses sign (issue 1975)
author: Node
date: 2026-10-31
branch: claude/issue-1975
cost: { minutes: 12, tokens: 115395 }
touches:
  - frontend/src/components/transactions/TransactionForm.test.tsx
  - frontend/src/components/transactions/TransactionForm.tsx
---

## Decided
- handleModeChange in frontend/src/components/transactions/TransactionForm.tsx forced a negative amount positive when entering Transfer mode (existing behaviour, correct), but only restored the original sign on leaving Transfer when the underlying saved row was itself a transfer (transaction?.isTransfer). For a plain transaction/new row, leaving Transfer kept whatever positive value Transfer displayed.
- Fix: a new ref wasNegativeBeforeTransferRef records that the forced flip happened; leaving Transfer (to normal or split) negates the current amount back when that ref is set and the row is not a stored transfer. Added alongside the existing leavingTransfer branch (they're mutually exclusive: one requires transaction?.isTransfer, the other requires !transaction?.isTransfer).
## Tried and ruled out
- Nothing alternative tried; the existing leavingTransfer restore (from transaction.amount) only applies to a transaction that is already a stored transfer, so it could not be reused for this case.
## Watch out
- trail check flags this diff against Node's Oct 30 FX-autofill learning ("setTransferTargetAmount ruled out") -- false positive, keyword collision on "transfer amount"/"set". This change never touches setTransferTargetAmount; it only calls setValue('amount', ...) on the primary amount field.
