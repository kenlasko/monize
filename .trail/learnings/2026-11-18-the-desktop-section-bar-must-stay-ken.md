---
title: The desktop section bar must stay off pages that already stick a bar under the header
author: Ken
date: 2026-11-18
branch: feat/transactions-account-info-bar
cost: { minutes: 11, tokens: 46390 }
id: l-54c35b85
scope: repo
status: active
src: agent
touches:
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/app/reconcile/page.tsx
  - frontend/src/app/settings/page.tsx
  - scripts/lib/npm-audit-gate.mjs
---

## Decided
- A page with its own sticky bar at the header's bottom edge turns the generic section bar off: the dashboard while editing (`floatingBar={!editing}`), Reconcile and Settings always. The section bar is fixed at the same top and sits above them (z-30 over z-20). On the dashboard it covered the edit bar's Cancel, and the "Arranging the dashboard" tour's E2E test failed every attempt in both browsers: the spotlight hole was over the edit bar, but the click landed on the tour mask.

## Watch out
- A new page with its own `sticky top-[calc(4rem+...-var(--app-header-offset,0px))]` bar needs `floatingBar={false}` on its PageHeader. `grep -rn "sticky top-\[calc(" frontend/src` finds them.
- "disables 2FA from settings" flaked in CI and failed once locally in Firefox with retries off, in two different ways (dialog not opening; Enable 2FA not returning). It was not caused by the bar, which is off on Settings.

In the code: frontend/src/app/dashboard/page.tsx, frontend/src/app/reconcile/page.tsx, frontend/src/app/settings/page.tsx (floatingBar).
