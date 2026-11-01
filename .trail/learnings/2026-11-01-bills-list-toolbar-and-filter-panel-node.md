---
title: Bills list toolbar and filter panel matched to Transactions (issue 1981)
author: Node
date: 2026-11-01
branch: claude/issue-1981
cost: { minutes: 30, tokens: 145741 }
touches:
  - docs/images/readme/mobile-bills.png
  - website/docs/bills-and-deposits.html
  - website/docs/images/bills-deposits-page.light.png
  - website/docs/images/bills-deposits-page.png
  - website/docs/images/bills-list.light.png
  - website/docs/images/bills-list.png
  - frontend/src/i18n/messages/de/bills.json
  - frontend/src/i18n/messages/es/bills.json
  - frontend/src/i18n/messages/fr/bills.json
  - frontend/src/i18n/messages/hi/bills.json
---

## Decided
- Bills filter fold is the shared FilterPanelHeader ("Show filters"/"Hide"); the All/Bills/Deposits selector sits at the top of the folding panel body (SEGMENTED_TOOLBAR_GROUP_CLASS + toolbarSegmentClass for full phone width).
- filterType moved into useBillsFilters (same 'monize-bills-filter-type' key) and counts as an active filter, with a removable chip and reset by Clear, because it can be folded out of sight.
- The bar above the bills table is ListTopToolbar with a new `summary` prop (count line for an unpaged list): summary + ViewModeToggle left, Export + density right, inside the list card directly above the thead. Calendar view keeps its own month toolbar.
- Bills export is client-side: lib/bills-export.ts, English headers like the register export, next-occurrence amount/date via nextOccurrenceEffectiveAmount/nextOccurrenceDueDate, unpriced amount = empty cell.

## Tried and ruled out
- Passing fake single-page paging props to ListTopToolbar to get "Showing": it renders an inert stepper and "1-12 of 12" instead of "x of y".

## Watch out
- Removing BillsFilterPanel's hand-rolled count badge makes the pill guard in ui-conventions.test.ts demand the baseline entry be deleted (shrink-only).
- Docs screenshots on the worker: rootless Docker port publishing fails intermittently (RootlessKit api.sock). Override `ports: !reset []`, run mcr.microsoft.com/playwright:v1.64.1-noble on the issue-N_e2e-network with a node TCP proxy localhost:3001 -> frontend:3000, and set backend NODE_OPTIONS=--max-old-space-size=4096 (its in-container nest build OOMs at the default heap).
- After retaking images, re-run `npm run docs:build`: the generated .html changes again and website-docs.test.ts fails otherwise.
