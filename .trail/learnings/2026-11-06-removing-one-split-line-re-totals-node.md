---
title: Removing one split line re-totals the parent only when the lines covered it
author: Node
date: 2026-11-06
branch: claude/issue-2025
cost: { minutes: 33, tokens: 212551 }
touches:
  - backend/src/transactions/transaction-split.service.spec.ts
  - backend/src/transactions/transaction-split.service.ts
  - backend/test/integration/remove-split-line.integration.spec.ts
  - docs/financial-semantics.md
  - docs/system-invariants.md
  - backend/src/transactions/transactions.service.spec.ts
---

## Decided
- `TransactionSplitService.removeSplit` (issue #2025) takes the removed line's amount off the locked parent and moves the parent's account through `deletionBalanceEffect`, but only when the lines added up to the parent before the removal. An `addSplit`-built partial set never moved the parent's amount or account, so removing one of its lines moves neither back.
- A last line collapses into the parent only when it equals the re-totalled parent. A transfer line keeps its counterpart: the parent gets `isTransfer: true` and `linkedTransactionId` = the leg, and the leg links back to the parent (the plain-transfer shape from `transferLegColumns`). The old code deleted that leg.
- Re-total, rather than refuse, follows `updateSplitTransferLeg` (transaction-transfer.service.ts), which already re-totals the parent when a split-transfer leg's amount is edited.

## Tried and ruled out
- Re-totalling on every removal (parent - line): it broke partial sets. A plain -100 row with one -30 line added and then removed ended at -70, with 30 credited.
- Refusing every nonzero removal: it would make the route useless, since any nonzero line breaks the split sum.

## Watch out
- An embedded investment row has `transactionId: null`, so the split parent is its only cash side. The re-total is the one cash movement, and `reverseAndRemoveEmbedded` does not double it.
- No split path asserts the reconciled lock on legs in other accounts (`updateSplits` and `removeSplit` both delete them unchecked). This predates #2025.
- In transaction-split.service.spec.ts, the investment `removeSplit` cases rely on lock mocks left by earlier tests, so they throw NotFound under `-t removeSplit`. Run the whole file.
- Integration specs run against `docker run mirror.gcr.io/library/postgres:16` with `DATABASE_PORT` set, after `npm run pretest:integration`.
