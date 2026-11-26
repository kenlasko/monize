---
title: "Imported investment cash leg: one plain row named by transaction_id (#2436)"
author: Node
date: 2026-11-26
branch: claude/issue-2436
cost: { minutes: 10, tokens: 128983 }
touches:
  - backend/src/import/import-investment-processor.service.spec.ts
  - backend/src/import/import-investment-processor.service.ts
  - docs/backend/transactions-and-money.md
---

## Decided
- `ImportInvestmentProcessorService.processCashTransaction` writes a trade's cash effect as one non-transfer row in the cash account (a brokerage's linked cash account, or the account itself), sets the investment row's `transaction_id` to it, and stores `converted.exchangeRate` on the investment row. That is the shape `InvestmentTransactionsService.create` and the Money writer (`write-investments.ts`) produce.
- Before this, a brokerage with a linked cash account got a transfer pair, and `transaction_id` pointed at the brokerage-side counterpart. `removeTransactionEffects` / `deleteCashTransactionInTransaction` tear down only the row `transaction_id` names, so an unchanged edit deleted the counterpart, orphaned the real cash row (linked_transaction_id ON DELETE SET NULL) and created a second one.

## Tried and ruled out
- Making the service's edit/delete path tolerate the old shape (also delete the linked row). The VOID crossing in `updateStatus` and the reports would still see the old shape, so it only fixes part of the problem. Repairing existing rows is a data migration, which is a separate proposal.

## Watch out
- Rows imported before the fix still have the old shape. Editing, deleting or voiding one still misbehaves.
- XIn/XOut/ContribX/WithdrwX go through `processCashTransfer` and are real transfer pairs. That path is unchanged.
