---
title: "Docs screenshots come from the e2e stack, which needs the demo seed run by hand and demo mode switched off"
author: Ken
date: 2026-10-30
branch: docs/website-user-guide
id: l-2ac62e82
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - e2e/CLAUDE.md
  - e2e/docs-screenshots/accounts-and-settings.spec.ts
  - e2e/docs-screenshots/budgets.spec.ts
  - e2e/docs-screenshots/capture.ts
  - e2e/docs-screenshots/dashboard.spec.ts
  - e2e/package.json
  - e2e/playwright.docs.config.ts
  - e2e/readme/seed-finance.ts
  - e2e/readme/session.ts
---

## Decided
- Documentation screenshots are Playwright tests in e2e/docs-screenshots, one per PNG, reusing the README capture's seed, session and settling shoot(). They run against the e2e compose stack because it builds the working tree, so pictures show the branch rather than the published :latest images.

## Tried and ruled out
- Starting the e2e stack with DEMO_MODE=true to get the demo user: its backend command skips the entrypoint's demo seed, so the demo user never exists ("Login failed: no matching account"). Run `node dist/database/seed.js` inside the backend once with DEMO_MODE=true instead.
- Leaving demo mode on for the captures: the sign-in button becomes "Try Demo" (loginUser looks for "Sign in") and every page carries a Demo Mode bar.

## Watch out
- Over plain HTTP the frontend shows an "HTTPS Required" banner; set DISABLE_HTTPS_HEADERS=true on the frontend.
- The e2e stack serves the Next.js development build, whose indicator lands in every picture; docShot hides nextjs-portal.
- e2e/ has no TypeScript compiler, so a type error in readme/ only shows when the capture runs: the seed read lookups.categories without loading it, and expected a "Loan Interest" category the demo data does not have.
- Shots needing an AI provider, an admin, configured email or a restore in progress cannot be taken from the demo data as it is.

In the code: e2e/playwright.docs.config.ts, e2e/docs-screenshots/capture.ts, e2e/readme/seed-finance.ts (seedLoans), website/README.md "Screenshots".
