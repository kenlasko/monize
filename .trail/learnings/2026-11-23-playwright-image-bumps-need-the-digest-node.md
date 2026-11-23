---
title: "Playwright image bumps need the digest, and @electron/asar 4 hides bin/asar.js"
author: Node
date: 2026-11-23
branch: claude/issue-2346
cost: { minutes: 5, tokens: 76229 }
touches:
  - desktop/scripts/lib/pack-deps.mjs
  - desktop/scripts/pack-deps.test.mjs
  - docs/container-images.md
  - scripts/e2e-playwright.sh
  - package.json
  - e2e/package-lock.json
---

## Decided
- scripts/e2e-playwright.sh pins the image as tag@digest, and Docker resolves the digest. Moving only the tag keeps the old browsers: E2E then fails with "Executable doesn't exist at /ms-playwright/chromium-<rev>". Read the index and per-platform digests with `docker buildx imagetools inspect mcr.microsoft.com/playwright:vX.Y.Z-noble`, and update the script and both tables in docs/container-images.md together. The image must be over a week old (check `--format '{{json .Image}}'` created).
- desktop/scripts/lib/pack-deps.mjs finds the asar CLI through `asarCli()`: resolve the package entry, walk up to its package.json, join `bin`. @electron/asar 4.x has `exports: "./lib/asar.js"` and ships bin/asar.mjs, so any hard-coded subpath (including `@electron/asar/package.json`) throws ERR_PACKAGE_PATH_NOT_EXPORTED.

## Tried and ruled out
- Trusting the script's own version check: it compares the tag text with e2e/package-lock.json, so a stale digest under a correct tag passes it.

## Watch out
- With rootless Docker on the worker, scripts/e2e-playwright.sh cannot write e2e/test-results-push. Pre-create that directory as mode 777 to run `npm run test:push` locally, then remove it.
