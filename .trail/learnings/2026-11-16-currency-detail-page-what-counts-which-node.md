---
title: "Currency detail page: what counts, which rates are 'transaction' rates, and how it was verified"
author: Node
date: 2026-11-16
branch: claude/issue-2243
cost: { minutes: 64, tokens: 643378 }
touches:
  - frontend/src/components/currencies/CurrencyList.test.tsx
  - frontend/src/components/currencies/CurrencyList.tsx
  - frontend/src/i18n/messages/de/currencyDetail.json
  - frontend/src/i18n/messages/es/currencyDetail.json
  - frontend/src/i18n/messages/fr/currencyDetail.json
  - frontend/src/i18n/messages/hi/currencyDetail.json
  - frontend/src/i18n/messages/id/currencyDetail.json
  - frontend/src/i18n/messages/it/currencyDetail.json
  - frontend/src/i18n/messages/ja/currencyDetail.json
  - frontend/src/i18n/messages/ko/currencyDetail.json
---

## Decided
- `/currencies/[code]` (issue #2243). Usage = the reader's own non-VOID top-level `transactions` posted in the currency OR paid in it (`original_currency_code`); investment_transactions are not read. Totals are gross (sum of ABS), in the currency and in the reporting currency through `rateBasisColumnsSql` + `convertRateBasis` (INV-FX-002), `null` total + `knownReportingSubtotal` + `missingPairs` when a rate is missing.
- "Transaction" rates are derived, never stored: a foreign entry's `exchange_rate` (direct when posted in the reporting currency, reciprocal of `ownRateSql`'s stored case when posted in the code) and a transfer's leg ratio (`transferRateSql`, reader's own legs only via `ownTransferLegs`). The reporting-currency leg of a transfer is skipped so a transfer is listed once.
- Both new routes are NOT `@AllowDelegate` (like the transaction summary routes); the currencies list therefore disables its row click for a delegate (`actingAsUserId`).
- Rate table and chart are client-side over the full provider list (`getStoredRates`, capped 2000) plus transaction rates; pager is `ListTopToolbar` + `ListBottomPager`, CSV via `exportToCsv`.
## Tried and ruled out
- A "View Transactions" header button: the register's `originalCurrencyCodes` filter matches paid-in currency only, so it would disagree with the count.
- Showing rates at a fixed six places: a coin's inverse (BTC per CAD) read 0.000007. `rateDisplayDecimals` keeps six significant digits below 1.
## Watch out
- The docs-screenshot demo data has no USD usage any more (USD is inactive), so the older currency captures that look for a USD row fail locally; the new capture uses BTC, the demo's one foreign currency with history and a transfer.
- A transfer leg's `payee_name` is "Transfer to ...": describe it by account, not payee.
- `trail check` flags ~20 lexical matches on this change (exchange-rate-history, group limit, report currency); none apply.
