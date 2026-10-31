---
title: Capturing a docs picture for the first time means rebuilding the generated docs pages
author: Ken
date: 2026-10-31
branch: docs/shared-expenses-screenshots
id: l-b7c24735
scope: repo
status: active
src: agent
touches:
  - frontend/scripts/build-website-docs.mjs
  - docker-compose.e2e.yml
  - e2e/docs-screenshots/capture.ts
  - website/docs/shared-expenses.html
---

## Decided
- After a capture run that adds a picture which did not exist before (or its first light variant), run docs:build and commit the regenerated page with the PNGs. frontend/scripts/build-website-docs.mjs emits the light/dark pair only when the .light.png exists, so docs:check fails with "out of date with its Markdown" even though no Markdown changed.
- Retaking an existing picture whose light variant already existed changes no HTML.

## Watch out
- The e2e stack (docker-compose.e2e.yml) builds the working tree once; after rebasing onto a feature that changes a pictured screen, rebuild it (`up -d --build --wait`) before retaking, or the picture shows the old screen. The database volume survives the rebuild, so the demo seed does not need re-running.

In the code: frontend/scripts/build-website-docs.mjs, e2e/docs-screenshots/capture.ts, website/docs/shared-expenses.html; `npm run docs:build` then `npm run docs:check` in frontend/.
