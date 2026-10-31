---
title: "Accounts list column priority: Balance outranks the columns to its left"
author: Node
date: 2026-10-31
branch: claude/issue-1966
cost: { minutes: 10, tokens: 101833 }
touches:
  - frontend/src/components/accounts/AccountList.test.tsx
  - frontend/src/components/accounts/AccountList.tsx
  - frontend/src/components/accounts/AccountRow.test.tsx
  - frontend/src/components/accounts/AccountRow.tsx
  - frontend/src/components/accounts/account-list-columns.ts
  - frontend/src/i18n/messages/de/accounts.json
  - frontend/src/i18n/messages/en/accounts.json
  - frontend/src/i18n/messages/es/accounts.json
  - frontend/src/i18n/messages/fr/accounts.json
  - frontend/src/i18n/messages/hi/accounts.json
---

## Decided
- Column visibility on the Accounts table lives once in frontend/src/components/accounts/account-list-columns.ts (ACCOUNT_COLUMN_TIER), read by the header, the group header placeholders and AccountRow. Container queries on the scroll wrapper (ACCOUNT_TABLE_CONTAINER = '@container'), not viewport breakpoints, the same reasoning as register-columns.ts.
- Drop order as the table narrows: Last Reconciled + Unreconciled (<1120px of table), then Status (<768), then Type (<640). Name yields width from sm (w-full max-w-0, floor min-w-28) instead of md:max-w-none, which let a long name push Balance behind the sticky Actions column.
- Normal density's investment breakdown is two keys, row.combinedInvestments / row.combinedCash, one line each, because the nowrap Balance cell's widest line set its width. row.combinedBreakdown stays: FavouriteAccounts and AccountBalancesReport still use it.

## Tried and ruled out
- Keeping the reconciliation columns at the lg viewport breakpoint: at 1024px viewport (928px of table at lg:px-12), Type + Status + both reconciliation columns + Balance + Actions at Normal padding already add up to more than the table.

## Watch out
- The tier thresholds are estimates from padding and label widths, not measured in a browser (no Docker here). Retune the numbers in account-list-columns.ts if a locale's headers overflow.
- en-GB / en-US accounts.json are partial overlays without row.* keys; a script that rewrites every locale must skip them.
