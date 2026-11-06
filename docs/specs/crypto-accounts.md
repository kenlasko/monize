# Spec: cryptocurrency wallets as CRYPTO accounts in a crypto currency

Status: approved for implementation on `claude/crypto-account-currency`.
Governs: the `CRYPTO` account type, the `kind` and `quote_symbol` columns of
`currencies`, the crypto exchange rate provider, and the documentation of
transfers that carry a network fee.

Read `docs/financial-semantics.md` sections 2, 3 and 5,
`docs/specs/exchange-rate-providers.md` sections 3 to 5 and
`docs/specs/split-cross-currency-transfer.md` before changing anything here.

This spec supersedes the decision recorded on 2026-11-04 (trail learning
`l-6c985800`, `website/docs/investments.md#cryptocurrency`) that a coin is
never a currency. That decision rested on two facts: no exchange rate provider
carried a coin, and money was `decimal(20,4)`. The first is removed here by a
provider that prices a crypto currency through the same Yahoo `<COIN>-<FIAT>`
symbol a crypto security uses. The second is removed by
`docs/specs/money-precision.md`, which widens money to `NUMERIC(24,8)` (decision
4 below, superseded). Tracking a coin as a security in a brokerage account
remains supported and is the right model for coins held as an investment; a
`CRYPTO` account is the model for a wallet the reader spends from and
transfers between.

## 1. Goal

A reader records a crypto wallet the way they record a chequing account: an
account denominated in one coin, with a register of transactions, transfers to
and from other accounts (fiat or crypto), scheduled transactions, reconciliation
and a balance that reaches net worth and every report converted at the coin's
rate to the reporting currency.

A wallet that holds several coins is several `CRYPTO` accounts, one per coin,
exactly as a bank customer with a USD and a CAD account holds two accounts.
This is a modelling choice, not a property of wallets: a hardware or exchange
wallet does hold many coins, and the one-coin-per-account rule is what lets the
account carry a currency and a balance the rest of Monize already understands.

## 2. What exists, and what this composes

- `accounts.account_type` is a PostgreSQL enum; `ALTER TYPE ... ADD VALUE IF NOT
  EXISTS` is the idempotent form the repository already uses
  (`database/migrations/20261022142530_return_of_capital_action.sql`).
- `currencies` is global reference data (no owner column; `created_by_user_id`
  names who introduced a non-ISO code). `exchange_rates` is global and stored in
  one canonical orientation (`canonicalRateRow`, INV-FX-003). `resolveFxRate`
  consults a pair's two directions and no pivot currency, so every pair a reader
  needs is fetched directly.
- The refresh (`ExchangeRateService.refreshAllRatesGlobally`) asks
  `FxProviderChain.latest(base, quotes)` for every canonical pair of the
  currencies in use. A quote goes to the first provider that `carries` both
  codes. The chain is built once from `FX_PROVIDERS`.
- A crypto security (`security_type = 'CRYPTO'`) is priced from Yahoo's
  `<COIN>-<FIAT>` symbol; `cryptoPairFiat` reads the fiat leg
  (`backend/src/securities/providers/crypto-pair.util.ts`). A weekend cron tick
  refreshes crypto securities only, because a coin trades every day.
- A split transaction holds transfer lines and category lines together; a
  cross-currency transfer line carries the amount that arrived
  (`transferTargetAmount`, INV-SPLITFX-001 to -003). Nothing new is needed for
  a "transfer with a network fee": it is a split with one transfer line and one
  expense line.

## 3. Decisions

1. **A currency has a `kind`: `FIAT` or `CRYPTO`.** `currencies.kind VARCHAR(10)
   NOT NULL DEFAULT 'FIAT'` with a CHECK on the two values. Every existing row
   is `FIAT`. The DTOs, the entity, the frontend type and the Currencies page
   carry it. Rejected: inferring "crypto" from "not an ISO 4217 code", because
   a reader may legitimately introduce a non-ISO fiat code (a currency ISO has
   retired, a complementary currency), and the kind decides behaviour below.
