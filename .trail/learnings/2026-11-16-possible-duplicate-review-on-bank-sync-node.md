---
title: "Possible-duplicate review on bank sync and file import (issue #2233)"
author: Node
date: 2026-11-16
branch: claude/issue-2233
cost: { minutes: 104, tokens: 817856 }
touches:
  - backend/src/i18n/locales/de/emails.json
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/emails.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/emails.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/emails.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/emails.json
  - backend/src/i18n/locales/id/errors.json
---

## Decided
- One matcher for both sources: `matchPossibleDuplicates` / `loadDuplicateCandidates` in backend/src/import-preview/possible-duplicates.ts (same account, exact amount, dates within 3 days, one to one, closest first; payee not compared). Spec: docs/specs/import-duplicate-review.md, INV-IMPORT-004.
- Bank sync: outcome `possible_duplicate`, sync lists mergeKeys/keepKeys/replaceKeys; the plan fingerprint covers the [key, transaction id] pairs (unchanged when there are none). Undecided pairs are held, `bank_sync_accounts.held_duplicate_count` makes `bankAccountNeedsPreview` true, and the daily sync writes BANK_SYNC_DUPLICATES_HELD.
- File import: `POST /import/{qif,ofx,csv}/duplicates` takes the import body; the import carries duplicateDecisions keyed by the 0-based row position and re-pairs in its transaction (409 on a stale pair). An undecided pair is kept (skip reason possibleDuplicate).
- "Delete mine and import" goes through `TransactionsService.remove(..., { recordHistory: false, deferDerivedRecompute })`, then `dispatchDeferredRecompute` after the caller's commit.

## Tried and ruled out
- Calling plain `TransactionsService.remove` inside the import/sync transaction: its action-history write is fire-and-forget and joins the caller's transaction, which ActionHistoryService forbids.
- Giving the duplicate check routes `@PatScope("read")`: it grows the reviewed PAT read-override list (pat-access.routes.guard.spec.ts); they stay write-scoped.

## Watch out
- In the bank sync writer, claim the ledger key before deleting the replaced row; a key a concurrent sync claimed must delete nothing.
- File rows that are transfers or loan payments (category mapped to a loan) are not compared; the holder of an OFX FITID a skipped row carries must not pair with another row, and a replace must drop that id from ctx.heldExternalIds.
- No replace for a split parent: remove() deletes its transfer legs in other accounts.
- A raw SELECT on investment_transactions needs an "includes VOID" classification comment (investment-void-classification.guard.spec.ts); a rendered description needs LinkifiedText (linkified-description.guard.test.ts).
