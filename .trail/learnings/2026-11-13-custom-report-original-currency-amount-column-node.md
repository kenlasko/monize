---
title: Custom report original-currency amount column (issue 2162)
author: Node
date: 2026-11-13
branch: claude/issue-2162
cost: { minutes: 16, tokens: 122928 }
touches:
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/reports.json
  - frontend/src/i18n/messages/id/reports.json
  - frontend/src/i18n/messages/it/reports.json
  - frontend/src/i18n/messages/ja/reports.json
  - frontend/src/i18n/messages/ko/reports.json
  - frontend/src/i18n/messages/nl/reports.json
  - frontend/src/i18n/messages/pl/reports.json
---

## Decided
- New TableColumn ORIGINAL_AMOUNT (both layers), built the same way as ACCOUNT_AMOUNT (#2149). aggregateNoGrouping (metric NONE) sets originalAmount = lineAmount(tx.originalAmount) and originalCurrency = tx.originalCurrencyCode, but only on a non-split row whose foreign-entry fields are both set. It is stored with the amount's sign (foreign-entry.util refuses opposite signs), so lineAmount signs it the way `value` is signed.
- Ordinary rows and split lines get no field, and ReportChart shows '-'. Only the parent carries originalAmount, and prorating it over the lines would invent a figure nobody stored.
- Sorting goes by currency and then by amount. Rows without an original amount sort first ascending. The CSV gets an "Original currency" column beside the raw number, the PDF the formatted figure, and the footer cell is blank.
## Watch out
- ReportChart.test's useNumberFormat mock prints '$' for every currency, so a EUR cell reads '$100.00 EUR'. The reader's default currency there is CAD.
- trail check flags "total column" / "cell blank" against the #2149 learning on keywords alone. Those hits are false positives for this design.
