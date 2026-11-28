---
title: "Retaking docs screenshots in the sandbox: e2e stack and Playwright gotchas"
author: Node
date: 2026-11-28
branch: claude/issue-2482
cost: { minutes: 35, tokens: 92372 }
touches:
  - e2e/docs-screenshots/investments.spec.ts
  - website/docs/images/investment-duplicate-form.light.png
  - website/docs/images/investment-duplicate-form.png
  - website/docs/images/investment-quick-fill.light.png
  - website/docs/images/investment-quick-fill.png
  - website/docs/images/investment-transaction-form.light.png
  - website/docs/images/investment-transaction-form.png
  - website/docs/investments.html
  - website/docs/investments.md
  - frontend/src/components/investments/InvestmentTransactionForm.duplicate.test.tsx
---

## Decided
- Followed website/README.md "Screenshots": docker compose -f docker-compose.e2e.yml plus an override (DEMO_MODE false, DISABLE_HTTPS_HEADERS true), `npm run docs:admin`, the demo seed via `exec backend node dist/database/seed.js`, then `docs:screenshots -- -g "<names>|seed"`. Limiting with -g still runs the seed project as a dependency; it is idempotent.
- Ran Playwright in `mcr.microsoft.com/playwright:v<installed @playwright/test version>-noble` with `--network host --ipc=host -v $PWD:/work -w /work/e2e -e HOME=/tmp`.
- Recompressed PNGs with `ghcr.io/shssoichiro/oxipng -o 3 --strip safe` (about 20% smaller), then `npm run docs:build` and `docs:check` in frontend/.

## Tried and ruled out
- Host Chromium: the cached build is one revision behind and lacks libglib, so PLAYWRIGHT_CHROMIUM_EXECUTABLE does not help here.

## Watch out
- The backend container runs `nest build` at start and OOMs at the default heap: add NODE_OPTIONS=--max-old-space-size=3072 to backend in the override.
- The e2e frontend is an image built from the source, not a bind mount: after a frontend change, `up -d --build --wait frontend` before retaking, or the picture shows old code.
- The first visit to a route on the fresh dev server can pass the 90s `go()` wait; retake that one picture alone.
- While the stack publishes the backend on localhost:3000, unit tests that render forms make real API calls (jsdom resolves relative URLs there), get 401 and logout() clears the preferences store mid-test. Run unit tests with the stack down.
