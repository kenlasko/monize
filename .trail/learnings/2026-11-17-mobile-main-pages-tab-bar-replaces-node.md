---
title: "Mobile main pages: tab-bar + replaces header New, page snapshots, kept scroll (issue #2253)"
author: Node
date: 2026-11-17
branch: claude/issue-2253
cost: { minutes: 53, tokens: 543499 }
touches:
  - docs/frontend/api-and-cache.md
  - frontend/src/app/accounts/page.test.tsx
  - frontend/src/app/accounts/page.tsx
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/lib/page-snapshot.ts
  - frontend/src/lib/transactions-page-snapshot.ts
  - frontend/src/app/budgets/page.tsx
  - frontend/src/components/layout/MobileTabBar.test.tsx
  - frontend/src/components/layout/MobileTabBar.tsx
---

## Decided
- A main page's "New ..." button is PageHeader's `primaryAction`, not drawn below `xl`; the tab bar's + runs the same handler (`useMobileAddAction(label, run, { tourAnchor })`, or `useMobileAddChoices` when the header button is a menu: Investments, Reports). The + carries the header button's tour anchor and `findTourAnchor` prefers the copy `checkVisibility()` says is drawn.
- Returning to Accounts/Transactions/Bills/Investments/Reports/Budgets draws the last successful answer from `lib/page-snapshot.ts` (memory only) and refreshes underneath. Written only when every part of the load succeeded; a partial failure also forgets the older snapshot. Cleared by `clearAllCache()` and `authStore.logout`. Investments keys summary and first register page by the account selection; Transactions adopts its register (in render, `useTransactionsRegisterSnapshot`) only when `registerRequestKey` of the initialised filters matches.
- Scroll places (`useRetainScrollPosition(ready, contentKey?)`) are keyed by pathname with a content key beside them; `useScrollToTopOnNavigation` skips a path that has one.
- AccountList's filter bar became `AccountFilterPanel` (FilterPanelHeader fold + Badge chips, full width on a phone). This supersedes the Oct 29 "left as is" on the status filter's width: the maintainer asked for the restructure.

## Tried and ruled out
- Keying scroll places by pathname + query: Transactions `router.replace`s its stored filters into the URL after it draws, so the tab's bare `/transactions` lookup missed the place it saved.
- Clearing snapshots in `invalidateBalanceCaches()`: every write from the + would send the next Accounts visit back to the spinner, which is what the issue complained about.

## Watch out
- `src/test/setup.ts` clears the snapshot and scroll maps after each test. A page test that leaves a side request unmocked (the Accounts page test had no `institutionsApi` mock) never writes a snapshot, because that failure counts.
- `frontend/CLAUDE.md` sits ~37 bytes under its 16 KiB ceiling (`instruction-files.spec.ts`); new rules went to `docs/frontend/screens-and-dialogs.md` and `api-and-cache.md`.
- Page tests mock `PageHeader`; a mock that renders only `actions` hides a `primaryAction`.
