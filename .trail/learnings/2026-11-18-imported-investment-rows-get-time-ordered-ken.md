---
title: "Imported investment rows get time-ordered ids in the file's journal order, because rows from one import share a creation time"
author: Ken
date: 2026-11-18
branch: feat/kmymoney-import
cost: { minutes: 11, tokens: 35645 }
id: l-03ad8bf8
scope: repo
status: active
src: agent
touches:
  - backend/src/import/kmy/map/kmy-amounts.ts
  - backend/src/import/kmy/map/kmy-map-transactions.cross-currency.spec.ts
  - backend/src/import/kmy/map/kmy-map-transactions.ts
  - backend/test/integration/kmy-import-banking.integration.spec.ts
  - docs/kmymoney-data-model.md
  - docs/specs/kmymoney-import.md
  - backend/src/import/kmy/map/kmy-map-investments.ts
  - backend/src/import/mny/map/map-investments.ts
  - backend/src/import/mny/map/replay-order.spec.ts
  - backend/src/import/mny/map/replay-order.ts
---

## Decided
Both the Money and KMyMoney importers assign UUIDv7 ids in journal order before writing investment rows. Rows written in one import share created_at, and the holdings rebuild orders ties by id, so random ids replayed same-day rows in a random order. Money's key is date, then htrn (the row's own id); KMyMoney's is date, then transaction id. The mapper's pre-commit replay sorts by (date, id) too, so it agrees with the database rebuild by construction.

## Tried and ruled out
Relying on insertion order (the old comment on Money's replay sort claimed this): the reader returns Money TRN rows in physical storage order, and the committed fixtures have rows out of htrn order.

## Watch out
- Money never writes a stock split as a share movement, so the order-sensitive Money case is a same-day sell and buy of one security (average cost 15 vs 20 in the test), not split plus trade. Before the fix 3 to 6 of 10 holdings were wrong per run.
- That Money's own register sorts by htrn is inferred, not verified in Money.
- Same-day banking rows still tie-break on random ids; only display order within a day varies.

In the code: backend/src/import/mny/map/sortable-row-ids.ts, backend/src/import/mny/map/replay-order.ts, backend/test/integration/mny-import-order.integration.spec.ts.
