---
title: "The mobile tab bar's picks live in viewDefaults as one list, and the app header stays pinned below xl so titles can collapse into it"
author: Ken
date: 2026-11-09
branch: feat/command-palette
id: l-56da4c6a
scope: repo
status: active
src: agent
touches:
  - backend/src/users/dto/update-preferences.dto.ts
  - backend/src/users/validators/is-view-defaults.validator.spec.ts
  - backend/src/users/validators/is-view-defaults.validator.ts
  - backend/src/users/view-defaults.ts
  - docs/frontend/ui-conventions.md
  - e2e/readme/04-mobile.spec.ts
  - e2e/readme/05-recordings.spec.ts
  - frontend/src/app/ai/page.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/app/globals.css
---

## Decided
The bottom tab bar replaces the hamburger below `xl`, the same width the hamburger served. The reader picks up to three tabs; the centre add button and More are fixed, so the bar always has five places. The picks are one `mobileTabs` list in the existing cross-device `viewDefaults` preference, so no migration, and one write means a swap can never be saved half-way.

The drawer stays mounted in AppHeader and the More tab opens it through a small store, because `useHelpMenuEntries` must only be built once and the drawer needs the header's sign-out.

Below `sm` the header trims to avatar, search, history and bell. Help, Settings and Logout move under More. That cut-off matches the tour engine's phone check, so tour anchors on the Settings button keep working on tablets.

## Tried and ruled out
Three separate per-slot keys in `viewDefaults`: each would repeat the whole enum in both layers, and a swap became two writes. A list key keeps the contract spec's regex unchanged, which is why tab ids are link `labelKey`s (letters only) and not hrefs: the spec only reads letter-only values.

Rendering the tab bar inside AppHeader: the header's transform becomes the containing block for `fixed` children.

## Watch out
The closed header search input was never really `w-0`. The unlayered form rules beat the Tailwind utility, so it sat at 260px, invisibly, and only flex shrinking hid that. It needs `w-0!`. Only a real render showed this; jsdom cannot.

`flex-shrink-0` on the header's right cluster must stay `max-xl:`. Applied at `xl` it squeezes the nav links at 1280px.

A page that sets its own height has to subtract `--tab-bar-space` or the bar covers its bottom.

To render here on NixOS: the Playwright-cached Chromium will not start; `nix-shell -p chromium` gives one that does, passed as `executablePath` with the API mocked.

In the code: frontend/src/components/layout/MobileTabBar.tsx, frontend/src/hooks/useMobileTabs.ts, frontend/src/hooks/useCollapsingHeaderTitle.ts, frontend/src/store/mobileChromeStore.ts, frontend/src/lib/view-defaults.ts, backend/src/users/validators/is-view-defaults.validator.ts
