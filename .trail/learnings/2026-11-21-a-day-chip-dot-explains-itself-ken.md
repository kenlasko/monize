---
title: "A day-chip dot explains itself through InfoTooltip's trigger, not a popover of its own"
author: Ken
date: 2026-11-21
branch: feat/outlook-dot-tooltip
cost: { minutes: 13, tokens: 131102 }
id: l-fd3c5ca2
scope: repo
status: active
src: agent
touches:
  - docs/frontend/ui-conventions.md
  - frontend/src/components/dashboard/upcoming-occurrences.test.ts
  - frontend/src/components/dashboard/upcoming-occurrences.ts
  - frontend/src/components/dashboard/variants/UpcomingBillsListPebble.tsx
  - frontend/src/components/dashboard/variants/UpcomingBillsListVariants.test.tsx
  - frontend/src/components/dashboard/variants/upcoming-bills-view.ts
  - frontend/src/components/scheduled-transactions/variants/BillsOutlook.test.tsx
  - frontend/src/components/scheduled-transactions/variants/BillsOutlookPebble.tsx
  - frontend/src/components/ui/InfoTooltip.tsx
---

## Decided
The dots on the Pebble day chips (Bills "Next fourteen days" band and the dashboard Upcoming Bills widget) say what they are through `InfoTooltip` with the dot passed as its `trigger`. That gives hover, keyboard focus and tap from the one shared popover, and a touch reader can open it. The tooltip text reuses existing catalog keys so no locale needs new strings.

## Tried and ruled out
A small purpose-built portal tooltip on the dot (hover for a mouse, tap toggle). It worked, but `ui-conventions.test.ts` fails any `role="tooltip"` outside `InfoTooltip`, and the repo says a guard is met by fixing the code, not by widening its allowlist.

## Watch out
Making the dots tooltip triggers makes them `<button>`s with an `aria-label`. Tests that counted buttons or matched buttons by a name regex now also match the dots; tell them apart by name or by `aria-expanded`, which only trigger buttons carry. The dots sit in a horizontally scrolling strip, so the tooltip needs `usePortal`, or the strip clips it.

In the code: `StripDot` in `UpcomingBillsListPebble.tsx` (shared with `BillsOutlookPebble.tsx`); the `trigger` prop on `InfoTooltip.tsx`; `payee` and `currencyCode` on `UpcomingStripItem`, filled by `buildUpcomingStrip`.
