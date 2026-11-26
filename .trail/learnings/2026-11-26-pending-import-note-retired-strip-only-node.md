---
title: "PENDING IMPORT note retired: strip-only migration, two restore entries, parser-based guard (issue 2400)"
author: Node
date: 2026-11-26
branch: claude/issue-2400
cost: { minutes: 22, tokens: 241810 }
touches:
  - backend/src/import/pending-import-note.guard.spec.ts
  - backend/test/integration/migration-transactions-strip-pending-import-note.integration.spec.ts
  - docs/future-plans/provisional-amounts-tasks.md
  - docs/future-plans/provisional-amounts.md
  - docs/system-invariants.md
  - backend/src/backup/restore-legacy-normalizations.spec.ts
  - backend/src/backup/restore-legacy-normalizations.ts
  - backend/test/integration/backup-restore.integration.spec.ts
  - backend/test/integration/import-qif-split-transfer.integration.spec.ts
  - database/migrations/20261125132236_transactions_amount_is_provisional.sql
---

## Decided
- Maintainer approved on issue 2400: migration 20261126115405 strips the exact note from every transfer leg (flagged or confirmed), trims, empty -> NULL, skips shared-ledger rows, and does NOT repeat the flag backfill.
- Restore: two LEGACY_NORMALIZATIONS entries. The flag backfill is keyed on 20261125150107 (last schema before the importer wrote the column, so no confirmations can exist). The strip is keyed on 20261126115405. A marker-less artifact counts as older only when its transactions rows exist and lack the amount_is_provisional key.
- The guard (import/pending-import-note.guard.spec.ts) blanks comments using ts.getLeading/TrailingCommentRanges over every node. The regex strippers other guards copy hide code after a `//` inside a string.
- Task Q now owns a repeat of the strip (never of the backfill), authored after B4 deploys, for legs that old pods wrote during the rollout.

## Tried and ruled out
- Leaving the B1 migration's comment naming the deleted pending-import.ts: source-comment-paths.spec.ts fails it. Repointing comments in merged migrations has precedent (d53ed4db7).

## Watch out
- A new invariant needs a row in docs/verification-contract.md too (invariant-catalog-parity.spec.ts).
- `npm run lint` runs --fix over the whole tree and reformatted an unrelated spec; check git status before committing.
- backup-restore.integration.spec.ts "restores a scanned attachment" fails on a stock postgres:18 container (en_US collation orders receipt.jpg first). The failure comes from the environment, not the code.
