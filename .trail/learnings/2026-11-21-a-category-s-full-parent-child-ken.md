---
title: "A category's full Parent: Child path comes from the page's label map, because list rows carry only the category's own name"
author: Ken
date: 2026-11-21
branch: fix/folio-category-full-label
cost: { minutes: 15, tokens: 52342 }
id: l-761d74e2
scope: repo
status: active
src: agent
touches:
  - frontend/src/app/bills/page.tsx
  - frontend/src/components/scheduled-transactions/ScheduledTransactionList.test.tsx
  - frontend/src/components/scheduled-transactions/ScheduledTransactionList.tsx
---

## Decided
The joined category on a transaction or bill row has only its own name, not its parent. Surfaces that show the whole path read it from the label map the page already builds, and fall back to the own name when the map has no entry. Folio's register uses it only in its ledger form (plain text with room, cap lifted to 24rem); the filled capsule in other styles keeps the short name. The Bills list shows the full path in every style.

## Watch out
A phone-width capsule that truncates must carry the full path in its title, since a cut label has to stay readable. The Bills list's per-row account mark takes its mark function from one hook call in the list, not one per row, and the name span keeps the truncate class and title because a mobile card test reads them off the element holding the text.

In the code: TransactionRow (categoryLabelMap, LEDGER_CATEGORY_MAX_WIDTH), ScheduledTransactionList (ScheduledCategoryMarker, ScheduledAccountMarker), buildCategoryLabelMap and useAccountPickerIcon.
