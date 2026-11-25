---
title: "Report transfer readers read amount_is_provisional, not the PENDING IMPORT text (issue 2391, B3)"
author: Node
date: 2026-11-25
branch: claude/issue-2391
cost: { minutes: 12, tokens: 92245 }
touches:
  - backend/src/built-in-reports/transfer-rate-sql.spec.ts
  - backend/src/built-in-reports/transfer-rate-sql.ts
  - backend/src/import/pending-import.ts
  - backend/src/reports/reports.service.spec.ts
  - backend/src/reports/reports.service.ts
  - backend/src/reports/transfer-counterpart.spec.ts
  - backend/src/reports/transfer-counterpart.ts
  - backend/test/integration/report-custom-transfer-fx.integration.spec.ts
  - backend/test/integration/report-transfer-fx-surfaces.integration.spec.ts
  - docs/system-invariants.md
---

## Decided
- `transferCounterpartOf` checks `amountIsProvisional` on the mirror leg and on a split line's counterpart; `transferRateSql`'s `notProvisional(alias)` is `alias.amount_is_provisional IS NOT TRUE`, still its own AND clause (`AND (fx_leg.is_split IS TRUE OR ...)` on the whole-leg form, bare `AND` on the split-line form).
- The custom report fetch selects `splitLinkedTransaction.amountIsProvisional` instead of `.description` (the main `linkedTransaction` is leftJoinAndSelect, so it already hydrates the column). `reports.service.spec.ts` asserts that exact addSelect list.
- `isPendingImportAmount` and `PENDING_IMPORT_LIKE` lost their last callers and were deleted; `pending-import.ts` keeps only the marker and the note the importer still writes until B4.
## Tried and ruled out
- Nothing; the task list's instructions held.
## Watch out
- The worktree had no `backend/node_modules`; `npm ci` first. Integration specs run against `docker run mirror.gcr.io/library/postgres:18-alpine` with `DATABASE_PORT` set and `npm run pretest:integration` to create `monize_test`.
- `trail check` reports ~13 keyword-overlap conflicts (provisional legs in totals, split transfer accounts); none apply.
