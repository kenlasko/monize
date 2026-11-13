---
title: "Estimated scheduled transfers (issue #2164): the balance floor on top of the history estimate"
author: Node
date: 2026-11-13
branch: claude/issue-2164
cost: { minutes: 86, tokens: 571122 }
touches:
  - backend/src/scheduled-transactions/scheduled-amount-estimate.service.spec.ts
  - backend/src/scheduled-transactions/transfer-estimate-floor.spec.ts
  - backend/src/scheduled-transactions/transfer-estimate-floor.ts
  - backend/src/scheduled-transactions/transfer-estimate-ledger.ts
  - backend/test/integration/scheduled-amount-estimate.integration.spec.ts
  - docs/specs/scheduled-amount-estimate.md
  - backend/src/scheduled-transactions/dto/amount-estimate-query.dto.spec.ts
  - backend/src/scheduled-transactions/dto/amount-estimate-query.dto.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.spec.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.ts
---

## Decided
- A transfer's estimate is the #2096 history estimate over the transfers from its account into its destination (source leg, `t.amount < 0` only), raised and never lowered by what the destination owes (`transfer-estimate-floor.ts`, pure; reads in `transfer-estimate-ledger.ts`).
- Statement mode only for a MONTHLY transfer into a CREDIT_CARD with both statement days: the occurrence due in (S, S'] gets the closed statement's remainder, the one in (S', S''] gets owed less that remainder. Balance mode raises exactly the next occurrence's date (cursor, or the override's moved date). LOAN/MORTGAGE: never raised.
- "Owed" subtracts credits dated after today: posting early dates the row on its due date.
- Floors ride `ScheduleAmountEstimate.floors`, applied inside `estimatedAmountFor`, so every server path agrees; `estimateBasisOf` is the one schedule-to-basis builder. The read model sends floor months already raised (never the raw debt); the client reads them through `estimateEntryOn`.
- Settlement day = last day of the cycle (schema comment, account tooltip, the issue's Nov 5 row), not `computeStatementCycle`'s cycleStart label.

## Tried and ruled out
- A floor range (null, max(cursor, moved)] for balance mode: raised every weekly slot before a moved next occurrence.
- Letting the dominant-side rule drop reverse transfers: when more came back than went out the estimate turned positive.

## Watch out
- `transferAccountId` sent on a non-transfer update must not count as clearing a basis.
- A frequency change moves a transfer's snapshot (it picks the mode).
- Known limit: month-end clamping can put two occurrences in one statement window.
- The frontend test:changed run here took ~28 min (925 files); run focused files instead. `src/test/next-body-streams.test.ts` failed on this machine independently of the change.
