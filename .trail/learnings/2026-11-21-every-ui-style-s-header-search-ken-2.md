---
title: "Every UI style's header search opens the command palette; Standard is a bare magnifying glass because its nav row is crowded"
author: Ken
date: 2026-11-21
branch: main
cost: { minutes: 11, tokens: 32726 }
id: l-bd344e74
scope: repo
status: active
replaces: l-952ddd2b
src: agent
---

## Decided
Ken asked for the default (Standard) style's top-bar search to open the same command palette as the other styles, and the old expanding inline transaction search was deleted. Folio and Pebble keep the labelled "Search or jump to" field. Standard shows only a magnifying glass: a labelled field made "Bills & Deposits" wrap onto two lines in the full-width nav row, and Ken chose the bare glass over narrowing the field. The palette footer carries a Ctrl/Cmd+K hint (existing help strings) so the shortcut is still discoverable.

## Tried and ruled out
Keeping the inline search beside the palette: two search boxes in one header. Showing the label only from the 2xl breakpoint: could not be measured without the running app, and Ken preferred the icon.

## Watch out
Removing the inline input's bare `focus:ring` made the focus-ring guard in `ui-conventions.test.ts` fail "keeps the baseline shrink-only"; the fix was deleting `AppHeader.tsx` from that baseline. A hand-picked `hover:bg-gray-100` on the new icon button trips the row-hover guard; use `HOVER_ROW_ON_PAGE`. The palette is mounted globally and does not depend on the UI style. The four `navigation.search.*` strings were removed from every locale.

In the code: `SearchIconTrigger` and `PaletteTrigger` in `header-controls.tsx`; the hint in `CommandPalette.tsx`.
