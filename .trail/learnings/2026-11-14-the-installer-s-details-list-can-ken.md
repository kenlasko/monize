---
title: "The installer's details list can be turned on, but the long file step stays silent unless the template's extract step is replaced"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-c38c8360
scope: repo
status: active
src: agent
touches:
  - desktop/build/installer.nsh
  - desktop/scripts/installer-harness.nsi
---

## Decided
- The details list is shown: an installer-side ShowInstDetails in customHeader wins over the template's nevershow because it comes later, and SetDetailsPrint both goes in the section's first hook (customCheckAppRunning), right after the template's SetDetailsPrint none. A line before the file step says it can sit still for minutes.

## Tried and ruled out
- A verbose or log switch: /LOG needs NSIS's special logging build, which electron-builder does not use.
- Expecting the list to show file names: the template unpacks with one Nsis7z::Extract call into a temp folder, then copies with CopyFiles /SILENT, so neither step prints anything. Per-file text needs Nsis7z::ExtractWithDetails, which means replacing the template's extractUsing7za macro; that is outside electron-builder's hooks and was not done.
- Renaming the several "Monize" processes in Task Manager: they are all Monize.exe (Electron's helpers, plus the backend and frontend run with ELECTRON_RUN_AS_NODE). The Processes tab shows the exe's built-in description, so a hard-linked copy changes only the Details tab name; process.title does nothing there. The Details tab's Command line column tells them apart.

## Watch out
- Only makensis -WX through the harness checks this off Windows; whether the list really shows needs a real build.

In the code:
- desktop/build/installer.nsh (customHeader, monizeShowDetails, customInstall), desktop/scripts/installer-harness.nsi
- template: app-builder-lib 26.18.0 templates/nsis/common.nsh, installSection.nsh, include/extractAppPackage.nsh
