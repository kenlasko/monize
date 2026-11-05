# Tasks: CRYPTO accounts and crypto currencies

Plan: [`crypto-accounts.md`](./crypto-accounts.md). Spec:
[`docs/specs/crypto-accounts.md`](../specs/crypto-accounts.md).

## 1A backend: currencies, provider, cron

- [x] Migration and `schema.sql`: `currencies.kind`, `currencies.quote_symbol`, their CHECKs.
- [x] Entity, DTOs, `UserCurrencyView`, `findAll`, `ensureCurrencyForUser`; `kind` locked once referenced; `quoteSymbol` rules.
- [x] Support-backup rules and restore defaults for the two columns.
- [x] `CryptoFxProvider`, appended last by the chain factory; breaker and throttle; `null` vs empty.
- [x] Weekend crypto refresh under the exchange-rates lease; `docs/cron-jobs.md` row.
- [x] Refresh summary names the Currencies page for a coin without a price symbol.
- [x] Seed `BTC` and demo `BTC->CAD` rates.
- [x] Unit and integration tests of the above.

## 1B backend: the account type

- [x] Migration and `schema.sql`: `account_type` gains `CRYPTO`.
- [x] `AccountType.CRYPTO`; `assertAccountCurrencyKind` on every account writer; securities refuse a crypto currency.
- [x] Import DTO, AI tool schemas, MCP schema, QIF export, Sankey scope and class, bank-sync link refusal.
- [x] Pinned specs updated; `crypto-accounts.integration.spec.ts`; a fee-split case on a CRYPTO account.
- [x] Demo seed: Bitcoin Wallet, its transactions, the fee split.

## 2A frontend: currencies and decimals

- [x] `CurrencyInfo.kind` / `quoteSymbol`; create and update payloads.
- [x] Currency form: kind, price symbol with Verify, defaults, notices.
- [x] Currencies page: kind pill and price symbol.
- [x] Currency decimals registry consulted by every money formatter; loader at boot.
- [x] `docs-links.ts` entries; `en/currencies.json`; pseudo-locale.

## 2B frontend: the account type

- [x] Type union, meta, detail view, net worth order, list order and filter, report keys, import options.
- [x] Account form: picker, currency list by kind, hidden fields, opening balance precision.
- [x] Bank sync eligibility and investment funding exclude `CRYPTO`.
- [x] `en/common.json`, `en/accounts.json`, `en/reports.json`; pseudo-locale; pinned tests.

## 3 documentation, locales, screenshots

- [x] `website/docs/accounts.md`, `currency-management.md`, `investments.md`, `getting-started.md`; `docs:build`.
- [x] `docs/financial-semantics.md`, `docs/system-invariants.md`, `docs/cron-jobs.md`, `docs/specs/sankey-cash-flow.md`.
- [ ] Every locale, both layers.
- [ ] Screenshot specs and the six pictures, both themes; `oxipng`; `docs:check`.
- [ ] Gates and `trail check`; a learning replacing `l-6c985800`.
