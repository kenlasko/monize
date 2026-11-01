---
title: "Bills toolbar layout: switch left, month centred, no count on phones (issue 1985)"
author: Node
date: 2026-11-01
branch: claude/issue-1985
cost: { minutes: 16, tokens: 82138 }
touches:
  - docs/images/readme/mobile-bills.png
  - website/docs/images/bills-calendar.light.png
  - website/docs/images/bills-calendar.png
  - frontend/src/app/bills/page.test.tsx
  - frontend/src/app/bills/page.tsx
  - frontend/src/components/ui/ListTopToolbar.test.tsx
  - frontend/src/components/ui/ListTopToolbar.tsx
  - website/docs/bills-and-deposits.html
  - website/docs/bills-and-deposits.md
  - website/docs/search-index.json
---

## Decided
- Bills calendar toolbar is `sm:grid sm:grid-cols-[1fr_auto_1fr]`: the ViewModeToggle in column 1, the month nav (arrows, month, Today) in column 2, the empty third column balancing it so the month is truly centred. Below sm it is a wrapping flex row, switch first.
- ListTopToolbar's `summary` line is `hidden sm:block`, and its row is `sm:flex-wrap` only, so on a phone the switch sits left and Export + density sit flush right on one line. Bills is the only `summary` caller.

## Tried and ruled out
- Nothing; trail check flagged 7 lexical "conflicts" (paging props, column tiers, next-occurrence amount) that this layout change does not touch.

## Watch out
- Retaking docs pictures: the docs `-g bills-calendar|bills-list` run also matches dashboard-upcoming-bills-calendar, and the readme mobile run rewrites every mobile-*.png; revert the ones the change does not affect. readme/04-mobile has two flaky tests (mortgage, donut report) unrelated to bills.
- The worker's rootless Docker still fails port publishing; the `ports: !reset []` override + node TCP proxy inside the Playwright container on issue-N_e2e-network works.
