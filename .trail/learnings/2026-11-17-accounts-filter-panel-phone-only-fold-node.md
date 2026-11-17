---
title: "Accounts filter panel: phone-only fold, status-type-search order, no type search (issue #2253 follow-up)"
author: Node
date: 2026-11-17
branch: claude/issue-2253
cost: { minutes: 3, tokens: 40911 }
touches:
  - docs/frontend/screens-and-dialogs.md
  - frontend/src/components/accounts/AccountFilterPanel.tsx
  - frontend/src/components/accounts/AccountList.test.tsx
  - frontend/src/components/accounts/AccountList.tsx
  - website/docs/accounts.html
  - website/docs/accounts.md
  - website/docs/search-index.json
---

## Decided
- The maintainer's follow-up on #2253: the Accounts filter panel folds on a phone only (`useIsMobile` in `AccountFilterPanel`); wider than a phone it has no `FilterPanelHeader`, and a fold stored in `accounts.filter.expanded` on a phone-sized window does not hide the filters there.
- Order on this page is All/Active/Closed, then Account Type, then Search accounts. This deliberately breaks the list page's search-first toolbar rule; the exception is written into `docs/frontend/screens-and-dialogs.md` so it is not "fixed" back.
- The Account Type `MultiSelect` takes `showSearch={false}` (a dozen options at most), as TransactionFilterPanel's short pickers do.

## Tried and ruled out
- A CSS-only fold (`sm:hidden` header, `sm:block` body): the folded chips and the expanded gate would each need breakpoint twins; `useIsMobile` keeps one branch per width.

## Watch out
- `MultiSelect`'s `showSearch` defaults to true; a short picker has to opt out.
- Tests for the fold must set a phone `matchMedia` (the harness answers false, i.e. desktop); `AccountList.test.tsx`'s "filter panel fold" block does.
- The old `accounts.filter.showFilters` key is removed on mount by AccountList.
