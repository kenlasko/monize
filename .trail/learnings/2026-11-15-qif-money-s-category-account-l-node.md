---
title: "QIF: Money's Category|[Account] L field is a transfer; X-action transfers are ignored by the investment processor"
author: Node
date: 2026-11-15
branch: claude/issue-2209
cost: { minutes: 9, tokens: 133930 }
touches:
  - backend/src/import/qif-parser.spec.ts
  - backend/src/import/qif-parser.ts
  - website/docs/importing-from-microsoft-money.md
---

## Decided
- Issue #2209: `parseCategoryOrTransfer` (backend/src/import/qif-parser.ts) reads `<category>|[<account>]` (Microsoft Money investment activities: DivX, MiscInc, MiscExp, SellX) as a transfer to the bracketed account, the same as `[<account>]`. The category half is dropped, since investment rows carry no category. Tags on either side are kept. A pipe not followed by `[...]` is unchanged.
- Both `parseQif` and `parseQifFull` go through this one function, so the fix covers single and multi-account files.

## Tried and ruled out
- Sending an X action's cash leg (BuyX/SellX/DivX) to the transfer account in `ImportInvestmentProcessorService`: the investment processor ignores `transferAccount` for anything except XIn/XOut/Cash/WithdrwX/ContribX. That is deliberate, because the other account's own QIF export carries the matching `L[Investment]` row, and the regular processor writes that transfer. Routing the cash here as well would count it twice.

## Watch out
- An investment import skips the wizard's Map Accounts step, but `buildAccountMappings` still sends `createNew` for a transfer account that matches nothing, so the backend can create that account silently.
- MiscExp maps to INTEREST, so it adds cash instead of removing it. This was found here and left unfixed.
- `test:changed` fails `loan-payment-frequency.guard.spec.ts` under this machine's TZ (America/Toronto). It passes with TZ=UTC, which is what CI uses.