2. **A crypto currency maps to a Yahoo pair.** `currencies.quote_symbol
   VARCHAR(20)` holds the `<COIN>-<FIAT>` symbol the coin is priced from, such
   as `BTC-EUR`; a CHECK keeps it NULL on a `FIAT` row. The fiat leg is the pair
   the Currencies page shows as the coin's reference; the coin leg is the Yahoo
   coin ticker, which need not equal the three-letter Monize code (decision 3).
   The form verifies the symbol through the existing security lookup
   (`GET /securities/lookup`), which must report `securityType = 'CRYPTO'`, and
   prefills the currency's name from it. A `CRYPTO` currency without a
   `quote_symbol` is allowed (a coin no provider quotes) and is unpriced: its
   balances reach every total as unknown, never as zero and never at rate 1
   (INV-FX-001). Rejected: a foreign key to `securities`, because securities are
   per user and a currency's rate is a fact shared by every user.
3. **The code stays three letters.** `currencies.code` is `VARCHAR(3)` and so
   is every column that references it (`accounts.currency_code`,
   `transactions.currency_code`, `exchange_rates.from_currency`, and more). A
   coin whose ticker is longer takes a three-letter code of the reader's
   choosing (`DOG` for Dogecoin), and `quote_symbol` carries the real ticker
   (`DOGE-USD`). Widening every currency column is a separate proposal.
4. **Precision stays at four decimal places.** *Superseded by
   `docs/specs/money-precision.md`.* As first decided, money was `decimal(20,4)`,
   `decimalPlaces` was capped at 4 (`CreateCurrencyDto`) and a crypto currency
   defaulted to 4, which was coarse for a coin: a network fee of 0.00001 BTC
   rounded to zero. Widening money to eight places was recorded as out of scope
   (section 10) and is now done: money columns are `NUMERIC(24,8)`, a currency's
   `decimalPlaces` runs to 8 and a crypto currency defaults to 8.
5. **A crypto exchange rate provider, always present, always last.** A
   `CryptoFxProvider` (source slug `yahoo_crypto`) is appended to the chain the
   module factory builds, after whatever `FX_PROVIDERS` names. It is not a
   token of `FX_PROVIDERS`: there is nothing to configure, because no other
   provider carries a coin, and a chain without it could never price a
   `CRYPTO` currency. `carries(code)` is true for a `CRYPTO` currency that has a
   `quote_symbol` and for every `FIAT` code (it needs both sides). For a pair
   with exactly one crypto side it asks Yahoo's chart endpoint for
   `<coin ticker>-<fiat code>` (the coin ticker is the coin leg of
   `quote_symbol`; the fiat is whichever fiat the pair names, so `BTC` mapped to
   `BTC-EUR` is priced against CAD through `BTC-CAD`); for a pair of two coins it
   asks `<coinA>-<coinB>` once. An observation is `from = <Monize coin code>`,
   `to = <fiat code>`, dated by the quote's UTC day, at the quote's last price.
   `fetchDailySeries` is the same symbol over the window. `null` is "did not
   answer"; a symbol Yahoo reports as not found is "answered, nothing there"
   (INV-FX-005). Calls go through the same throttle and breaker as the
   securities' Yahoo calls. Rejected: teaching `YahooFxProvider` the `-`
   symbol form, because its `carries` is "always true, it cannot enumerate"
   and its placeholder cross-check (decision 10 of the providers spec) is for
   `=X` pairs; a separate adapter keeps the two symbol grammars apart.
6. **A weekend tick for crypto pairs.** `ExchangeRateService` gains a Saturday
   and Sunday cron, same lease as the weekday refresh, that refreshes only the
   pairs with a crypto side. Registered in `docs/cron-jobs.md`. Rejected:
   running the whole refresh on weekends, because Frankfurter publishes no
   weekend rate and the fiat pairs cannot have moved.
