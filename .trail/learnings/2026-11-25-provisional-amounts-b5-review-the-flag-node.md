---
title: "Provisional amounts B5 review: the flag is carried across a split replacement, and undo of a confirm is guarded"
author: Node
date: 2026-11-25
branch: claude/issue-2392
cost: { minutes: 11, tokens: 69896 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
  - backend/src/i18n/locales/pl/errors.json
---

## Decided
- Supersedes the "ruled out" line of the earlier B5 learning: the flag IS carried when a split parent's edit recreates transfer-line counterparts (`provisional-split-legs.ts`, called from `TransactionsService.update` and `TransactionSplitService.updateSplits`). It is preservation across a row replacement, matched on same account plus same amount, and never sets the flag on an amount that was not provisional.
- The confirm entry carries `confirmedLegAmount` for comparison only; `assertConfirmationUndoable` refuses the undo (`UNDO_CONFIRMED_AMOUNT_CHANGED`) when the leg's amount changed or it is no longer a transfer leg, because transfer edits record no history and the confirm entry stays newest.
- `confirmedBySuppliedAmount` takes the pair the edit leaves behind: a same-currency pair confirms the leg, and an amount stated for a leg moved into another currency confirms it even with the same number.
- `confirmAmount` takes `lockTransactionRow`, the conditional update and the re-read in one `withScopedDb`.

## Tried and ruled out
- Requiring `toAmount` before a split counterpart's flag clears on a cross-currency pair: that path writes a lone `amount` onto the leg, so the row no longer holds the estimate and leaving it flagged would mislabel a stated figure.
- A spec for the shared-ledger (PSE01) refusal: the integration database is built by synchronize and has no `shared_protect_ledger_transaction` trigger.

## Watch out
- A split line whose own amount changed is repriced and written confirmed: a replace-all write cannot tell which old line it continues.
