# Tasks: money at eight places, rounded per currency

Plan: [`money-precision.md`](./money-precision.md). Spec:
[`docs/specs/money-precision.md`](../specs/money-precision.md).

## 1A backend: storage, helpers, currency ceiling

- [x] Migration widening all 55 money columns to `NUMERIC(24,8)`; `schema.sql`; entities; `entity-decimal-precision.spec.ts`.
- [x] `MONEY_SCALE`, `FIAT_MONEY_DECIMALS`, `moneyDecimalsFor`, `roundMoney`/`sumMoney`/`toMoneyNumber` with a decimals argument; exact `sumMoney`.
- [x] `assertAmountPrecision` and its error key; `applyFxConversion(toDecimals)`.
- [x] Currency `decimal_places` 0..8 (DTO, CHECK, restore clamp); CRYPTO default 8; shared groups and payroll rules refuse a coin.
- [x] Demo seed at 8 places.
- [x] `money-precision.guard.spec.ts` with its shrink-only baseline.

## 1B backend: transactions, transfers, splits

- [x] Per-currency rounding and sums; precision refusals on every writer; conversions into the target currency's precision.
- [x] `money-precision.integration.spec.ts`; existing specs gain coin cases; guard baseline shrinks.

## 1C backend: scheduled, accounts, balances, net worth, reports

- [x] Per-currency rounding on account-currency figures; refusals on account and scheduled writers; reporting figures untouched.
- [x] Tests; guard baseline shrinks.

## 1D backend: imports, bank sync, rules, AI and MCP

- [x] Parsers and planners at the account's precision; rules compare at 8; AI schema at 8; writers refuse breaches.
- [x] Tests; guard baseline empty.

## 2A frontend

- [x] `format.ts`, registry bound, `CurrencyInput`, currency form ceiling and default.
- [x] Every account-currency site converted; fiat byte-identical; source guard.
- [x] Tests and fixtures at 8 places.

## 3 documentation, locales, screenshots, review

- [x] Instruction files, contracts, specs, website pages; `docs:build`.
- [x] Locales; pseudo.
- [x] Screenshots retaken.
- [x] Code review, adversarial review, fixes, gates (changed specs only), `trail check`, learning.
