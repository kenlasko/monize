---
title: "Favourite Accounts and Upcoming Bills may be a third wide because Ken asked, not because they were checked at that width"
author: Ken
date: 2026-11-11
branch: feat/dashboard-edit-mode
cost: { minutes: 1, tokens: 9089 }
id: l-fdde59e2
scope: repo
status: active
src: agent
touches:
  - docs/future-plans/dashboard-edit-mode.md
  - frontend/src/components/dashboard/widget-registry.tsx
---

## Decided
- Ken asked (2026-11-11) that Favourite Accounts and Upcoming Bills & Deposits be offered at 1/3 width in dashboard edit mode, overriding the plan's judgement that tables need at least half. Their default width stays half, so nobody's dashboard changes until they choose it.

## Watch out
- Not checked in a browser at a third: that is about 293px at a 1024px viewport, and both are tables (account name and balance; payee, date and amount), so long names may wrap or truncate. If they read badly, fix the table at that width rather than raising the minimum back, since Ken chose it.

In the code:
- `minWidth: 'third'` on 'favourite-accounts' and 'upcoming-bills' in frontend/src/components/dashboard/widget-registry.tsx; the table in docs/future-plans/dashboard-edit-mode.md section 6.2.
