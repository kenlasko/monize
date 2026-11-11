---
title: Empty row space in dashboard edit mode becomes an Add Widget slot that only offers widgets fitting the gap
author: Ken
date: 2026-11-11
branch: feat/dashboard-edit-mode
cost: { minutes: 6, tokens: 28698 }
id: l-ebb4ee3d
scope: repo
status: active
src: agent
touches:
  - docs/future-plans/dashboard-edit-mode.md
  - frontend/src/components/dashboard/WidgetEditOverlay.test.tsx
  - frontend/src/components/dashboard/widget-registry.tsx
  - frontend/src/components/dashboard/WidgetResizeGrip.test.tsx
  - frontend/src/components/dashboard/WidgetResizeGrip.tsx
  - frontend/src/hooks/useGridReorder.test.ts
  - frontend/src/hooks/useGridReorder.ts
  - frontend/src/hooks/useIsMobile.test.ts
  - frontend/src/hooks/useIsMobile.ts
  - frontend/src/components/dashboard/dashboard-layout.ts
---

## Decided
Ken chose (2026-11-11), for any empty space of a third or more at a row's end:
- Slots show only in edit mode; the everyday dashboard leaves the space empty.
- A widget dragged onto a slot moves there and shrinks to the gap's width, if its minimum allows; a widget whose minimum is wider than the gap is not accepted.
- A widget added from a slot takes the gap's exact width, and the slot's list shows only widgets that can be that narrow.
- The end-of-dashboard Add tile stays and still lists every hidden widget, added at its default size.
- Slots stay put during a drag, so the targets don't move under the pointer; the dropped widget lands at the slot's position even if the move reflows later rows.
- Top Movers, Favourite Accounts and Upcoming Bills may be a third wide (Ken's request), so they fit one-third slots.

## Tried and ruled out
- Slots on the everyday dashboard: clutters the view the reader uses most.
- Accepting only widgets already narrow enough: makes the reader resize first, then drag.
- Moving a widget at its own size: it wraps and the gap stays, so the slot does nothing.
- Adding at the widget's default width: the row can still end short.
- Replacing the end tile with slots: a full last row would leave no way to add.

## Watch out
- Gaps can only be 4, 6 or 8 of the 12 columns (a 2-column remainder is too narrow for any widget), and there are none below lg (one column).

In the code:
- Layout model frontend/src/components/dashboard/dashboard-layout.ts; grid DashboardGrid.tsx; AddWidgetDialog.tsx; drag frontend/src/hooks/useGridReorder.ts.
