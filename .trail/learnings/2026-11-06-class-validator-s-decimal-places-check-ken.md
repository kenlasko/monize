---
title: "class-validator's decimal-places check throws on numbers below 1e-6, so amounts, quantities and rates have their own exponent-safe validators"
author: Ken
date: 2026-11-06
branch: claude/crypto-account-currency
id: l-0dbd0fba
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - backend/src/backup/support-backup/support-backup.util.spec.ts
  - backend/src/backup/support-backup/support-backup.util.ts
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/de/sharedExpenses.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/es/sharedExpenses.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/fr/sharedExpenses.json
  - backend/src/i18n/locales/hi/errors.json
---

## Decided

Amount, share-quantity and exchange-rate DTO fields never use `@IsNumber({ maxDecimalPlaces })`. class-validator counts places with `value.toString().split(".")[1].length`, and JavaScript prints any number below 1e-6 in exponent form ("5e-8"), so the check throws a TypeError and the request is a 500 instead of a validation error. That was invisible while money stopped at four places; a 0.00000005 BTC amount, a satoshi-scale position or a CAD-to-BTC rate (0.0000073529, and 7e-8 for JPY) all hit it. Three decorators built on `decimalPlacesOf` (which reads the exponent) replace it: IsMoneyAmount(maxPlaces), IsShareQuantity(maxPlaces), IsFxRate() (positive, at least 1e-10, at most 10 places). A source guard fails any `maxDecimalPlaces` on a property named like an amount, balance, threshold, price, commission or quantity. Percentages and AI cost fields keep `maxDecimalPlaces`; they never go that small.

Also found the same way: the transfer DTOs had `@Min(0.0001)` / `@Min(0.000001)` on the exchange rate, which refused a coin pair's rate on edit.

## Tried and ruled out

`@IsNumber({ maxDecimalPlaces: 10 })` plus `@Min(1e-10)` for rates: the places check crashes before the minimum is reached.

## Watch out

When widening precision, grep every DTO for `maxDecimalPlaces` and every `@Min` on a rate; the old caps hide in DTOs far from the money code (scheduled transactions, imports, investment transactions).

In the code: `backend/src/common/validators/is-money-amount.validator.ts`, `is-share-quantity.validator.ts`, `is-fx-rate.validator.ts`, `backend/src/common/money-amount-dto.guard.spec.ts`, `backend/src/common/amount-precision.util.ts` (`decimalPlacesOf`), `docs/backend/entities-and-dtos.md`.
