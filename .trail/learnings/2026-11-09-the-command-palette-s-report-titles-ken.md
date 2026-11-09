---
title: "The command palette's report titles are derived when catalogs load, and it never opens over a dialog or on a signed-out page"
author: Ken
date: 2026-11-09
branch: feat/command-palette
id: l-d8d7f6b1
scope: repo
status: active
replaces: l-4ba099c9
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
The palette lists built-in reports from `reportNames`, derived from `reports.page.names` inside the catalog loader. The app shell is reachable from the root layout, so the public-catalog guard requires any namespace it reads to ship on signed-out pages; the full `reports` catalog is about 90 KB and the titles about 2 KB. It has to be in the loader because a sign-in's soft navigation swaps the catalog for the `/intl-messages` response, which never passes through the layout.

Ctrl/Cmd+K opens help search instead of the palette over any open modal and on signed-out or public pages. Every palette result navigates, and a pushHistory Modal's unmount undoes that. The shell mounts on some public routes, where the palette's reads would 401 and redirect to the login screen.

The new-transaction shortcut is Ctrl/Cmd+Enter. No modifier-plus-letter is safe: Alt+N swallowed AltGr and Option letters such as the Polish n with acute.

## Tried and ruled out
Adding `reports` to the public list: satisfies the guard but puts 90 KB on the login screen. Deriving `reportNames` in the layout's scope function: lost on the sign-in catalog swap, and a browser check that loads a page directly cannot see it.

## Watch out
Next's dev server writes an untracked `frontend/AGENTS.md`; delete it after a local run. `pkill -f "next dev"` inside a shell command also matches that shell and kills it. Playwright's bundled Chromium cannot start on the NixOS WSL box; pass a Nix Chromium as executablePath.

In the code: frontend/src/i18n/client-messages.ts (withReportNames), frontend/src/i18n/messages.ts (loadMessages), frontend/src/components/command-palette/CommandPaletteShortcut.tsx.
