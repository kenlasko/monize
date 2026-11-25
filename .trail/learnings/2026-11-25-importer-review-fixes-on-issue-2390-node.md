---
title: "Importer review fixes on issue 2390: a provisional leg is not a recorded transfer, confirmation settles the rate, zero needs no rate"
author: Node
date: 2026-11-25
branch: claude/issue-2390
cost: { minutes: 6, tokens: 67624 }
touches:
  - docs/backend/transactions-and-money.md
  - docs/future-plans/provisional-amounts.md
  - backend/src/import/import-regular-processor.service.spec.ts
  - backend/src/import/import-regular-processor.service.ts
  - backend/src/import/import-transfer-dedupe.ts
  - backend/test/integration/import-qif-plain-transfer.integration.spec.ts
---

## Decided
- `import-transfer-dedupe.ts` excludes `amount_is_provisional` rows from all three recorded-transfer queries (the linked count, the split-linked count, the bank-id adoption lookup). The dedupe runs before `matchPendingTransfer`, so without this a file stating exactly the estimate was skipped as `duplicateTransfer` and the leg stayed provisional for good. With the historical-rate estimate that equality is common (pegged pairs, same-day rates); with the old par placeholder it needed a 1:1 rate.
- On confirmation `confirmedSettlementRates` writes the convention of `transfer-leg-columns.ts`: source leg 1, destination leg `roundFxRate(|to| / |from|)`. A split parent's side is read from the split line pointing at the leg and the parent's own rate is left alone; a zero on either side leaves the rates as stored.
- `transferLeg` short-circuits a zero cross-currency amount to a confirmed zero in the target currency with no rate lookup ("zero needs no rate"); such a leg could never be matched by the pending lookups, which require a sign.
- The design's writers table (`docs/future-plans/provisional-amounts.md`) now says the two orphan lookups keep the leg provisional; that departure still needs the maintainer's agreement.
## Tried and ruled out
- Running the pending match before the dedupe instead: it would change the order for every transfer row and the counted signatures; a predicate on the dedupe queries is the smaller change.
- A unit spec alone for the dedupe fix: the spec mocks the query builder, which is how the original case passed while the real path skipped the row. The proof is the integration case in `import-qif-plain-transfer.integration.spec.ts`.
## Watch out
- A regex or string replace over `.andWhere("t.amount = :amount"...)` in the dedupe file must anchor on the line start: the 8-space occurrence contains the 6-space one.
