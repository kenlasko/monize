---
title: "The mobile tab bar's picks are a list field in viewDefaults, and the header stays pinned below xl so titles can collapse into it"
author: Ken
date: 2026-11-09
branch: feat/command-palette
id: l-d9f66aa9
scope: repo
status: active
replaces: l-56da4c6a
src: agent
touches:
  - backend/src/users/dto/update-preferences.dto.ts
  - backend/src/users/validators/is-view-defaults.validator.spec.ts
  - backend/src/users/validators/is-view-defaults.validator.ts
  - backend/src/users/view-defaults.contract.spec.ts
  - backend/src/users/view-defaults.ts
  - docs/frontend/ui-conventions.md
  - e2e/readme/04-mobile.spec.ts
  - e2e/readme/05-recordings.spec.ts
  - frontend/src/app/ai/page.tsx
  - frontend/src/app/dashboard/page.tsx
---

## Decided
The bar replaces the hamburger below `xl`. The reader picks up to three tabs; the centre add button and More are fixed. The picks are one `{ list, max }` field in the cross-device `viewDefaults`, so no migration, one write per swap, and the contract spec pins both the values and the limit across layers. The list has no gaps: a slot set to None closes up.

The drawer stays in AppHeader and More opens it through a store, because `useHelpMenuEntries` must only be built once.

## Tried and ruled out
Three per-slot keys: each repeats the whole enum in both layers and a swap becomes two writes. Rendering the bar inside AppHeader: its transform captures `fixed` children.

## Watch out
The closed header search input needs `w-0!`: unlayered form rules beat the utility, and only a real render showed the 260px it took. `flex-shrink-0` on the header's right cluster must stay `max-xl:`, or the nav squeezes at 1280px. A page that sets its own height subtracts `--tab-bar-space`. Tab ids are link `labelKey`s because the contract spec only reads letter-only values.

In the code: frontend/src/components/layout/MobileTabBar.tsx, frontend/src/hooks/useMobileTabs.ts, frontend/src/lib/view-defaults.ts, backend/src/users/view-defaults.contract.spec.ts
