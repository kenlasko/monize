---
title: "Folio's fourteen-day bar strip opens a day's bills on click, reversing the earlier Pebble-only scope"
author: Ken
date: 2026-11-21
branch: feat/folio-day-popup
cost: { minutes: 1, tokens: 1395 }
id: l-9e4b5c59
scope: repo
status: active
src: agent
---

## Decided
Ken asked for the click-a-day popup on the Folio style too, which is the separate agreement the earlier Pebble-only learning said was needed. Each Folio day column is now a button that opens the same day popup the Pebble chips use, on both the dashboard Upcoming Bills widget and the Bills page "Next fourteen days" band. The bars stay decorative: the ruled list under them still carries every figure.

## Tried and ruled out
Keeping the strip as `role="img"`. An image role cannot hold interactive children, so the wrapper became `role="group"` with the same label, and the day columns became buttons. A plain `ol` with `li` per day was dropped because the Folio list test indexes `listitem`s and the strip would have shifted them.

## Watch out
A `<button>` may only hold phrasing content, so the column's inner blocks are `span`s styled `flex`, not `div`s. The hover tint must be `HOVER_ROW_ON_PAGE`: a hand-picked `hover:bg-gray-100` trips the row-hover guard in `ui-conventions.test.ts`. `trail check` flags this change against the earlier Pebble-only learning; that conflict is the reversal itself.

In the code: `DayDetailButton` (button plus popup) in `UpcomingBillsListPebble.tsx`, used by `DayChip`, `UpcomingBillsListFolio.tsx` and `BillsOutlookFolio.tsx`.
