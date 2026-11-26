---
title: "Retiring the PENDING IMPORT note (issue 2400): a repeated backfill re-flags reader-confirmed legs"
author: Node
date: 2026-11-26
branch: claude/issue-2400
cost: { minutes: 7, tokens: 142658 }
touches:
  - backend/src/import/import-regular-processor.service.spec.ts
  - backend/src/import/import-regular-processor.service.ts
  - backend/src/import/pending-import-note.guard.spec.ts
  - backend/src/import/pending-import.ts
  - backend/test/integration/import-qif-plain-transfer.integration.spec.ts
  - backend/test/integration/import-qif-split-transfer.integration.spec.ts
  - backend/test/integration/migration-transactions-amount-is-provisional.integration.spec.ts
---

## Decided
- The importer writes a provisional leg's description as the file's memo (split.memo || qifTx.memo), on create and on orphan re-link; amount_is_provisional is the only record of the state.
- backend/src/import/pending-import.ts is deleted; backend/src/import/pending-import-note.guard.spec.ts bans /PENDING[\s_-]*IMPORT/i in comment-stripped non-spec code under backend/src, except backup/restore-legacy-normalizations.ts. Specs may keep the text as adversarial fixtures.
- Integration specs that need the old note text inline it with ⚠️ escapes (no emoji in source).

## Tried and ruled out
- Telling a reader-confirmed leg apart from an unflagged legacy leg via action_history: it is pruned (100 per user, 30 days), so it is no evidence.

## Watch out
- The confirm-amount action (TransactionsService.confirmAmount) and the transfer-edit rule (confirmedBySuppliedAmount) clear the flag but leave the description, so a confirmed leg can still carry the note. Repeating the B1 backfill (is_transfer AND description LIKE '%PENDING IMPORT%' AND flag false) re-flags those legs and silently undoes the reader's confirmation. The deployment runs :latest from main, so this is live. The predicate was put to the maintainer as a question on issue 2400.
- The restore normalization registry is keyed by migration filename; a backfill entry keyed on 20261125150107 (the last schema before the importer wrote the column) plus a strip entry keyed on the new migration keeps confirmations in post-column backups.
- The worktree has no node_modules; run npm ci in backend/ first.
