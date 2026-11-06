---
title: "A non-ISO currency shows its stored symbol everywhere money is shown, never its code; Intl alone prints the code and two decimals"
author: Ken
date: 2026-11-05
branch: claude/crypto-account-currency
id: l-abb9d1e1
scope: repo
status: active
src: agent
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
  - backend/src/i18n/locales/pl/errors.json
---

## Decided

Every surface that renders an amount or a currency prefix (figures, charts, input adornments, list rows) shows a non-ISO currency's stored symbol (₿ for BTC) at its stored decimal places. Intl knows nothing about such a code: it prints the code as the symbol and rounds to two places, so a 0.0070 BTC balance read "BTC 0.01" and the accounts list appended the code a second time ("BTC 0.0070 BTC"). Ken asked for the symbol explicitly after seeing the first screenshots. One lookup answers both questions: the client registry filled once per session from the currencies list, consulted for codes Intl does not know and never for ISO codes, so fiat rendering is byte-identical.

## Tried and ruled out

- Replacing the code token in Intl's output with the symbol: leaves Intl's code spacing ("₿ 0.0070"). The figure is laid out through a symbol currency and the symbol swapped in, so locale placement (prefix in en, suffix in de) holds.
- Keying rounding on the account type (CRYPTO gets four places): the currency, not the type, carries the precision; one rule keyed on the currency code covers every account.

## Watch out

- `Math.round(x * 100) / 100` and `roundToCents` are hidden in many account surfaces (balance history, average balance, split totals, reconcile tolerance, scheduled post and override dialogs). Each one silently rounds a coin amount to cents; a sub-cent difference even passed the reconcile tolerance. Use the currency's places.
- A memo that reads the registry must subscribe to it, or a figure computed before the currencies list arrives stays at two places.
- An ISO code whose narrow symbol is the code (CHF) still doubles for a non-default currency; that is pre-existing and was left alone.

In the code: `frontend/src/lib/currency-decimals.ts` (`decimalPlacesForCurrency`, `currencySymbolFor`, `subscribeCurrencyDecimals`), `frontend/src/lib/format.ts` (`getDecimalPlacesForCurrency`, `roundToEntryPlaces`, `MONEY_DECIMALS`), `useNumberFormat.formatMoneyFigure`, `CurrencyRegistryLoader`, `lib/balance-history.ts` (`averageDailyBalance`).
