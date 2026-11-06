---
title: removeSplit re-totals only a parent flagged isSplit
author: Node
date: 2026-11-06
branch: claude/issue-2025
cost: { minutes: 3, tokens: 23935 }
touches:
  - backend/src/transactions/transaction-split.service.spec.ts
  - backend/src/transactions/transaction-split.service.ts
  - backend/test/integration/remove-split-line.integration.spec.ts
  - docs/financial-semantics.md
---

## Decided
- `removeSplit` treats the lines as the parent's money only when the locked parent has `isSplit` set and the lines summed to its amount. `addSplit` sets `isSplit` only at the second line, so its first line, even one equal to the whole parent, moved nothing and its removal moves nothing back. Every full-set writer sets the flag: create (`isSplit: hasSplits`), `updateSplits`, and the update with splits.

## Tried and ruled out
- Judging coverage by the sum alone: a plain -100 row with one -100 line from `addSplit`, then removed, was re-totalled to 0.00 and credited 100.00 that never left the account.

## Watch out
- `remove-split-line.integration.spec.ts` pins both the partial (-30) and the whole (-100) first-line cases with `it.each`.
