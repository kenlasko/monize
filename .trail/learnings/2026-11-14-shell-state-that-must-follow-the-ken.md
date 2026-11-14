---
title: "Shell state that must follow the data goes at the top of the data folder, not in the shell profile folder"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-63ca425b
scope: repo
status: active
src: agent
touches:
  - desktop/README.md
  - desktop/build/installer.nsh
  - desktop/src/dialogs.ts
  - desktop/src/electron-main.ts
  - desktop/src/move/layout.ts
  - desktop/src/recovery-export.ts
  - desktop/src/shell/strings.ts
---

## Decided
- The recovery-key reminder's state is `recovery-reminder.json` at the top of the data folder. A "Move data folder" copies only `shell/Local State` out of the Chromium profile folder, so anything else written under `shell/` is left behind by a move.
- A new top-level file Monize creates goes in OWNED_TOP_LEVEL and gets a matching `Delete` in the uninstaller's moved-folder cleanup; packaging.spec.ts fails until both lists agree.

## Watch out
- move.spec.ts "failing to mark the old folder is a warning" fails when jest runs as root (root ignores the read-only folder the spec sets up); run the desktop specs as the `node` user in the container.

In the code:
- desktop/src/move/layout.ts (movesWithData, OWNED_TOP_LEVEL), desktop/build/installer.nsh (un.MonizeRemoveMovedFolder), desktop/src/packaging.spec.ts
- desktop/src/shell/recovery-reminder.ts, desktop/src/recovery-reminder.ts
