---
title: "The demo reset must release shared-expense settlement accounts before deleting accounts, and clears one schema-guarded table list"
author: Ken
date: 2026-11-12
branch: main
id: l-2099fda8
scope: repo
status: active
src: agent
touches:
  - backend/src/database/demo-reset.service.spec.ts
  - backend/src/database/demo-reset.service.ts
  - backend/src/database/demo-seed-data/preferences.ts
  - backend/src/database/demo-seed-data/scheduled.ts
  - backend/src/database/demo-seed-data/transactions.ts
  - backend/src/database/demo-seed.service.spec.ts
  - backend/src/database/demo-seed.service.ts
---

## Decided
- The daily demo reset and the first-run demo seed share one clear list, checked against the schema by a test, so a new user-owned table cannot leave visitor rows behind.
- Before deleting accounts, the clear reuses the shared-expense erasure helper to detach the bridge.

## Tried and ruled out
- Deleting visitor-created currencies: their exchange rates are shared data and the schema's in-use check counts them, so a clean delete is not safe.

## Watch out
- A database trigger refuses to delete a bridge-managed settlement account unless the shared-group setting is set, even in system context. A plain delete would roll the whole reset back and leave the demo unseeded.
- Deleting transactions needs the bridge's ledger links removed first (they restrict it).

In the code:
- backend/src/database/demo-clear.ts (DEMO_CLEAR_TABLES, DEMO_CLEAR_EXCLUDED), demo-clear.spec.ts
- backend/src/shared-expenses/shared-erasure.ts (detachSharedLedgerForErasure)