7. **A `CRYPTO` account behaves as a banking account.** It opens the banking
   detail view, lives in the "held" group of net worth after `CASH`, is a
   transfer source and destination, takes scheduled transactions and
   reconciliation, and is classified with `CASH` wherever a report classifies
   a counterpart by type (the Sankey). It is not eligible for bank sync, shared
   bank payment plans, loan or credit-card features, and it holds no
   securities. The inventory in `docs/future-plans/crypto-accounts.md` names
   every comparison.
8. **The account type and the currency kind agree (INV-CRYPTO-001).** A
   `CRYPTO` account's currency is a `CRYPTO` currency, and a `CRYPTO` currency
   is the currency of `CRYPTO` accounts only. Refused on account create and
   update and on every other path that writes an account (import, AI and MCP
   tools, joint accounts), and a currency's `kind` cannot change once any row
   references the code (`currency-reference-columns.ts`). A security's
   `currency_code` is never a `CRYPTO` currency (a security is priced in
   fiat; `cryptoPairFiat` already admits only ISO codes). Rejected: a database
   trigger, as a first cut; the catalog records the invariant as `partial`
   until one exists.
9. **A transfer with a network fee is a split.** One transfer line for what
   the counterpart receives, one expense line for the fee, both in the
   wallet's coin; the counterpart leg is in the target's currency with the
   received amount stated when the currencies differ. No new mechanism, DTO
   field or UI control: the documentation shows the pattern, the demo data
   carries one, and a screenshot pictures it.
10. **The 2026-11-04 guidance is reversed in the documentation, not
    deleted.** `website/docs/investments.md#cryptocurrency` keeps the
    security-based method and gains the wallet-based one; the "do not add BTC
    as a currency" note becomes guidance on which model fits which holding.
    The Currencies form's non-ISO notice now offers the `CRYPTO` kind.
