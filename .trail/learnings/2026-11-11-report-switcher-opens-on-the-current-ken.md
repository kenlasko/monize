---
title: "Report switcher opens on the current report, filed under its own category even when starred"
author: Ken
date: 2026-11-11
branch: feat/release-1.21-tours
id: l-c6145fd4
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/command-palette/CommandPalette.tsx
  - frontend/src/components/dashboard/DashboardEditBar.tsx
  - frontend/src/components/help/HelpPanel.tsx
  - frontend/src/components/layout/HelpMenu.tsx
  - frontend/src/components/layout/PageHeader.tsx
  - frontend/src/components/reports/ReportSwitcher.test.tsx
  - frontend/src/components/reports/ReportSwitcher.tsx
  - frontend/src/components/ui/EntitySwitcher.test.tsx
  - frontend/src/components/ui/EntitySwitcher.tsx
  - frontend/src/i18n/messages/de/tours.json
---

## Decided
The report caret menu lists the report on screen (highlighted, aria-current) and opens scrolled so it is centred, so the reports beside it (e.g. the other Investment reports when on Investment Performance) are what the reader sees first. Picking it only closes the menu.
The current report is always filed under its own category section, never in Favourites, even when starred: in Favourites the menu would open at the top, away from the siblings the reader is switching between.

## Watch out
This is opt-in (`showCurrent`) on the shared EntitySwitcher; the account/payee/security/etc. switchers still omit the current entity.
The scroll sets the list's scrollTop directly; scrollIntoView would also scroll the page, which re-measures the caret and moves the fixed menu.

In the code: frontend/src/components/ui/EntitySwitcher.tsx (showCurrent, useLayoutEffect scroll), frontend/src/components/reports/ReportSwitcher.tsx.
