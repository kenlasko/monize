---
title: "A help click before the guide index has loaded goes to the website, so help tests must wait for it"
author: Ken
date: 2026-11-06
branch: feat/help-panel
id: l-df03ad56
scope: repo
status: active
src: agent
touches:
  - frontend/src/lib/help-open.ts
  - e2e/tests/help-panel.spec.ts
  - frontend/src/app/dashboard/page.test.tsx
---

## Decided
- A plain click on a help icon opens the panel only when the prefetched guide index says help is available; until that request lands, the click falls through to the website link. This is the price of deciding synchronously (an await before opening a window lets a popup blocker swallow it), and it was accepted: a click within a fraction of a second of page load opens monize.net.
- The prefetch starts from a resolved promise and swallows its own failure, so a page whose test mocks the API cache without `dedupe` cannot throw from render.

## Tried and ruled out
- Clicking help in an E2E spec straight after navigation: it raced the prefetch, opened monize.net and the panel never appeared. Wait for the guide index response first.

## Watch out
- Any new E2E or component test that clicks a help icon must wait for (or seed) the guide index first; otherwise it exercises the website fallback, not the panel.
- A page test that mocks the API cache module must still provide `dedupe`, or mock the help prefetch.

In the code:
- frontend/src/lib/help-open.ts: prefetchHelp, useHelpPrefetch, onHelpLinkClick; helpStore.guideAvailable (null until known)
- e2e/tests/help-panel.spec.ts: gotoWithGuideKnown waits for the /help response before clicking
- frontend/src/app/dashboard/page.test.tsx mocks @/lib/apiCache (the case that threw)
