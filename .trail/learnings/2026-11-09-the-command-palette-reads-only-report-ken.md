---
title: "The command palette reads only report titles from a derived catalog, and Ctrl/Cmd+K over another dialog stays help search"
author: Ken
date: 2026-11-09
branch: main
id: l-4ba099c9
scope: repo
status: active
src: agent
touches:
  - docs/frontend/ui-conventions.md
  - e2e/tests/help-search.spec.ts
  - frontend/src/app/settings/page.tsx
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/components/command-palette/CommandPalette.test.tsx
  - frontend/src/components/command-palette/CommandPalette.tsx
  - frontend/src/components/command-palette/CommandPaletteShortcut.test.tsx
  - frontend/src/components/command-palette/CommandPaletteShortcut.tsx
  - frontend/src/components/command-palette/useCommandItems.tsx
---

## Decided
The palette lists built-in reports from `reportNames`, a namespace derived from `reports.page.names` at the layout boundary, not from `reports`. The app shell is reachable from the root layout, so the public-catalog guard requires any namespace it reads to ship on signed-out pages; the full `reports` catalog is about 90 KB and the titles about 2 KB.

Ctrl/Cmd+K over any open modal opens help search instead of the palette. Every palette result navigates, and a pushHistory Modal's unmount pops its history entry, undoing that navigation. Help search only hands off to the side panel.

## Tried and ruled out
Adding `reports` to the public list: satisfies the guard but puts 90 KB on the login screen. Moving the names to their own catalog: about 20 call sites and every locale, out of scope for this feature.

## Watch out
Next's dev server writes an untracked `frontend/AGENTS.md`; delete it after a local run. `pkill -f "next dev"` inside a shell command also matches that shell and kills it. Playwright's bundled Chromium cannot start on the NixOS WSL box; pass a Nix Chromium as executablePath.

In the code: frontend/src/i18n/client-messages.ts (withReportNames), frontend/src/components/command-palette/CommandPaletteShortcut.tsx.
