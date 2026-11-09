---
title: The command palette grows with its results and sits near the top of the screen so the search box never moves
author: Ken
date: 2026-11-09
branch: feat/mobile-tab-bar
id: l-349bcb93
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/command-palette/CommandPalette.tsx
  - frontend/src/components/settings/MobileTabsGroup.tsx
  - frontend/src/components/ui/Modal.test.tsx
  - frontend/src/components/ui/Modal.tsx
  - website/docs/getting-started.html
  - website/docs/images/command-palette.light.png
  - website/docs/images/command-palette.png
  - website/docs/images/settings-preferences.light.png
  - website/docs/images/settings-preferences.png
  - website/docs/settings-and-security.html
---

## Decided
The results list has no set height: the palette sizes to its content, capped at the viewport, and only the list scrolls past that. It is anchored 4dvh from the top rather than centred, because a centred panel moves its search box on every keystroke as the results change.

## Tried and ruled out
Making it tall enough to never scroll: a one-letter search returns 44 rows, about 2,300px, which fits no screen. A 10dvh top offset: the 11-row opening list (675px with the box and footer) scrolled at 1280x720; 4dvh fits it.

## Watch out
The panel's cap and the offset are a pair: changing `pt-[4dvh]` means changing `96dvh - 1rem` with it, or the panel overflows the screen.

In the code: frontend/src/components/command-palette/CommandPalette.tsx, `anchorTop` in frontend/src/components/ui/Modal.tsx
