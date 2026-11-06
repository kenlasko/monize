---
title: "addSplit grows a whole split set's parent, the mirror of removeSplit"
author: Node
date: 2026-11-06
branch: claude/issue-2039
cost: { minutes: 5, tokens: 38509 }
touches:
  - backend/src/transactions/transaction-split.service.spec.ts
  - backend/src/transactions/transaction-split.service.ts
  - backend/test/integration/remove-split-line.integration.spec.ts
  - docs/financial-semantics.md
  - docs/system-invariants.md
---

## Decided
- Maintainer approved option (a) on #2039. `TransactionSplitService.addSplit` re-totals the parent through `retotalSplitParent` when it is a whole set: the locked parent has `isSplit`, at least one line, and its lines sum to its amount. The parent becomes the new total and its account moves by the line. For a whole set the "exceeds the parent" refusal is skipped.
- Any other parent (plain, or a partial `addSplit`-built set) keeps the incremental rule: no amount or balance move, and a total past the parent is refused.
- On collapse, the memo fills only a blank parent description, and the line's tags go onto the parent only, not the kept counterpart (both approved).

## Tried and ruled out
- Refusing a short set in `addSplit`: every first line is short, so the route would be useless.

## Watch out
- Before, a whole set refused a same-signed line but accepted an opposite-signed one, which left the lines short of the parent.
- No UI calls `POST /transactions/:id/splits`. The frontend `transactionsApi.addSplit` helper is unused, and the AI and MCP tools don't reach it.
