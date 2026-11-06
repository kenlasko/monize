---
title: CSV date format detected from every row; month names; investment rejects skipped
author: Node
date: 2026-11-06
branch: claude/issue-2040
cost: { minutes: 32, tokens: 264835 }
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
- Date-format detection moved to the server: `parseCsvHeaders` returns `columnDateFormats` (per column, `detectCsvDateFormat` over every row through the same `parseCsvDate` the import uses; most rows read wins, ties to MM/DD/YYYY then `DETECTABLE_DATE_FORMATS` order). The client detector and its tests were deleted; the mapping step preselects `columnDateFormats[date]` on first render only.
- Month names (`MMM`/`MMMM` tokens, built-ins `DD-MMM-YYYY`, `MMM DD, YYYY`) come from Intl for every `SUPPORTED_LOCALE_CODES` locale, long/short x standalone/in-date, plus 3+ letter prefixes, Latin diacritics folded; any key two months share is dropped (French "jui"), so ambiguity is an unreadable date.
- Investment-mode rejects are `rejectedInvestmentRows` and go through `recordSkippedRow` with the reject reason itself as the `ImportSkipReason` (five new reasons), so the result's `skipped` matches the preview.
- The CSV mapping DTO's `dateFormat` regex now allows space and comma; the QIF/OFX ones were left alone.
## Tried and ruled out
- Scanning every column in full: `isCalendarDate` (a Date round trip) dominated; `validateAndFormat` now range-checks first and only calls it for days 29-31, and a column with no date in its first 50 digit-bearing values stops early. 10 MB file is about 1.6 s.
## Watch out
- `stripTime` used to cut at the first `T`, which truncated "15-OCT-2026"; it now needs a digit on both sides.
- `loan-payment-frequency.guard.spec.ts` fails outside UTC on the worker; run backend gates with `TZ=UTC`.
