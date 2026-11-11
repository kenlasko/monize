---
title: "A dashboard widget's height floor lives on its grid item, and edit-mode drags cancel on Escape without leaving edit mode"
author: Ken
date: 2026-11-11
branch: feat/dashboard-edit-mode
cost: { minutes: 20, tokens: 120299 }
id: l-302c32c1
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/dashboard/WidgetEditOverlay.test.tsx
  - frontend/src/components/dashboard/WidgetEditOverlay.tsx
  - frontend/src/components/dashboard/WidgetResizeGrip.test.tsx
  - frontend/src/components/dashboard/WidgetResizeGrip.tsx
  - frontend/src/i18n/messages/en/dashboard.json
  - frontend/src/i18n/messages/xx/dashboard.json
  - website/docs/dashboard.html
  - website/docs/dashboard.md
  - website/docs/search-index.json
  - frontend/src/app/dashboard/page.test.tsx
---

## Decided
- A widget's minimum height is set once, on the grid item, from the layout's height preset; a widget card never sets its own lg floor. The item is a one-cell grid, so the card (and the edit overlay beside it) fills the item by grid stretch, never a percentage height. A floor that must apply on a phone goes on the card's content area (Trivia does this).
- Done in edit mode is the only write of the layout; the hero's dialog writes only the hero's settings slice.
- Width and height choices and the corner grip are not rendered below lg (a media query, not a CSS hide), so a phone's overlay has no dead controls.
- A drag or resize in progress takes Escape in the capture phase and calls preventDefault; edit mode's own Escape handler ignores prevented events, so Escape cancels the drag only.

## Tried and ruled out
- Lazy-loading the reorder hook with next/dynamic: a hook can't be loaded that way without wrapping the whole grid, so it is imported statically; the grip, chip, overlay, bar and dialogs stay on demand.
- `grid-rows-1` for the item's single row: its zero minimum lets the row shrink below the card's content; the row is auto.

## Watch out
- None of this was tried in a real browser as of 2026-11-11: WebKit row stretch, minWidth legibility at 1024/1440px, touch drag and edge auto-scroll, Back leaving edit mode alongside Next's router, and the resize outline after scrolling mid-drag (rectangles are measured on press).
- The first-load size of the dashboard route before and after was not measured.

In the code:
- frontend/src/components/dashboard/DashboardGridItem.tsx (`[grid-template-areas:'cell'] *:[grid-area:cell]`), dashboard-layout.ts (HEIGHT_CLASSES), the card-stretch guard in frontend/src/test/ui-conventions.test.ts.
- frontend/src/hooks/useDashboardLayoutDraft.ts (single write, history marker `dashboardEdit`, Escape ignored when a dialog is open or the event is defaultPrevented); frontend/src/hooks/useGridReorder.ts; WidgetResizeGrip.tsx.
