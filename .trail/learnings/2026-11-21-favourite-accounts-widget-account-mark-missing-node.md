---
title: "Favourite Accounts widget: account mark missing in Folio/Pebble"
author: Node
date: 2026-11-21
branch: claude/issue-2319
cost: { minutes: 8, tokens: 97585 }
touches:
  - frontend/src/components/dashboard/variants/FavouriteAccountsFolio.tsx
  - frontend/src/components/dashboard/variants/FavouriteAccountsPebble.tsx
  - frontend/src/components/dashboard/variants/FavouriteAccountsStandard.tsx
  - frontend/src/components/dashboard/variants/FavouriteAccountsVariants.test.tsx
---

## Decided
Issue #2319: Folio and Pebble styles of the dashboard Favourite Accounts
widget did not show the account/institution icon that Standard always
showed. Fixed by exporting `AccountMark` (institution logo, or the star
when there is none) from `FavouriteAccountsStandard.tsx` and reusing it
in `FavouriteAccountsFolio.tsx`. Pebble's round avatar kept its
name-initial letter disc as the no-logo fallback, but now swaps to the
institution's `InstitutionLogo` when `row.institutionLogo?.hasLogo` is
true -- the same "entity's own logo replaces the fallback disc" rule
`PebbleRegister.tsx` already applies to a transaction's payee logo.

## Tried and ruled out
Did not make Pebble fall back to the star like Standard/Folio when there
is no logo -- Pebble's whole design language for this widget is the
round letter-mark avatar (see `AVATAR_TINTS`), so swapping only the
"has a logo" branch to `InstitutionLogo` and leaving the letter-disc
fallback alone keeps Pebble's own fallback aesthetic intact instead of
reintroducing Standard's star into a style that never had one.

## Watch out
`FavouriteAccountRow.institutionLogo` was already threaded all the way
from `FavouriteAccounts.tsx` into the row type -- no data plumbing
needed, only the two variant components were missing the read.
`trail check` flags this diff against two unrelated learnings
(colSpan on phone registers, chart legend spacing) purely because the
new `<span>` wrapper in Folio matches the literal substring "span";
not a real conflict.
