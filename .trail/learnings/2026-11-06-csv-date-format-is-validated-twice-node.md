---
title: CSV date format is validated twice on the import request
author: Node
date: 2026-11-06
branch: claude/issue-2040
cost: { minutes: 3, tokens: 34889 }
touches:
  - backend/src/import/csv-month-names.ts
  - backend/src/import/csv-parser-dates.spec.ts
  - backend/src/import/dto/import.dto.spec.ts
  - backend/src/import/dto/import.dto.ts
  - backend/src/import/import.service.spec.ts
  - backend/src/import/import.service.ts
  - docs/backend/transactions-and-money.md
---

## Decided
- The wizard sends the CSV mapping's date format both as `columnMapping.dateFormat` and as the top-level `ImportCsvDto.dateFormat` (via `detectedDateFormat` -> `setDateFormat`), so widening one validator without the other makes the preview pass and the import 400. Both now allow space and comma; the QIF/OFX validators keep the narrow pattern.
- Rows the CSV parse left out (unreadable dates, rejected investment rows) are merged by `rowNumber` before `recordSkippedRow`, so the 50 named are the file's first.
## Watch out
- `ImportOfxDto` and `ImportCsvDto` carry a byte-identical "Date format override" block: a first-occurrence string replace edits the OFX one.
- Upper-case Turkish month names lower-case to a dotted i; `foldMonthToken` maps U+0131 to i on both sides.
- Write combining-mark character classes as `\u` escapes; a heredoc or Write can turn them into invisible literals.
## Tried and ruled out
- Making date detection opt-in for the bulk-import header comparison: left as is (the cost only shows on multi-megabyte files, and it would add a request flag).
