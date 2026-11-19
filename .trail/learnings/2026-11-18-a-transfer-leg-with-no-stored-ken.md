---
title: "A transfer leg with no stored exchange rate stays empty everywhere, and a split's foreign transfer rate lives on the counterpart row"
author: Ken
date: 2026-11-18
branch: feat/kmymoney-import
cost: { minutes: 19, tokens: 48380 }
id: l-61eefa00
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
- A cross-currency transfer leg whose stored rate is missing is carried as null from the edit preview through the assistant's descriptor to the commit; it is never shown as 1. Change detection compares against the rate the row actually holds, so "null in, null held" is unchanged and an edit that leaves the rate alone moves neither leg.
- For a split transaction with a transfer leg in another currency, the transfer counterpart row carries the rate, in either direction; the parent split row and its legs stay at 1. That is what Monize's own split editor writes. A plain two-leg transfer is different: the destination leg carries the rate.

## Tried and ruled out
- Showing the rate implied by the two posted amounts when the stored rate is missing. The KMyMoney importer only stores no rate when one side of the transfer is zero, so the amounts imply nothing, and a repriced destination amount can round differently from the stored one.
- Putting the split's rate on the parent row: there it means a foreign-currency entry, not one leg's rate.

## Watch out
- An imported transfer that sends 0 and receives an amount, opened from the zero leg, still picks the wrong leg as the sender (orientation is by amount < 0) and can show rate 1. Not fixed.
- Supplying a rate on a no-rate transfer now reprices at that rate; an explicit 1 used to be ignored.

In the code: backend/src/transactions/transaction-transfer.service.ts (heldTransferRate, resolveTransferFxForUpdate), backend/src/ai/actions/edit-commit-args.ts, backend/src/common/fx-fallback.guard.spec.ts, backend/src/import/kmy/map/kmy-map-transactions.ts (counterpartRate), docs/specs/kmymoney-import.md 5.6.4.1.
