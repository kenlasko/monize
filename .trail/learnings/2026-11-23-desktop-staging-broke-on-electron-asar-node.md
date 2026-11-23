---
title: "Desktop staging broke on @electron/asar 4.x: resolve the CLI from bin"
author: Node
date: 2026-11-23
branch: claude/issue-2344
cost: { minutes: 2, tokens: 20847 }
touches:
  - desktop/scripts/lib/pack-deps.mjs
  - desktop/scripts/stage.test.mjs
  - package.json
---

## Decided
- `desktop/scripts/lib/pack-deps.mjs` `asarCliPath()` (main, 8c67259f8) finds the @electron/asar package root by walking up from `require.resolve("@electron/asar")` and runs the file named in its package.json `bin`. 4.x is ESM, its `exports` only allows `./lib/asar.js` (no subpaths, not even package.json), and the CLI is now `bin/asar.mjs`.
- The CLI flags are unchanged in 4.x: `pack <root> <archive> --unpack "*.node"` still works, and stage.test.mjs packs a real archive.

## Tried and ruled out
- `require.resolve("@electron/asar/package.json")` fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
- The programmatic `createPackageWithOptions` is async, and packArchive is kept synchronous on purpose.

## Watch out
- The failure came from a dependabot bump on main, not from the PR it showed up on; main fixed it independently, so a branch that patched it too should take main's side on merge. Run `node --test scripts/*.test.mjs` in desktop/ after any asar bump.