11. **A coin is never the reporting currency.** Every converted figure is
    `roundMoney` in the reporting currency, which stays at four places
    (`docs/specs/money-precision.md` decision 3), and 0.0001 BTC is about 14 CAD
    at the prices of late 2026: a net worth, a budget or a report in a coin
    would round away amounts a reader can see. The preferences
    update refuses a `defaultCurrency` of kind CRYPTO with
    `errors.preferences.defaultCurrencyCrypto` ("A cryptocurrency cannot be
    the reporting currency"), reading the kind `FOR KEY SHARE` in the same
    transaction, before the currency is ensured or the preference written
    (`assertReportingCurrencyIsFiatIn`). A code's kind cannot change while a
    preference names it (`user_preferences.default_currency` is one of the
    columns `currency_code_referenced_by_data` reads). The backup restore,
    which writes the file's preferences, reports a CRYPTO reporting currency
    in `currencyKindMismatches` rather than refusing the restore (INV-CRYPTO-001
    explains why a restore reports).

## 4. Invariants

- **INV-CRYPTO-001 (kind and type agree).** `accounts.account_type = 'CRYPTO'`
  if and only if `currencies.kind = 'CRYPTO'` for `accounts.currency_code`.
  Mechanism: `assertAccountCurrencyKind` in the accounts service, called by
  create, update and every other writer, undo and redo included
  (`assertUndoCurrencyKind`); `CurrenciesService.update` refuses a `kind`
  change on a referenced code; the backup restore reports a mismatch it wrote
  (`currencyKindMismatches`). Status: `partial` (no database trigger, and the
  restore reports rather than refuses).
- **INV-CRYPTO-002 (a coin is priced through its pair).** Every
  `exchange_rates` row with a `CRYPTO` side was written by `CryptoFxProvider`
  (`source = 'yahoo_crypto'`) or by a user (`manual`); a fiat provider never
  answers for a coin. Mechanism: `carries` of the fiat providers is unchanged
  and the chain asks only carrying providers (INV-FX-005). Status: `enforced`
  by `fx-provider-chain.spec.ts` and the crypto provider's spec.
- **INV-FX-001 applies unchanged.** An unpriced coin's balance is unknown in
  every total; `FxAggregate.total` is `null` and the surface names the pair.

## 5. Truth table: which writes are accepted

| Account type | Currency kind | Create / update account | Why |
|---|---|---|---|
| CRYPTO | CRYPTO | accepted | the model |
| CRYPTO | FIAT | refused `accountCurrencyKindMismatch` | a wallet holds a coin |
| CHEQUING (any non-CRYPTO) | CRYPTO | refused `accountCurrencyKindMismatch` | a bank account holds fiat |
| INVESTMENT | CRYPTO | refused `accountCurrencyKindMismatch` | securities are priced in fiat; track the coin as a security instead |

| Currency write | Accepted | Why |
|---|---|---|
| create `BTC`, kind CRYPTO, quote `BTC-EUR` | yes | lookup reports CRYPTO |
| create `BTC`, kind CRYPTO, no quote symbol | yes, unpriced | a coin no provider quotes |
| create `BTC`, kind FIAT | yes | the kind is the reader's statement; the non-ISO notice offers CRYPTO |
| create `XYZ`, kind FIAT, quote `BTC-EUR` | refused `quoteSymbolRequiresCrypto` | CHECK and DTO |
| create, quote `BTC` (no fiat leg) | refused `quoteSymbolNotAPair` | `cryptoPairFiat` is null |
| update `kind` on a code any account, transaction or security references | refused `kindInUse` | INV-CRYPTO-001 |
| update `quote_symbol` on a referenced CRYPTO code, fiat leg only (`BTC-EUR` to `BTC-CAD`) | accepted | the provider prices against whichever fiat the pair names; the next refresh fetches the new pair |
| update `quote_symbol` on a referenced CRYPTO code, coin ticker (`BTC-EUR` to `ETH-EUR`, or to no symbol) | refused `quoteSymbolInUse` | `currencies` is shared: a new ticker would revalue every other user's wallet at another coin's price; held like a kind change, under the same `FOR UPDATE` |
| set `quote_symbol` on a CRYPTO code that had none | accepted | pricing an unpriced coin re-points nothing |

## 6. Numerical examples

Rates are 10 dp, money at the currency's places (4 for fiat and the reporting currency CAD, up to 8 for a coin; `docs/specs/money-precision.md`), the amounts below as first written at 4 dp.

| Case | Figures |
|---|---|
| Wallet balance | `0.0125` BTC; stored `BTC->CAD` 2026-11-05 = `137250.1234567890`; value `1715.6265` CAD |
| Canonical orientation | the observation is `BTC->EUR 91000`; `isCanonicalOrientation('BTC','EUR')` is true, stored as is; `EUR->BTC` resolves by inversion to `0.0000109890` |
| A coin that sorts after its fiat | `XBT->IDR 1520000000`; stored coin first as `XBT->IDR` (a pair with one coin side is stored coin -> fiat, `docs/specs/exchange-rate-canonical-orientation.md` section 12), not as `IDR->XBT 0.0000000007`, which would resolve back to 1.43e9 |
| A rate the column cannot hold | `BTC->LBP 11000000000`: at or above 1e10, `canonicalRateRow` is `null` and the refresh reports "Rate out of range" for that pair |
| Transfer with fee, same coin | split on wallet A, total `-0.0101` BTC: transfer line `-0.0100` to wallet B (counterpart `+0.0100` BTC), expense line `-0.0001` to "Fees: Network" |
| Buy from chequing | plain transfer from CAD chequing `-1700.00` to the wallet, received `0.0125` BTC stated; stored rate `roundFxRate(0.0125 / 1700) = 0.0000073529` |
| Below precision | superseded by `docs/specs/money-precision.md`: a fee of `0.00002500` BTC is a valid 8-place amount and is stored as it is. An amount with more places than the coin carries (`0.000000001` BTC) is refused with `errors.transactions.amountPrecisionExceeded`, never rounded |
| Unpriced coin | `XYZ` mapped to nothing: the wallet's `convertedBalance` is `null`, `fxComplete = false`, the message names `XYZ->CAD` and the Currencies page as where to map it |

## 7. Missing-data policy

- No `quote_symbol`: the pair is `uncarried` in the refresh summary ("No
  configured provider carries BTC/CAD" is wrong here; the message is "BTC has
  no price symbol; map one on the Currencies page"). The account's converted
  figures are unknown. The history gap fill refuses the pair with the same
  message and records nothing: no `exchange_rate_coverage` row and no empty
  window, because nobody was asked (`carried: false`,
  `docs/specs/exchange-rate-providers.md` section 5). Setting a first symbol,
  or re-pointing the coin ticker, deletes the code's coverage rows in the same
  transaction and forgets the process's empty windows for it (another
  replica's expire within their half-hour TTL), so the next fill asks for
  every window again.
- A code the crypto adapter's read of `currencies` does not hold, within the
  miss-reload throttle or after the re-read: `claims` and `carries` reject
  ("could not say"), the chain asks nobody and the pair is `unanswered` for
  the tick. Every code in use has a `currencies` row, so absence means the
  read is stale; answering "not a coin" would route a coin created on another
  replica to Yahoo's `=X` grammar.
- Yahoo did not answer: `unanswered`, retried next tick; the last stored rate
  within `FX_MAX_RATE_AGE_DAYS` resolves (INV-FX-001).
- Yahoo has no `<coin>-<fiat>` symbol for the reporting fiat (an exotic fiat):
  answered without a rate. The refresh summary names the symbol asked; the
  reader may change the reporting currency or enter a manual rate.
- A `CRYPTO` currency the reader deactivates: like any inactive currency.

## 8. Test matrix

| Claim | Kind | Where |
|---|---|---|
| migration adds the enum value and the two columns idempotently; schema.sql matches | `migration:lint`, `verify-schema.sh` | CI |
| the DTO refuses `quoteSymbol` on FIAT, a symbol without a fiat leg, `decimalPlaces > 4` | unit | `currencies/dto/*.spec.ts` |
| the truth table of section 5, every row, on create and update | integration | `backend/test/integration/crypto-accounts.integration.spec.ts` |
| every account-writing entry point refuses a kind mismatch (import, AI tool, MCP, joint) | unit per path | the path's existing spec |
| `CryptoFxProvider.carries`, symbol derivation, both orientations, `null` vs empty, breaker | unit | `providers/crypto-fx.provider.spec.ts` |
| the chain asks the crypto provider only for pairs with a crypto side; fiat providers unchanged | unit | `fx-provider-chain.spec.ts` |
| the weekend tick refreshes crypto pairs only, under the lease | unit | `exchange-rate.service.spec.ts` |
| net worth by type carries `CRYPTO` as a held type; Sankey classifies it with CASH | unit | the services' specs |
| a split transfer with a fee line on a CRYPTO account conserves both legs | integration | `split-transfer-received-amount` suite, one case added |
| the Currencies form: kind switch, lookup verification, non-ISO notice; the Accounts form: CRYPTO type lists only CRYPTO currencies | unit | `CurrencyForm.test.tsx`, `AccountForm.test.tsx` |
| `ACCOUNT_TYPE_META`, `ACCOUNT_DETAIL_VIEWS`, `NET_WORTH_ACCOUNT_TYPE_ORDER`, labels and i18n keys cover `CRYPTO` | unit guard | existing "every type" tests |
| documentation pages build; every screenshot named exists | `docs:check` | CI |

## 9. Documentation and screenshots

`website/docs/accounts.md` (the type table; a "Cryptocurrency Wallets" section
with the form, the detail page and the transfer-with-fee split),
`website/docs/currency-management.md` (a "Cryptocurrencies" section with the
form), `website/docs/investments.md#cryptocurrency` (the two models), and
`docs/financial-semantics.md` section 3 (the crypto provider). Pictures:
`currency-form-crypto`, `currencies-page` (retaken), `create-account-form-crypto`,
`account-crypto-detail`, `crypto-transfer-fee-split`, `accounts-list` (retaken).

## 10. Scope cuts

Out of scope, each a separate proposal: money precision beyond eight places (`docs/specs/money-precision.md` section 10);
currency codes longer than three letters; on-chain balance sync; a per-wallet
multi-coin model; crypto securities' prices reused as a currency's rate; a
database trigger for INV-CRYPTO-001.
