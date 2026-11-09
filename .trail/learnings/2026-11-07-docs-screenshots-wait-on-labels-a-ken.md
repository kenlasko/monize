---
title: "Docs screenshots wait on labels a widget always draws, never on seeded rows whose dates move with the seed"
author: Ken
date: 2026-11-07
branch: feat/visual-quick-wins
id: l-2def750e
scope: repo
status: active
src: agent
touches:
  - e2e/docs-screenshots/dashboard.spec.ts
  - scripts/e2e-playwright.sh
---

## Decided
A docs screenshot's "page is ready" marker is a fixed label the widget always draws (a link or heading such as "All upcoming" or "View portfolio"), not a demo row. The demo seed places its data relative to the day it runs, so a bill or security that is on screen after one seed can be missing after the next.

## Tried and ruled out
Waiting on a named demo row ("Gym Membership" in Upcoming Bills, "VOO" in Top Movers): the wait fails whenever the seed's dates move that row out of the widget.

## Watch out
A single report shot that times out on `getByRole("main")` while every other shot passes is usually the dev server compiling a cold route, not a broken page. Rerun that one shot before debugging it.

In the code: e2e/docs-screenshots/dashboard.spec.ts (the upcoming-bills and top-movers ready markers); rerun one shot with `scripts/e2e-playwright.sh npx playwright test --config playwright.docs.config.ts --project=light <spec> -g "<shot>"`.
