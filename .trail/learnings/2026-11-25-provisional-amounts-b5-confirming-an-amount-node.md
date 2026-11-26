---
title: "Provisional amounts B5: confirming an amount (action, transfer-edit rule, conversion clear)"
author: Node
date: 2026-11-25
branch: claude/issue-2392
cost: { minutes: 25, tokens: 277967 }
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
- `TransactionsService.confirmAmount` is one conditional `UPDATE ... WHERE id, user_id, amount_is_provisional = true`; `affected = 0` is the 400. Its history entry holds only `{ amountIsProvisional }` before/after: `undoTransactionUpdate` restores just the keys present in `beforeData`, and `updateTransfer` records no history, so a full snapshot would write a stale amount back over a later transfer edit (pinned in `provisional-amount-confirm.integration.spec.ts`).
- The transfer-edit rule is `confirmedBySuppliedAmount` (transaction-transfer.service.ts), merged into the leg's update data on the same-owner and connected cross-owner paths; the split-counterpart path keys off its existing `legChanged`. The frozen cross-owner path refuses amount changes, so it needs nothing.
- A shared-ledger row is not exempted: `shared_protect_ledger_transaction` refuses the flag write (PSE01, mapped globally by `http-error-body.ts`); no migration.
- A new action-history `descriptionKey` needs three frontend edits: `KNOWN_DESCRIPTION_KEYS`, its size assertion in `action-history-format.test.ts`, and `layout.actionHistory.descriptions` in every locale.

## Tried and ruled out
- Carrying the flag when a split PARENT edit deletes and recreates transfer-line counterparts (`TransactionsService.update`, `TransactionSplitService.updateSplits`): it would be a fifth writer setting `true`, which design section 6 does not list. Left uncovered and written down in the design for the maintainer.

## Watch out
- `npm run lint` in backend is `--fix` over the whole tree and reformats unrelated files; check `git status` and revert them.
- Frontend `npm run type-check` aborts on the default heap; run it with `NODE_OPTIONS=--max-old-space-size=4096`.
- `en-GB` / `en-US` locale folders are override-only; a new key goes in the other 18 locales plus `xx` via `i18n:pseudo`.
