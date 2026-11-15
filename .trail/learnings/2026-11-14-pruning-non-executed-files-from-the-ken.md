---
title: Pruning non-executed files from the staged backend dependencies halved the Windows install time
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-c21ab502
scope: repo
status: active
replaces: l-3955e2dd
src: agent
touches:
  - package.json
  - desktop/scripts/lib/prune.mjs
  - desktop/scripts/lib/prune-check.mjs
  - desktop/scripts/lib/stage.mjs
---

## Decided
- The staged backend's production node_modules drops type declarations, source maps, TypeScript sources shipped beside compiled JS, and Markdown. On the Windows runner the installer went from about 56,800 files to 34,572 and the silent install from 5 min 15 s to 2 min 35 s; the reinstall fell the same way.
- A check after the prune walks every package's runtime entry points (main, bin, exports) and fails staging if one was removed, so the desktop build still loads exactly what the image loads.
- Licence, notice and package.json files are never pruned, and no directory is deleted by name (some packages keep runtime code under `test` or `docs`).

## Tried and ruled out
- Ignoring only the `types` condition in `exports`: zod and @standard-schema/spec point source conditions of their own at `.ts` files, which Node never takes, and the check blocked staging. It now follows only Node's default conditions.

## Watch out
- An install still looks stalled with an empty install folder: electron-builder's NSIS template extracts everything into the installer's temp folder (`%LOCALAPPDATA%\Temp\ns*.tmp\7z-out`) and copies it at the end, so each file is written and scanned twice. Overriding that extract step is the next lever, not yet tried.
- Two declarations-only packages (@types/luxon, @tokenizer/token) sit in the backend's runtime dependencies and ship in the image for nothing.

In the code:
- desktop/scripts/lib/prune.mjs, desktop/scripts/lib/prune-check.mjs, desktop/scripts/lib/stage.mjs
- the staging summary prints `backend/node_modules files: <before> before prune, <after> after` and `staged files: <n>`
- desktop/node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh (`extractUsing7za`)
