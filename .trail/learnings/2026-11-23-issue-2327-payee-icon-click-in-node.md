---
title: "Issue #2327: payee icon click in Pebble register"
author: Node
date: 2026-11-23
branch: claude/issue-2327
cost: { minutes: 12, tokens: 127542 }
touches:
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/components/transactions/variants/PebbleRegister.tsx
---

## Decided
- Pebble's row avatar and the inspector's avatar (PebbleRegister.tsx) became a `PayeeAvatar` wrapper: a `<button>` with `e.stopPropagation()` when `tx.payeeId` and `onPayeeClick` are both present, falling back to the plain non-interactive `Avatar` disc otherwise (transfers, payee-less rows).
- Reused the existing `onPayeeClick` prop already threaded through `TransactionList` -> `TransactionRow` for Classic/Folio (`router.push('/payees/${id}')` in transactions/page.tsx's `handlePayeeView`); Pebble just never received it. No new wiring needed upstream of `TransactionList`.
- Reused the existing i18n key `list.row.viewPayeeTitle` ("View {name} details") as both `aria-label` and `title` on the new button, since the icon carries no visible text.

## Tried and ruled out
- A separate click target beside the avatar (e.g. a chevron): rejected, issue asked specifically for the icon itself to be clickable, and Classic already has the equivalent affordance on the payee name text, not a second control.

## Watch out
- `trail check` flags this change against Node's 2026-11-16 "View Transactions header button" learning (currency detail page) purely on the lexical overlap of "View" + "button"; that learning is about a register filter disagreeing with a currency usage count and is unrelated to a per-row "View {payee} details" icon button. False positive, ignore it for this shape of change.
- `node_modules` was absent in this worktree; `npm ci` in `frontend/` was needed before lint/type-check/tests would run. Full-project `tsc --noEmit` OOMs without `NODE_OPTIONS=--max-old-space-size=4096`.
