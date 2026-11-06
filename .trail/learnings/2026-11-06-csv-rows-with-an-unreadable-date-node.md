---
title: "CSV rows with an unreadable date are skipped by name, not dropped"
author: Node
date: 2026-11-06
branch: claude/issue-2030
cost: { minutes: 19, tokens: 210114 }
touches:
  - frontend/src/i18n/messages/de/import.json
  - frontend/src/i18n/messages/es/import.json
  - frontend/src/i18n/messages/fr/import.json
  - frontend/src/i18n/messages/hi/import.json
  - frontend/src/i18n/messages/id/import.json
  - frontend/src/i18n/messages/it/import.json
  - frontend/src/i18n/messages/ja/import.json
  - frontend/src/i18n/messages/ko/import.json
  - frontend/src/i18n/messages/nl/import.json
  - frontend/src/i18n/messages/pl/import.json
---

## Decided
- `parseCsv` returns every row whose date is empty or does not parse as `unreadableDateRows` (line of the file, raw date, amount, payee); the preview gets `unreadableDates {count, rows<=50}`, the import records each via `recordSkippedRow` with reason `unreadableDate`, `date: ""`, plus `rowNumber`/`rawDate`.
- Row numbers come from `readCsvRecords` (the line a record starts on), not the array index: quoted newlines and skipped blank lines move them apart.
- `validateAndFormat` uses `isCalendarDate` so 30 February is an unreadable date, not a DB row error.
## Tried and ruled out
- Fixing the five-row date-format guess or adding month-name tokens (MMM): left out of scope; the review-step count is what tells the user the order is wrong.
## Watch out
- `SKIPPED_ROWS_LIMIT` is declared after the DTO classes in import.dto.ts; do not interpolate it into a decorator above its declaration (TDZ).
- Investment-mode CSV `rejectedRows` are still counted only in the preview, never in the import result's `skipped`.
