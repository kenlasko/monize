---
title: Quick Add account guess from payee history
author: Node
date: 2026-11-27
branch: claude/issue-2479
cost: { minutes: 10, tokens: 85525 }
touches:
  - backend/src/transactions/quick-add/quick-add-fill-accounts.util.ts
  - backend/src/transactions/quick-add/quick-add-fill-shared.util.ts
  - backend/src/transactions/quick-add/quick-add-fill.util.ts
  - backend/src/transactions/quick-add/quick-add-interpret.service.spec.ts
  - docs/future-plans/quick-add.md
  - website/docs/search-index.json
  - website/docs/transactions.html
  - website/docs/transactions.md
---

## Decided
- Quick Add's account fill (`defaultAccount` in `backend/src/transactions/quick-add/quick-add-fill-accounts.util.ts`) ranks the payee's last 10 non-void, non-transfer rows (`loadPayeeHistory().recent`) by frequency, most recent breaking a tie, via `rankByRecentFrequency` in `quick-add-fill-shared.util.ts`; the category guess uses the same helper.
- Order kept: context (register) account, then payee history (inferred), then the reader's most recently created row's account (default).
- History is keyed on `payee_id` only; a new payee name (no id) gets no history even if `transactions.payee_name` matches.

## Tried and ruled out
- Counting the payee's whole history with a GROUP BY: rejected so a card switch is picked up within 10 rows, and to stay consistent with the category rule.

## Watch out
- Editing `website/docs/*.md` needs `cd frontend && npm run docs:build` (regenerates `transactions.html` and `search-index.json`); `website-docs.test.ts` and `src/help` specs check them.
- The fill table in `docs/future-plans/quick-add.md` documents each field's fallback chain; keep it in step.
