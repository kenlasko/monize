---
title: "Issue #2074: CSV unreadable amounts reported as skipped rows"
author: Node
date: 2026-11-10
branch: claude/issue-2074
cost: { minutes: 25, tokens: 149296 }
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
- `parseCsvAmount` moved to `backend/src/import/csv-amount.util.ts` and reads the whole field or returns null (trailing minus, Unicode minus, DR/CR, currency symbol/code of <=3 letters either side, apostrophe grouping).
- Blank and dash-only fields (`isBlankCsvAmount`) still read as 0: a debit/credit pair leaves one side blank on every row, and "treats empty amount as zero" is an existing test.
- An unreadable non-blank amount leaves the row out as `unreadableAmountRows`, checked after the date check in both modes; preview `unreadableAmounts`, skip reason `unreadableAmount` with `rawAmount`, amount 0.
## Tried and ruled out
- Generalising `UnreadableDatesNotice`: its copy is date-format specific; a sibling `UnreadableAmountsNotice` was simpler.
## Watch out
- Investment-mode quantity/price/commission also go through the stricter parser, so "10 shares" now rejects as missingQuantity (reported) instead of reading 10.
- Frontend `test:changed` runs far past 25 min once en/import.json changes; run `npm run test -- src/i18n <component paths>` instead.
