---
title: "Quick Add opens at full size from a placeholder Modal, and its chunk is warmed so the placeholder is rarely seen"
author: Ken
date: 2026-11-20
branch: claude/focused-feynman-5z08rq
cost: { minutes: 18, tokens: 96931 }
id: l-8f123633
scope: repo
status: active
src: agent
touches:
  - docs/frontend/screens-and-dialogs.md
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/transactions/quick-add/QuickAddDialogPlaceholder.test.tsx
  - frontend/src/components/transactions/quick-add/QuickAddDialogPlaceholder.tsx
  - frontend/src/components/transactions/transaction-form-placeholder.guard.test.ts
  - frontend/src/components/transactions/quick-add/QuickAddDialog.test.tsx
  - frontend/src/components/transactions/quick-add/QuickAddDialog.tsx
  - frontend/src/components/transactions/quick-add/QuickAddSummary.tsx
  - frontend/src/i18n/messages/de/transactions.json
  - frontend/src/i18n/messages/en/transactions.json
---

## Decided
- Quick Add's dialog owns its own Modal (unlike TransactionForm, whose host draws the Modal), so a skeleton of rows alone could not help: before the chunk arrived the first opening drew nothing at all. The `loading` placeholder is therefore a whole Modal with the same size, title and description over skeletons of the empty dialog's rows (Entry field, status line, actions).
- The Transactions page also warms the Quick Add chunk on idle (requestIdleCallback, setTimeout fallback), so an opening rarely needs the placeholder.

## Tried and ruled out
- Placeholder alone: when the real dialog replaces it, the new Modal element replays Modal's 200ms entry fade/scale (CSS starting: styles), a visible blink. Modal has no prop to skip it.
- Moving the Modal out of QuickAddDialog into the page so only the body is lazy: the body's sibling dialogs (unsaved changes, reactivate payee) and every QuickAddDialog test assume the dialog owns its Modal; too much churn for this fix.

## Watch out
- If the empty dialog's layout changes (a new row above the chips, bigger buttons), update the placeholder or the dialog jumps again by the difference.

In the code:
- frontend/src/components/transactions/quick-add/QuickAddDialogPlaceholder.tsx
- frontend/src/app/transactions/page.tsx (dynamic import with loading: QuickAddDialogPlaceholder; idle warm-up effect)
- frontend/src/components/transactions/transaction-form-placeholder.guard.test.ts (second case)
