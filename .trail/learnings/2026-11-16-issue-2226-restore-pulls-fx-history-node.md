---
title: "Issue #2226: restore pulls FX history like an import"
author: Node
date: 2026-11-16
branch: claude/issue-2226
cost: { minutes: 18, tokens: 172562 }
touches:
  - backend/src/backup/backup-restore.service.ts
  - backend/src/backup/backup.module.ts
  - backend/src/backup/backup.service.spec.ts
  - backend/src/currencies/currencies.module.ts
  - backend/src/currencies/exchange-rate-history.service.ts
  - backend/src/currencies/rate-history-catch-up.service.ts
  - backend/src/import/import-post-processing.service.spec.ts
  - backend/src/import/import-post-processing.service.ts
  - backend/src/import/import.service.spec.ts
  - backend/test/helpers/integration-setup.ts
---

## Decided
- The post-import gap-fill loop moved to RateHistoryCatchUpService (backend/src/currencies/rate-history-catch-up.service.ts) with its pending set and settlePendingRateHistoryFills; ImportPostProcessingService and BackupRestoreService both call start(userId, accountIds, label, onStored). The restore starts it in its post-commit `.then`, with the restored (remapped) account ids from backupTables(data).accounts; onStored invalidates the portfolio memo and recalculateAccount per restored account (BackupModule imports NetWorthModule).
- exchange_rates is never in a backup (export-table-queries.ts excludes it), so this fill is the only thing giving restored rows their history.
## Tried and ruled out
- @Optional() deps on BackupRestoreService to spare the test modules: hides a missing module import in production. Required deps, and a stub in every TestingModule that builds the restore (backup.service.spec, backup-restore-staging, support-backup, warranty-attachments, calendar-day-notes integration specs).
## Watch out
- backup-restore.integration "restores a scanned attachment" fails on the docker postgres:16 image (en_US.utf8 collation orders receipt.jpg before receipt-scan.jpg); it is not a regression.
