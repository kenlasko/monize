---
title: Custom report account-currency amount column (issue 2149)
author: Node
date: 2026-11-13
branch: claude/issue-2149
cost: { minutes: 18, tokens: 156288 }
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
- New TableColumn ACCOUNT_AMOUNT (both layers' enums). aggregateNoGrouping (metric NONE) sets accountAmount = lineAmount(row or split amount), the same sign rule as `value`, plus accountCurrency = tx.currencyCode (the account's currency). A row with no rate is still dropped before either is set.
- Sort by the column orders by currency first, then amount within one currency; the multiplier flips both.
- ReportChart renders it through withCurrencyCode(formatCurrency(amount, code), code, defaultCurrency), with new cells written as Th/Td from ui/Table.tsx. The footer cell is blank because the column mixes currencies. The CSV gets an extra "Account currency" column beside the raw number; the PDF prints the formatted figure.
## Tried and ruled out
- A total for the column: a sum across currencies breaks "convert before summing".
- Appending the currency code inside the CSV number cell: a spreadsheet can't sum that cell.
## Watch out
- ReportChart's other headers are hard-coded English. Only the new header goes through useTranslations('reports') (customReportLabels.tableColumn.ACCOUNT_AMOUNT).
- The frontend TableColumn has TAG but the backend enum doesn't, so the DTO's @IsEnum rejects a saved TAG column. This was not fixed here.
