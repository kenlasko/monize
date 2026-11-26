---
title: Folio/Pebble header search label overflow (issue 2441)
author: Node
date: 2026-11-26
branch: claude/issue-2441
cost: { minutes: 5, tokens: 59412 }
touches:
  - frontend/src/components/layout/variants/header-controls.test.tsx
  - frontend/src/components/layout/variants/header-controls.tsx
---

## Decided
The label of the Folio/Pebble "Search or jump to" button is `PALETTE_LABEL_CLASS` in `frontend/src/components/layout/variants/header-controls.tsx`: `max-md:sr-only xl:max-2xl:sr-only`, so it collapses to the magnifying glass below md and from xl to 2xl. The user's name in `AppHeader` is hidden in the same xl-2xl band for the same reason (nav links share the row).

## Tried and ruled out
Widths were estimated from the row's width budget, not measured with screenshots. `not.toHaveClass('sr-only')` still passes with `max-md:sr-only`, since class tokens are matched exactly.

## Watch out
The worktree has no node_modules: run `npm ci --ignore-scripts` in frontend/. `tsc --noEmit` aborts without `NODE_OPTIONS=--max-old-space-size=4096`.
