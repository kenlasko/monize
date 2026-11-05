# Tasks: CRYPTO accounts and crypto currencies

Plan: [`crypto-accounts.md`](./crypto-accounts.md). Spec:
[`docs/specs/crypto-accounts.md`](../specs/crypto-accounts.md).

## 1A backend: currencies, provider, cron

- [ ] Migration and `schema.sql`: `currencies.kind`, `currencies.quote_symbol`, their CHECKs.
- [ ] Entity, DTOs, `UserCurrencyView`, `findAll`, `ensureCurrencyForUser`; `kind` locked once referenced; `quoteSymbol` rules.
- [ ] Support-backup rules and restore defaults for the two columns.
- [ ] `CryptoFxProvider`, appended last by the chain factory; breaker and throttle; `null` vs empty.
- [ ] Weekend crypto refresh under the exchange-rates lease; `docs/cron-jobs.md` row.
- [ ] Refresh summary names the Currencies page for a coin without a price symbol.
- [ ] Seed `BTC` and demo `BTC->CAD` rates.
- [ ] Unit and integration tests of the above.

## 1B backend: the account type

- [ ] Migration and `schema.sql`: `account_type` gains `CRYPTO`.
- [ ] `AccountType.CRYPTO`; `assertAccountCurrencyKind` on every account writer; securities refuse a crypto currency.
- [ ] Import DTO, AI tool schemas, MCP schema, QIF export, Sankey scope and class, bank-sync link refusal.
- [ ] Pinned specs updated; `crypto-accounts.integration.spec.ts`; a fee-split case on a CRYPTO account.
- [ ] Demo seed: Bitcoin Wallet, its transactions, the fee split.

## 2A frontend: currencies and decimals

- [ ] `CurrencyInfo.kind` / `quoteSymbol`; create and update payloads.
- [ ] Currency form: kind, price symbol with Verify, defaults, notices.
- [ ] Currencies page: kind pill and price symbol.
- [ ] Currency decimals registry consulted by every money formatter; loader at boot.
- [ ] `docs-links.ts` entries; `en/currencies.json`; pseudo-locale.

## 2B frontend: the account type

- [ ] Type union, meta, detail view, net worth order, list order and filter, report keys, import options.
- [ ] Account form: picker, currency list by kind, hidden fields, opening balance precision.
- [ ] Bank sync eligibility and investment funding exclude `CRYPTO`.
- [ ] `en/common.json`, `en/accounts.json`, `en/reports.json`; pseudo-locale; pinned tests.

## 3 documentation, locales, screenshots

- [ ] `website/docs/accounts.md`, `currency-management.md`, `investments.md`, `getting-started.md`; `docs:build`.
- [ ] `docs/financial-semantics.md`, `docs/system-invariants.md`, `docs/cron-jobs.md`, `docs/specs/sankey-cash-flow.md`.
- [ ] Every locale, both layers.
- [ ] Screenshot specs and the six pictures, both themes; `oxipng`; `docs:check`.
- [ ] Gates and `trail check`; a learning replacing `l-6c985800`.
