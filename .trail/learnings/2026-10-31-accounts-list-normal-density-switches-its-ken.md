---
title: "Accounts list: Normal density switches its action buttons to icons on narrow tables, and the column tiers are browser-measured"
author: Ken
date: 2026-10-31
branch: fix/accounts-normal-balance-visibility
id: l-06f7c849
scope: repo
status: active
replaces: l-62c9da
src: agent
touches:
  - frontend/src/components/accounts/AccountList.test.tsx
  - frontend/src/components/accounts/AccountList.tsx
  - frontend/src/components/accounts/AccountRow.test.tsx
  - frontend/src/components/accounts/AccountRow.tsx
  - frontend/src/components/accounts/account-list-columns.ts
---

## Decided
- Balance outranks every column to its left. Type, Status and the two reconciliation columns drop out through container queries on the table's scroll wrapper, and the Account Name column yields width. The tiers are the same at every density, following the register's rule that density never changes which columns exist.
- Normal density's five text action buttons (Details, Edit, Reconcile, Close, Delete) take about 300px, or about 400px in German. Below a 1400px-wide table they render as Compact's icon buttons. Ken chose this over density-aware tiers, an overflow menu, or raising the tiers for every density.
- The width switch is JavaScript (a ResizeObserver on the wrapper), not CSS, because it changes which buttons render. Rendering both sets and hiding one with CSS would put every action in the DOM twice, and jsdom tests, which don't apply CSS, would match two buttons.
- The name cell starts yielding at 480px, where Actions appear, not at sm. Between 480 and 640px, Compact and Dense overflowed by up to 82px.

## Tried and ruled out
- Estimating the tier widths from padding and label lengths, as the first fix did: Normal still overflowed by 140px in English and 250px in German at the tier boundaries. Even with every optional column hidden, Name + Balance + text Actions needs 640px (en) to 740px (de), so retuning the tiers alone can't fix Normal.

## Watch out
- Re-measure before changing the tiers. Minimum table widths with Normal icon actions, worst locale of en/de/fr/es: Type 676, Status 776, reconciliation pair 1176. Text labels need 1376 (de).
- How to measure: fetch the compiled CSS from the dev server (localhost:3001, root-of-the-server CSS chunk; it includes every class from the source), rebuild the table markup with the real class strings, and load it with page.setContent after visiting localhost:3001/login so the fonts load from that origin. Run it in the mcr.microsoft.com/playwright:v1.64.1-noble container with --network host and playwright-core from e2e/node_modules. The host's Playwright Chromium won't start on NixOS (missing libglib).

In the code: frontend/src/components/accounts/account-list-columns.ts (ACCOUNT_COLUMN_TIER at 700/800/1200, ACCOUNT_ACTION_LABELS_MIN_WIDTH = 1400, accountActionDensity), AccountList.tsx (tableWrapper ResizeObserver), AccountRow.tsx (actionDensity prop).
