---
title: Hiding the Description column must also hide the memo printed after the payee in Folio and Pebble
author: Ken
date: 2026-11-21
branch: fix/txn-date-header-description-toggle
cost: { minutes: 16, tokens: 119342 }
id: l-aecd28ff
scope: repo
status: active
src: agent
touches:
  - frontend/src/app/ui-styles-register.css
  - frontend/src/components/transactions/CategoryPill.test.tsx
  - frontend/src/components/transactions/CategoryPill.tsx
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/components/transactions/TransactionRow.tsx
  - frontend/src/components/transactions/variants/PebbleRegister.tsx
---

## Decided
Hiding Description is not just dropping a column: Folio and Pebble print the description inline after the payee, so that text has to honour the reader's hidden set too. Folio's table-level hidden set always contains description (the column is never drawn), so it cannot tell the row whether the reader hid it; the row takes a separate flag from the reader's own set. The Pebble inspector panel keeps its Description row, since it is a detail view.

## Tried and ruled out
Reading the table's hidden set in the Folio row: it is always "hidden" for description in Folio, so the memo would never show at all.

## Watch out
Pebble has no Columns chooser on the Transactions page, so a hidden Description there comes from the default-columns setting or from another style sharing the same store. A test that only toggles the Folio/Standard menu will not exercise Pebble.
Folio's Date sort button has its own colour rule; it must follow the other headers' dark-mode grey or it reads as disabled.

In the code: TransactionList passes hideMemo={hiddenColumns.has('description')} to TransactionRow and hidden={hiddenColumns} to PebbleRegister; tests in TransactionList.uiStyles.test.tsx set the hidden set through useHiddenColumnsStore.
