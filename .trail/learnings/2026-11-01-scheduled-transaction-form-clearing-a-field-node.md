---
title: "Scheduled transaction form: clearing a field needs explicit null; schedules now store a reference number"
author: Node
date: 2026-11-01
branch: claude/issue-1979
cost: { minutes: 16, tokens: 120936 }
touches:
  - backend/src/backup/support-backup/support-backup-rules.ts
  - backend/src/scheduled-transactions/dto/create-scheduled-transaction.dto.ts
  - backend/src/scheduled-transactions/entities/scheduled-transaction.entity.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.spec.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.ts
  - database/migrations/20261101145143_scheduled_transactions_reference_number.sql
  - database/schema.sql
  - frontend/src/components/budgets/BudgetUpcomingBills.test.tsx
  - frontend/src/components/scheduled-transactions/PostTransactionDialog.test.tsx
  - frontend/src/components/scheduled-transactions/PostTransactionDialog.tsx
---

## Decided
- Issue #1979: `ScheduledTransactionForm` sends `description: data.description || null` and `referenceNumber: data.referenceNumber || null`. `optionalString` turns `''` into `undefined`, an omitted key on PATCH keeps the stored value, so a cleared field never stuck.
- `scheduled_transactions.reference_number VARCHAR(100)` (migration 20261101145143). Posting uses `postDto.referenceNumber` when the key is present (empty clears it), else the schedule's stored one; `PostTransactionDialog` prefills it and always sends the key. Investment posts do not carry it.
- Support backup classifies the column `drop` (free text).

## Watch out
- `ScheduledTransactionForm.test.tsx` mocks `zodResolver` to pass raw values through, so a test sees `''` where the real resolver yields `undefined`. Normalise with `|| null`, not `?? null`, or the test and the browser disagree.
- Rootless Docker here cannot publish ports (`-p` fails at RootlessKit, `--network host` is not the host's namespace); use embedded-postgres for a single integration spec.
