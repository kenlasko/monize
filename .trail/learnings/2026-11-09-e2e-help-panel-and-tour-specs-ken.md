---
title: "E2E help-panel and tour specs must wait for the current page's own response, not any matching one"
author: Ken
date: 2026-11-09
branch: feat/mobile-tab-bar
id: l-963bd27f
scope: repo
status: active
src: agent
touches:
  - e2e/tests/bills.spec.ts
  - e2e/tests/help-panel.spec.ts
  - e2e/tests/tours.spec.ts
  - frontend/src/app/bills/page.test.tsx
  - frontend/src/app/bills/page.tsx
  - frontend/src/components/command-palette/CommandPalette.test.tsx
  - frontend/src/components/command-palette/useCommandItems.tsx
  - frontend/src/hooks/useHighlightTarget.test.ts
  - frontend/src/hooks/useHighlightTarget.ts
  - frontend/src/components/tours/TourHost.tsx
---

## Decided
Specs that wait on a network response before acting must tie the wait to the navigation or click that causes it.

- The help-panel specs count `/help` manifest responses only after this document's main frame has committed. `waitForResponse` otherwise accepts the read from the previous page, the "?" gets clicked before the guide is known, and the anchor natively opens monize.net in a popup.
- The tour spec waits for the POST to `/updates/tours/progress` after Done. The next `goto` cancelled it (status -1), so the reload showed the tour as never completed.

## Tried and ruled out
These looked like Firefox-only flakes because they failed on one try and passed on retry, and they also recur on main. The traces show timing races that any slow navigation can trigger.

## Watch out
- `next dev` compiles a route once per stack, and a cold `/transactions` took 12.8s, past the 10s expect timeout in the tour's `advanceUntil`. A tour failure on a freshly started local stack may be only that.
- help-panel.spec.ts sets its own `launchOptions` with `test.use`, which replaces a project-level `executablePath`.
- With a system Chromium 155 instead of Playwright's bundled browser, `context.route` misses the popup's first document request, so the Ctrl-click help test fails locally on the committed spec too. It passes in CI.

In the code: e2e/tests/help-panel.spec.ts `gotoWithGuideKnown`, e2e/tests/tours.spec.ts, frontend/src/components/tours/TourHost.tsx.
