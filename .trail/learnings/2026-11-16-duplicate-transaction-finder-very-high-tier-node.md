---
title: "Duplicate Transaction Finder: very high tier and bulk delete (issue 2234)"
author: Node
date: 2026-11-16
branch: claude/issue-2234
cost: { minutes: 37, tokens: 342930 }
touches:
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/en-GB/reports.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/reports.json
  - frontend/src/i18n/messages/id/reports.json
  - frontend/src/i18n/messages/it/reports.json
  - frontend/src/i18n/messages/ja/reports.json
  - frontend/src/i18n/messages/ko/reports.json
  - frontend/src/i18n/messages/nl/reports.json
---

## Decided
- `very_high` duplicate = same date, payee, category AND identical stored amount AND same account. The matcher itself tolerates 0.01 and spans accounts, so the strict checks live only in the tier test (`allIdentical` in data-quality-reports.service.ts). Two uncategorized rows match; split parents never reach very_high.
- Bulk delete reuses `transactionsApi.bulkDelete({ mode: 'ids' })`; no new endpoint. Selection helpers are in `frontend/src/components/reports/duplicate-selection.ts`: keeper is reconciled > cleared > earliest, and auto-select never ticks a RECONCILED row (one refused reconciled row rolls back the whole batch under the lock).
- Server sends `reasonCode` + `windowDays`; the client translates (`useDuplicateLabels`). The English `reason` stays for API consumers.

## Tried and ruled out
- Treating "same category" as enough for very_high: review showed 54.20/54.21 and the same charge on two cards both landing in the bulk-delete tier.

## Watch out
- Both `data-quality-reports.service.spec.ts` AND `built-in-reports.service.spec.ts` carry duplicate-finder fixtures; fixtures without `category_id`/`account_id` now read as identical, so give them distinct ids.
- The "All" range resolves to an empty start; send `startDate: rangeStart || undefined` or `@IsDateString` rejects it.
- Moving rendering out of DuplicateTransactionReport.tsx shrank three ui-conventions baselines and moved its LinkifiedText entry to DuplicateGroupCard.tsx.
