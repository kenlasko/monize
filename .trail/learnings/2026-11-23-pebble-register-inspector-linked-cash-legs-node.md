---
title: "Pebble register inspector: linked cash legs and alignment"
author: Node
date: 2026-11-23
branch: claude/issue-2354
cost: { minutes: 10, tokens: 125929 }
touches:
  - frontend/src/i18n/messages/de/transactions.json
  - frontend/src/i18n/messages/es/transactions.json
  - frontend/src/i18n/messages/fr/transactions.json
  - frontend/src/i18n/messages/hi/transactions.json
  - frontend/src/i18n/messages/id/transactions.json
  - frontend/src/i18n/messages/it/transactions.json
  - frontend/src/i18n/messages/ja/transactions.json
  - frontend/src/i18n/messages/ko/transactions.json
  - frontend/src/i18n/messages/nl/transactions.json
  - frontend/src/i18n/messages/pl/transactions.json
---

## Decided
- The Investments page "transaction sidebar" is the Pebble inspector of the cash `TransactionList` (`PebbleRegister.tsx`); the brokerage `InvestmentTransactionList` has no inspector. Most cash rows there are investment cash legs (`linkedInvestmentTransactionId`).
- A linked cash leg's inspector says Edit (not View) and offers Delete; `TransactionList.handleDeleteConfirm` routes it to `investmentsApi.deleteTransaction(linkedInvestmentTransactionId)` with its own confirm copy (`list.delete.investmentTitle/Message`), because the backend refuses deleting a cash leg alone (`investmentCashLegLockedError` in `transactions.service.ts remove`).
- The inspector lines up with the first day block via a measured CSS var `--ui-pebble-first-block` (top margin), since the sort strip wraps and a today divider can come first. Sticky insets apply to the border box, so the margin does not change the stuck position.

## Tried and ruled out
- A fixed top margin: the day heading's height and the sort strip's wrapping are not constant.

## Watch out
- Pagination's -10/+10 are `inline-flex` (to hide below `sm`); without `items-center` their label sits at the top of the 2rem Pebble pill while the inline-block arrows centre.
- The table register (`TransactionRow`) still shows View and hides Delete on linked rows; only the Pebble inspector changed.
