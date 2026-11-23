---
title: "Reports: a PENDING IMPORT transfer counterpart is not a posted amount (#2338)"
author: Node
date: 2026-11-23
branch: claude/issue-2338
cost: { minutes: 14, tokens: 124196 }
touches:
  - backend/src/built-in-reports/transfer-rate-sql.spec.ts
  - backend/src/built-in-reports/transfer-rate-sql.ts
  - backend/src/import/import-regular-processor.service.ts
  - backend/src/import/pending-import.ts
  - backend/src/reports/reports.service.spec.ts
  - backend/src/reports/transfer-counterpart.spec.ts
  - backend/src/reports/transfer-counterpart.ts
  - backend/test/integration/report-custom-transfer-fx.integration.spec.ts
  - backend/test/integration/report-transfer-fx-surfaces.integration.spec.ts
  - docs/system-invariants.md
---

## Decided
- The QIF importer's placeholder leg is recognised only by its description containing PENDING_IMPORT_MARKER (backend/src/import/pending-import.ts); confirming it (importing the other file) replaces amount and description together, so the marker's absence is the confirmation signal. No column exists for it.
- Both readers of a transfer's posted amounts skip a marked counterpart: transferCounterpartOf (custom reports) and transferRateSql (every SQL surface). The leg then takes the market rate, or is reported missing. A split parent's line is never a placeholder; a placeholder leg itself still converts at its confirmed other side.
## Tried and ruled out
- Folding the pending check into the existing `OR fx_leg.linked_transaction_id = t.id` clause: it breaks an existing substring assertion in transfer-rate-sql.spec.ts; a separate `AND (fx_leg.is_split IS TRUE OR <not pending>)` keeps it.
## Watch out
- Integration specs DO run on this worker: `docker run -d -p 55438:5432 -e POSTGRES_USER=monize_user -e POSTGRES_PASSWORD=monize_password mirror.gcr.io/library/postgres:18`, then DATABASE_PORT=55438 npm run pretest:integration and `npx jest --config ./test/jest-integration.json --runInBand <files>`.
- tsc needs NODE_OPTIONS=--max-old-space-size=4096 here; budget-alert.service.spec.ts fails under the machine's America/Toronto TZ and passes with TZ=UTC.
