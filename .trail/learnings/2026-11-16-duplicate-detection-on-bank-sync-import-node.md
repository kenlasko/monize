---
title: "Duplicate detection on bank sync/import: where it fits today"
author: Node
date: 2026-11-16
branch: claude/issue-2233
cost: { minutes: 2, tokens: 75708 }
touches:
  - backend/src/built-in-reports/data-quality-reports.service.ts
  - docs/future-plans/unified-import-preview.md
---

## Decided
- Issue #2233 (duplicates on bank sync/import) needs maintainer answers before building: match criteria, meaning of import/modify/delete, unattended-sync behaviour, and PR split. Asked on the issue; nothing implemented yet.
- Bank sync's existing `duplicate` outcome (bank-sync-preview.service.ts, bank-transaction-planner.ts) means "ledger already holds this provider key" (INV-BANKSYNC-001), not a content match against hand-entered or scheduled-posted rows. A ledger-content match is a new, separate outcome.
- A content matcher already exists: `getDuplicateTransactions` in backend/src/built-in-reports/data-quality-reports.service.ts (amount bucket, date window by sensitivity, optional payee). Reuse its approach rather than inventing one.

## Tried and ruled out
- Building on the unified import preview (docs/future-plans/unified-import-preview.md): it is a proposal, not approved, and CSV/QIF/OFX have no row-level preview today (parse returns only counts/date range in `ParsedQifResponse`).

## Watch out
- Unattended syncs (daily cron, "Sync now" without preview) never preview. Holding a flagged row can reuse the "skipped row" mechanism (spec 7b: last_success_at does not move, so the account needs its preview again).
- Bank sync commit is fingerprint-checked (`planFingerprint`, importKeys/excludeKeys, 400 for a key outside the new rows). A new outcome must keep "preview equals commit".
