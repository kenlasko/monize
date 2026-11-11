---
title: "A dashboard grid item must wrap its widget in the same element in and out of edit mode, or every widget remounts and refetches"
author: Ken
date: 2026-11-11
branch: feat/dashboard-edit-mode
cost: { minutes: 17, tokens: 47964 }
id: l-ca4d683a
scope: repo
status: active
src: agent
touches:
  - docs/future-plans/dashboard-edit-mode.md
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/components/dashboard/DashboardGrid.test.tsx
  - frontend/src/components/dashboard/DashboardGridItem.test.tsx
  - frontend/src/components/dashboard/DashboardGridItem.tsx
  - frontend/src/components/dashboard/DashboardHero.tsx
  - frontend/src/components/dashboard/DashboardHeroSettingsModal.test.tsx
  - frontend/src/components/dashboard/DashboardHeroSettingsModal.tsx
  - frontend/src/components/dashboard/NetWorthHero.test.tsx
  - frontend/src/components/dashboard/WidgetEditOverlay.test.tsx
---

## Decided
- The grid item always renders one wrapper element around the widget and only toggles `inert`, opacity and the test id for edit mode. Swapping between a bare child and a wrapped one changed the element type at that position, so React remounted every widget on entering and leaving edit mode: self-fetching widgets refetched, Trivia reset to its first fact, opened chart state was lost.
- A tile that needs height on a phone (where the grid item has no floor) puts it on its content, never on the card shell; the card guard fails a floor at any breakpoint, a card class held in a local, and self-alignment on a card.

## Watch out
- Tests that reached the item as `card.parentElement` break when a wrapper is added; use `closest('[data-widget-id]')`.

In the code:
- frontend/src/components/dashboard/DashboardGridItem.tsx; the guard in frontend/src/test/ui-conventions.test.ts; WidgetPlaceholder in WidgetEditOverlay.tsx.
