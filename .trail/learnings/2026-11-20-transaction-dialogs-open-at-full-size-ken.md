---
title: "Transaction dialogs open at full size: the lazily loaded form gets a skeleton placeholder, and an empty account picker keeps its height"
author: Ken
date: 2026-11-20
cost: { minutes: 5, tokens: 132821 }
id: l-7a0dd770
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/ui/IconSelect.tsx
  - frontend/src/components/transactions/TransactionFormPlaceholder.tsx
  - frontend/src/components/ui/IconSelect.test.tsx
  - frontend/src/components/transactions/TransactionFormPlaceholder.test.tsx
  - frontend/src/components/transactions/transaction-form-placeholder.guard.test.ts
  - docs/frontend/screens-and-dialogs.md
---

## Decided
- Ken reported two growth jumps in the transaction dialogs. Both had a mechanical cause, and each is fixed once in a shared spot.
- The account pickers (AccountSelect, which is built on IconSelect) collapsed to their padding, about 18px, whenever the closed field had no label to show. That happens on an edited row before the account list loads, and on a new investment entry before a brokerage account is picked. The fix is in IconSelect: it draws a non-breaking space in place of a missing label, so every icon picker keeps a full line's height.
- The cash TransactionForm loads through next/dynamic with { ssr: false } on seven hosts. With no `loading` option, the Modal showed only its title until the chunk arrived. Each host now passes `loading: TransactionFormPlaceholder`, a skeleton of the form's rows at their real heights, and a source-scanning guard enforces it.

## Watch out
- InvestmentTransactionForm is imported statically, so it never had the title-only flash. Its jump was the picker collapse alone.
- The placeholder's rows match the normal-mode form (tabs, three field pairs, Description, Tags/Status, Attachments, actions). If the form's layout changes a lot, update the placeholder too, or the dialog will jump again, just by a smaller amount.
- ScheduledTransactionForm and the other lazy forms still use a bare { ssr: false }. Only TransactionForm is guarded.

In the code:
- frontend/src/components/ui/IconSelect.tsx (label span `selected?.label || ' '`)
- frontend/src/components/transactions/TransactionFormPlaceholder.tsx
- frontend/src/components/transactions/transaction-form-placeholder.guard.test.ts
- docs/frontend/screens-and-dialogs.md ("Layout of a form dialog", Panel bullet)
