---
title: "QIF Money Category|[Account]: account listed only for cash-transfer actions (supersedes the first #2209 note)"
author: Node
date: 2026-11-15
branch: claude/issue-2209
cost: { minutes: 6, tokens: 71820 }
touches:
  - backend/src/import/import-investment-processor.service.spec.ts
  - backend/src/import/import-investment-processor.service.ts
  - backend/src/import/qif-cash-transfer-action.ts
  - backend/src/import/qif-parser.spec.ts
  - backend/src/import/qif-parser.ts
  - website/docs/importing-from-microsoft-money.md
---

## Decided
- This replaces the first #2209 note. `parseCategoryOrTransfer` no longer reads the pipe form. Instead, `parseMoneyActivityField` reads `<category>|[<account>]` in backend/src/import/qif-parser.ts, and only inside an investment section (`parseQif` checks `accountType`, `parseQifFull` checks `currentBlock.accountType`).
- The account is held in `currentMoneyAccount` and settled once the record is complete, because N can follow L. `settleMoneyActivityAccount` makes it the row's transfer and adds it to the transfer accounts only when `isQifCashTransfer(action, account)` holds. That predicate lives in backend/src/import/qif-cash-transfer-action.ts and the investment processor uses the same one. On any other action the account is dropped.
- A bank or split row keeps `Food|[Checking]` as a category.

## Tried and ruled out
- Reading the pipe form as a transfer on every row. Every name in `transferAccounts` gets a `createNew` mapping from `buildAccountMappings`. The wizard hides Map Accounts for an investment import, so this created chequing accounts the user never saw and no DivX, SellX or MiscInc row booked to.

## Watch out
- A fourth place that settles the record's end (EOF in `parseQif`, `^` in either parser, `finalizeBlock`) must call `settleMoneyActivityAccount` and reset `currentMoneyAccount`.
- The silent `createNew` for Quicken's own `BuyX L[Checking]` still exists. It is a separate proposal.
