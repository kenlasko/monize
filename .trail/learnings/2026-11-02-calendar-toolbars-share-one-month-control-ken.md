---
title: Calendar toolbars share one month control; the legend gets its own line below the layers
author: Ken
date: 2026-11-02
branch: feat/toolbar-switch-left
id: l-d0ef2a12
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/calendar/CalendarMonthNav.tsx
  - docker-compose.e2e.yml
---

## Decided
- Every month calendar takes its month navigation from one shared control (arrows, a month button that opens the typeable picker, Today), because a hand-rolled copy is how Bills ended up with "November 2026" and no way to type a month. The label follows the reader's date-format preference.
- The view switch leads every list and calendar toolbar, with the "Showing" count immediately to its right. The calendar toolbar is three columns (switch | month | layers), and the account-type legend spans a line of its own below, right-aligned. Beside the layers it does not fit at 1600px: it wrapped above the buttons and was clipped under the sticky header in the docs picture.
- A calendar's toolbar and grid sit on the page, not in a white card, so the weekday row has no fill.

## Tried and ruled out
- Keeping the legend in the right-hand column with the layer buttons: it wraps to two lines and pushes above the centred month.

## Watch out
- Bills page tests read the month label through the mocked preferences store. Without a dateFormat there it falls back to the browser format, and every month assertion misses. The mock sets YYYY-MM-DD.
- Taking docs pictures while the dev stack runs: the e2e backend's 3000 publish collides with it. Override both services with `ports: !reset []` and run the Playwright image on the stack's network with a node TCP proxy from localhost:3001 to frontend:3000. Playwright `-g` matches the full title path, so `^name$` anchors find nothing; name the spec files instead, which also keeps dashboard pictures out.
- next-body-streams.test.ts fails on clean main in the local verify container, so a failure there is not a regression from UI work.

In the code: frontend/src/components/calendar/CalendarMonthNav.tsx, CalendarToolbar.tsx (grid `sm:grid-cols-[1fr_auto_1fr]`, legend `sm:col-span-3`), components/ui/ListTopToolbar.tsx and Pagination.tsx (`infoBefore`), app/bills/page.tsx; e2e: `docker compose -p monize-docs -f docker-compose.e2e.yml -f <override> up -d --build --wait`, then mcr.microsoft.com/playwright:v1.64.1-noble on monize-docs_e2e-network with BASE_URL=http://localhost:3001.
