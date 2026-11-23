---
title: "Playwright image pin: a tag bump needs its own digest"
author: Node
date: 2026-11-23
branch: claude/issue-2339
cost: { minutes: 5, tokens: 96592 }
touches:
  - docs/container-images.md
  - scripts/e2e-playwright.sh
  - desktop/scripts/lib/pack-deps.mjs
  - e2e/package-lock.json
---

## Decided
- The fix for "Executable doesn't exist ... chromium-NNNN" in the E2E shards was the image digest. scripts/e2e-playwright.sh and docs/container-images.md had the tag changed to v1.65.1 with the v1.65.0 digests kept, and Docker pulls by digest, so CI ran the old browsers. Take all three digests (index, amd64, arm64) from `docker buildx imagetools inspect mcr.microsoft.com/playwright:v<ver>-noble`.

## Tried and ruled out
- The script's version check compares only the tag to e2e/package-lock.json, so it passed even though the digest was wrong.

## Watch out
- Under rootless Docker here, scripts/e2e-playwright.sh's `--user $(id -u)` gets EACCES writing e2e/test-results-push. To check locally, run the same image as the container's root user instead (`npm run test:push` needs no stack).
- @electron/asar 4 exports only its main entry and its CLI is bin/asar.mjs. desktop/scripts/lib/pack-deps.mjs now reads the CLI path from the package's bin field.
