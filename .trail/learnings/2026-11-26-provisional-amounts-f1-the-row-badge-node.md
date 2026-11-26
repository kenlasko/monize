---
title: "Provisional amounts F1: the row badge and the Confirm amount action"
author: Node
date: 2026-11-26
branch: claude/issue-2397
cost: { minutes: 22, tokens: 245881 }
touches:
  - docs/future-plans/provisional-amounts.md
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/i18n/messages/de/transactions.json
  - frontend/src/i18n/messages/es/transactions.json
  - frontend/src/i18n/messages/fr/transactions.json
  - frontend/src/i18n/messages/hi/transactions.json
  - frontend/src/i18n/messages/id/transactions.json
---

## Decided
- One `ProvisionalAmountBadge` draws the label wherever a row's amount is drawn: the phone card, the desktop Amount cell, Folio's Payment or Deposit cell, the Pebble row and the Pebble inspector. It reads the flag through `isProvisionalAmount` (`frontend/src/lib/provisional-amount.ts`) as `=== true`.
- The Transactions page owns the confirm request. It marks the row confirmed in place, then calls `loadAllData`, not `loadData`, because the account widget reads the page's static accounts list.
- The list offers the action only when `tx.userId` equals `actingAsUserId ?? user.id`. For an acting delegate the server's `req.user.id` is the owner, so comparing with the signed-in user alone would hide the action from delegates.

## Tried and ruled out
- Gating only on `jointPermissionsByAccount`: that map is empty until the accounts load, so for a moment the action showed on joint rows the endpoint refuses.

## Watch out
- `npm run test:changed` does NOT select `src/i18n/messages.parity.test.ts` when `en/*.json` changes. Run it yourself: a key that exists only in `en` fails CI, even though the plan defers the locale pass to Q.
- In a list test that sets `useAuthStore` state, unmount before resetting the store in `finally`, or the act() guard fails the test.
