---
title: "The dashboard's 500px widgets grow to the 540px standard height, accepted, and a history entry can outlive edit mode after a link"
author: Ken
date: 2026-11-11
branch: feat/dashboard-edit-mode
cost: { minutes: 16, tokens: 28347 }
id: l-e43693f6
scope: repo
status: active
src: agent
touches:
  - docs/future-plans/dashboard-edit-mode.md
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/components/dashboard/WidgetEditOverlay.test.tsx
  - frontend/src/components/dashboard/WidgetEditOverlay.tsx
  - frontend/src/components/dashboard/WidgetResizeGrip.test.tsx
  - frontend/src/components/dashboard/WidgetResizeGrip.tsx
  - frontend/src/components/dashboard/dashboard-layout.test.ts
  - frontend/src/components/dashboard/dashboard-layout.ts
  - frontend/src/components/dashboard/widget-glyphs.tsx
---

## Decided
- Ken accepted (2026-11-11) that Net Worth, Assets vs Liabilities, Top Movers and Favourite Securities move from a 500px to the 540px standard floor on wide screens, so the Net Worth row grows 40px for every reader. State it in the PR rather than compensate.
- Leaving the dashboard by a link while in edit mode leaves edit mode's history entry behind, so coming back needs one extra Back.

## Tried and ruled out
- A fifth 500px height preset: no visible change, but five height buttons to explain in edit mode.
- Making standard 500px: fixes four widgets by shrinking the fifteen that were 540px.
- Popping the stale entry on unmount after a link: Next has already pushed the new page, so back() would undo the navigation. Popping it when the dashboard mounts on a marked entry would break Forward.

## Watch out
- Modal's own unmount back() has the same undo-a-navigation risk when a pushHistory modal unmounts because of a navigation; not fixed.

In the code:
- defaultHeight 'standard' on those four in frontend/src/components/dashboard/widget-registry.tsx; HEIGHT_FLOORS_PX in dashboard-layout.ts.
- Unmount pop guarded by the `dashboardEdit` marker in frontend/src/hooks/useDashboardLayoutDraft.ts; Next 16 does not keep custom history keys on navigation.
