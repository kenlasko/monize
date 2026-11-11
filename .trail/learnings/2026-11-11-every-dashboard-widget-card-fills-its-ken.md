---
title: Every dashboard widget card fills its grid slot; the July change that let two cards shrink to their content is reversed
author: Ken
date: 2026-11-11
branch: feat/dashboard-edit-mode
cost: { minutes: 2, tokens: 8074 }
id: l-02d990f3
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/dashboard/FavouriteAccounts.tsx
  - frontend/src/components/dashboard/UpcomingBills.tsx
  - frontend/src/test/ui-conventions.test.ts
---

## Decided
- Ken asked (2026-11-11) that Favourite Accounts and Upcoming Bills fill their whole widget slot, like every other widget: spare room goes inside the card, not as blank page beside or under it.

## Tried and ruled out
- Keeping the July 2026 top-alignment (commits 3e13cb498, b435054f3), which let a short list shrink instead of stretching to a taller row-mate. Once the grid slot carries the widget's height preset, it left blank space outside the card and made the height setting do nothing visible.

## Watch out
- Do not reintroduce `self-start` (or `self-center`) on a dashboard card root to "fix" white space inside a sparse card; choose a smaller height or width preset instead.

In the code:
- `lg:self-start` removed from the card roots in frontend/src/components/dashboard/FavouriteAccounts.tsx and UpcomingBills.tsx; the card-stretch guard in frontend/src/test/ui-conventions.test.ts is due to fail on it.
