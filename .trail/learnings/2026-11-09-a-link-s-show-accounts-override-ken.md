---
title: "A link's Show Accounts override lives in the URL, never in the saved preference"
author: Ken
date: 2026-11-09
branch: feat/command-palette
id: l-6d5f8ca6
scope: repo
status: active
src: agent
touches:
  - backend/src/users/dto/update-preferences.dto.ts
  - backend/src/users/validators/is-view-defaults.validator.spec.ts
  - backend/src/users/validators/is-view-defaults.validator.ts
  - backend/src/users/view-defaults.contract.spec.ts
  - backend/src/users/view-defaults.ts
  - docs/frontend/ui-conventions.md
  - docs/images/readme/mobile-account-mortgage.png
  - docs/images/readme/mobile-bills.png
  - docs/images/readme/mobile-budget-wizard.png
  - docs/images/readme/mobile-budget.png
---

## Decided
A link's `accountStatus` applies to that visit only. It is kept out of localStorage and `updateUrl` writes it back into the rewritten URL, so a reload or Back still shows what the link did. Back to an entry without one restores the saved preference. The reader's own toggle saves and removes the param.

## Tried and ruled out
Persisting from an effect on the status: it overwrote the preference on every link. Dropping persistence but keeping the override in memory only: the URL rewrite loses it, then the prune effect empties the linked closed account on reload.

## Watch out
Page effects do not call `updateUrl` on a status change alone, which is why the setter strips the param itself.

In the code: frontend/src/hooks/useTransactionFilters.ts (accountStatusFromLink, linkedAccountStatus, setFilterAccountStatus)
