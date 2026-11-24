---
title: "Provisional transfer amounts get a real column, stay in totals flagged as estimates, and an import with no rate is refused (Discussion 2383)"
author: Ken
date: 2026-11-24
branch: main
cost: { minutes: 8, tokens: 89687 }
id: l-3c96d27d
scope: repo
status: active
src: agent
touches:
  - backend/src/import/pending-import.ts
  - backend/src/import/import-regular-processor.service.ts
  - backend/src/common/fx-entry.util.ts
  - backend/src/reports/transfer-counterpart.ts
  - backend/src/built-in-reports/transfer-rate-sql.ts
---

## Decided
- A provisional transaction amount is recorded in a structured column on the transaction, not by the words PENDING IMPORT in the description. A migration backfills the column from the existing marker text and strips the warning note from descriptions; the importer stops writing it and the UI shows a badge instead.
- Provisional amounts stay in balances, net worth and report totals. A plain cross-currency QIF transfer's other leg is estimated at the historical rate (as split transfers already are since PR 1828) instead of the file's figure at par, so the two sides net to zero. Any figure containing a provisional amount is marked "includes estimated amounts".
- When no rate can be had for a plain cross-currency transfer, the row is refused and the import result names the pair and date, exactly as the split path does. No "unknown" amount is ever stored, so the column has two states only.
- A provisional amount is confirmed by a later import of the other account, by an explicit "Confirm amount" action, or by saving an edit that changes the amount. Only the importer creates provisional amounts.
## Tried and ruled out
- Keeping the marker text as a cosmetic hint: the description is user-editable, which is the defect the discussion reports.
- A third "unknown" state that does not move the balance: needs unknown-aware balance logic everywhere for a case that only arises when the provider has nothing.
- Excluding provisional legs from report totals, or a separate "estimated" subtotal on every report: changes every report's layout and API shape.
- Keeping the par placeholder (100 USD -> 100 EUR) when no rate exists: a number known to be wrong that shows a fake gain.
- Letting users mark any transaction provisional (discussions 253, 1797): out of scope.
## Watch out
- The importer's rate lookup already fetches a provider window around the date when nothing is stored, so "no rate" only means the provider has nothing (unsupported currency, provider down, offline install).

In the code: backend/src/import/pending-import.ts (marker), backend/src/import/import-regular-processor.service.ts (splitTransferLeg refuses with errors.import.noRateForSplitTransfer; the plain path stores -qifTx.amount at par), backend/src/common/fx-entry.util.ts resolveFxRateOrNull -> ExchangeRateService.getRateForDate (fetchMissing defaults true), readers backend/src/reports/transfer-counterpart.ts and backend/src/built-in-reports/transfer-rate-sql.ts.
