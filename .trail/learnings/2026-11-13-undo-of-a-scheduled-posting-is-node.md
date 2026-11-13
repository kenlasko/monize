---
title: Undo of a scheduled posting is one scheduled_posting entry
author: Node
date: 2026-11-13
branch: claude/issue-2165
cost: { minutes: 64, tokens: 480346 }
touches:
  - backend/src/action-history/scheduled-posting-undo.spec.ts
  - backend/src/action-history/scheduled-posting-undo.ts
  - backend/src/scheduled-transactions/scheduled-posting-history.spec.ts
  - backend/src/scheduled-transactions/scheduled-posting-history.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.spec.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.ts
  - docs/system-invariants.md
  - frontend/src/lib/undoRedoSignal.test.ts
  - frontend/src/lib/undoRedoSignal.ts
  - backend/src/action-history/action-history.scheduled-posting.spec.ts
---

## Decided
- post() writes money with the nested create's history off (`recordHistory: false` on TransactionsService.create, completeTransfer, InvestmentTransactionsService.create) and records ONE `scheduled_posting` entry after its commit (issue #2165). Snapshot shape: `scheduled-transactions/scheduled-posting-history.ts`; undo: `action-history/scheduled-posting-undo.ts`, dispatched from ActionHistoryService.executeUndo with a remover callback that reuses the create undos.
- Cursor change is derived from advanceScheduleCursor's return plus the overrides read before the advance (`cursorBaseline` / `cursorChangeOf`), not re-read after: the service spec's repo mocks have no findOneOrFail.
- One-time schedules are snapshotted with `to_jsonb` and restored with `jsonb_populate_record` over the columns information_schema says the table has now (`insertHead`); SET NULL targets gone since are cleared, anything else gone -> 409 SCHEDULED_POSTING_UNDO_REFERENCE_GONE.
- Refusals before any write: a later claim made after the posting (claims the posting found ahead of the cursor are recorded in `laterClaimedSlots`), and a cursor that moved (a skip records no entry). Redo always refused.
- Cross-owner transfers (`hasForeignLeg`) keep the transfer's per-owner entries; recordOnly / retired-loan posts record nothing.

## Tried and ruled out
- Refusing undo on any later-slot claim by date: a rule's settlement ahead of the cursor predates the posting and blocked its undo forever.
- Re-reading the advanced row with findOneOrFail inside post(): breaks dozens of mocked post() specs.

## Watch out
- An auto-post schedule whose rewound slot is due is re-posted by the hourly cron after the undo; behaviour pending maintainer decision on issue #2165.
- rls-context-smoke.spec.ts's overrides repo mock needs `find` now that post() reads the held overrides.
- Integration spec: backend/test/integration/scheduled-posting-undo.integration.spec.ts (embedded-postgres runner in /tmp works).
