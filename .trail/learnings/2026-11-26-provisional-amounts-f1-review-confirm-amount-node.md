---
title: "Provisional amounts F1 review: Confirm amount is owner-only, delegates are refused by the guard"
author: Node
date: 2026-11-26
branch: claude/issue-2397
cost: { minutes: 2, tokens: 23350 }
touches:
  - docs/future-plans/provisional-amounts.md
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/transactions/ProvisionalAmountBadge.tsx
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/lib/transactions.test.ts
---

## Decided
- Supersedes the delegate line of the earlier F1 learning. `POST /transactions/:id/confirm-amount` has no `@AllowDelegate()`. The global `AccountDelegateGuard` refuses every acting session on an unannotated route with 403 `errors.delegation.actionNotAvailableAsDelegate`. So `TransactionList` offers the action only when `actingAsUserId === null` and the row's `userId` is the signed-in user's.
- A refused confirm (most likely 400 "not provisional", because it was confirmed elsewhere) toasts and then reloads through `loadAllData`, so the row stops offering a refused action.
- `ProvisionalAmountBadge` is `whitespace-normal`: Pebble's amount column is a fixed `sm:w-28` and the label runs longer in most locales.

## Tried and ruled out
- Gating on `actingAsUserId ?? user.id` (the server's `req.user.id` for a delegate): it matches the owner's rows, but the guard refuses the route before the service runs.

## Watch out
- Before offering any frontend action to a delegate, grep the controller route for `@AllowDelegate()`. The JWT strategy swapping `id` to the owner does not mean the route admits delegates.
