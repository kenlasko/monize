# Plan: CRYPTO accounts and crypto currencies

Executes [`docs/specs/crypto-accounts.md`](../specs/crypto-accounts.md); read
the spec first. This plan says what to edit, what to run and what to observe.
The task list is [`crypto-accounts-tasks.md`](./crypto-accounts-tasks.md).

## Assumptions (verified against the tree, 2026-11-05)

- `accounts.account_type` has never been extended by a migration; the
  idempotent form is `ALTER TYPE ... ADD VALUE IF NOT EXISTS`
  (`database/migrations/20261022142530_return_of_capital_action.sql`).
- `currencies` is RLS-exempt global reference data; its columns are classified
  in `backend/src/backup/support-backup/support-backup-rules.ts` and the golden
  test in `backend/test/integration/support-backup.integration.spec.ts` fails
  an unclassified column.
- `resolveFxRate` consults a pair's two orientations and no pivot; the refresh
  fetches every canonical pair of the currencies in use, one chain question
  per base (`ExchangeRateService.refreshAllRatesGlobally`).
- `FxProviderChain` is built by the factory in `currencies.module.ts` from
  `resolveFxProviders(FX_PROVIDERS)`; `YahooFxProvider.carries` is always true
  and its symbol grammar is `<FROM><TO>=X`.
- `YahooFinanceService.fetchQuote` and `fetchHistoricalWindow` reach the chart
  endpoint through the throttle and breaker; a crypto symbol is passed through
  unchanged (`getYahooSymbol` adds no suffix to a `CRYPTO` exchange).
- No shared "cash-like" or "holds securities" helper exists in either layer;
  the type lists are hand-copied, and most gates work by exclusion (anything
  not a liability is an asset; anything not a brokerage half is a transfer
  target). The inventory below names each one that must change.
- The client takes a currency's decimal places from `Intl`
  (`useNumberFormat.formatCurrency`, `getDecimalPlacesForCurrency`); a code
  `Intl` does not know gets 2. No app-wide currency list is loaded; the
  Currencies page, pickers and forms each call `getCurrencies`.
- A split holds transfer and category lines together, and a cross-currency
  transfer line states `transferTargetAmount` (INV-SPLITFX-001 to -003).
  Nothing in the transfer path checks the account type.
- Documentation screenshots are Playwright tests in `e2e/docs-screenshots/`
  against the e2e stack holding the demo data plus the showcase seed
  (`website/README.md`, "Screenshots").

## Contract shared by every phase

- `currencies.kind`: `'FIAT' | 'CRYPTO'`, entity field `kind`, DTO field
  `kind`, API field `kind`, default `FIAT`.
- `currencies.quote_symbol`: entity and DTO field `quoteSymbol` (string or
  null), the Yahoo `<COIN>-<FIAT>` pair; `cryptoPairFiat(quoteSymbol)` must be
  non-null when present; null unless `kind = 'CRYPTO'`.
- `AccountType.CRYPTO` in `backend/src/accounts/entities/account.entity.ts`
  and the `AccountType` union in `frontend/src/types/account.ts`.
- Error keys (backend `errors.*`): `accounts.accountCurrencyKindMismatch`,
  `currencies.quoteSymbolRequiresCrypto`, `currencies.quoteSymbolNotAPair`,
  `currencies.kindInUse`.
- Exchange-rate source slug `yahoo_crypto`.
- Demo data: currency `BTC` (`kind CRYPTO`, `quoteSymbol BTC-CAD`, symbol `₿`,
  4 places); account "Bitcoin Wallet" (`CRYPTO`, `BTC`); stored `BTC->CAD`
  rates for the demo window; a transfer in from Primary Chequing with the
  received amount stated; a purchase; a split that transfers to Primary
  Chequing with a stated received amount plus a "Network fee" expense line.

## Phase 1A: currencies, provider, cron (backend)

- Migration `database/migrations/<UTC stamp>_currencies_kind_quote_symbol.sql`:
  `ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'FIAT'`, the
  CHECK on the two values, `ADD COLUMN IF NOT EXISTS quote_symbol VARCHAR(20)`,
  the CHECK `kind = 'CRYPTO' OR quote_symbol IS NULL`; `database/schema.sql`
  in the same commit; `backend/test/integration/fixtures/schema-baseline.sql`
  untouched (it is the baseline the migration replays over).
- `Currency` entity, `CreateCurrencyDto` / `UpdateCurrencyDto` (`kind`
  `@IsIn`, `quoteSymbol` optional, uppercased, `@MaxLength(20)`), the
  `UserCurrencyView` and `findAll` SQL, `ensureCurrencyForUser` (a non-ISO
  code stays `FIAT`; nothing infers `CRYPTO`), `updateWithin` refusing a
  `kind` change on a code `currency_code_in_use_globally` reports, and
  refusing `quoteSymbol` by the truth table in spec section 5.
- `support-backup-rules.ts` (`kind: keep`, `quote_symbol: keep`);
  `backup-restore-database.service.ts` already filters by live columns, add
  the `kind` default where it forces `decimal_places`; `restore-currencies.spec.ts`.
- `backend/src/currencies/providers/crypto-fx.provider.ts`: `CryptoFxProvider`
  (spec decision 5). It reads the `CRYPTO` rows with a `quote_symbol` through
  `withScopedDb` (the refresh and the read paths already run under an
  identity), cached for a few minutes; it calls `YahooFinanceService.fetchQuote`
  / `fetchHistoricalWindow` with the `<coin>-<fiat>` symbol. `null` for an
  outage, an empty answer for a symbol Yahoo reports as not found.
  `fx-provider.interface.ts`: the `name` type admits `"crypto"` without making
  it an `FX_PROVIDERS` token (`resolveFxProviders` keeps refusing it; the
  factory appends the provider last). `describe()` lists it. The frontend
  `FX_PROVIDER_NAMES` label list contract test is read before deciding how the
  status endpoint reports it.
- `ExchangeRateService`: `refreshCryptoRates()` (the pairs with a crypto side
  only) and `@Cron("10 17 * * 0,6", America/New_York)` under the same lease;
  the refresh summary's message for an uncarried crypto pair names the
  Currencies page (spec section 7). `docs/cron-jobs.md` gains the row.
- Seed: `seed.service.ts` currency seed and the demo seed carry `BTC` as in
  the contract; `demo-seed.service.ts` stores `BTC->CAD` rates for the demo
  window (source `demo`, the way the demo seeds other rates, or `yahoo_crypto`
  if it seeds none).
- Errors in `backend/src/i18n/locales/en/errors.json` only; `npm run i18n:pseudo`.
- Run: `npm run lint && npx tsc --noEmit && npm run typecheck`,
  `npm run test:unit -- currencies crypto-fx fx-provider-chain exchange-rate`,
  `npm run migration:lint`, `npm run build && npm run test:integration --
  support-backup restore migration-path`.
  Observe: a refresh with `BTC` in use asks Yahoo for `BTC-CAD` and stores
  `BTC->CAD` under `yahoo_crypto`; Frankfurter is never asked for `BTC`.

## Phase 1B: the account type (backend)

- Migration `<UTC stamp>_account_type_crypto.sql`: `ALTER TYPE account_type ADD
  VALUE IF NOT EXISTS 'CRYPTO'`; `schema.sql`.
- `AccountType.CRYPTO`; `assertAccountCurrencyKind(accountType, currency)` in
  `backend/src/accounts/account-currency-kind.util.ts`, called from
  `AccountsService` create and update (type or currency change), the import
  entity creator, the AI and MCP account-creating tools if any, and every
  other `accounts` writer `grep -rn "getRepository(Account)" backend/src`
  finds that sets a type or a currency. The linked-half mirror never produces
  a CRYPTO half.
- `SecuritiesService` create/update refuse a `CRYPTO` currency as a security's
  `currencyCode`.
- Lists: `backend/src/import/dto/import.dto.ts` `@IsIn` (new account types),
  `tool-definitions.ts` enum and `tool-input-schemas.ts` (`.max(11)`),
  `mcp/tools/accounts.tool.ts` (`.max(11)`), `account-export.service.ts`
  (`CRYPTO` exports as `Oth A`), `cash-flow-sankey.service.ts`
  `DEFAULT_SANKEY_SCOPE_TYPES` (add `CRYPTO`) and `cash-flow-sankey-assembly.ts`
  (other_accounts, as CASH), `net-worth.service.ts` (no change: not a
  liability), `joint-accounts.service.ts` (unchanged, not writable jointly).
  Bank sync: the link path refuses a `CRYPTO` account
  (`bank-sync.service.ts` where it refuses a brokerage).
- Pinned specs updated with the new value: `tool-definitions.spec.ts`,
  `cash-flow-sankey.service.spec.ts` (truth table B and the default scope),
  `cash-flow-sankey.property.spec.ts` generator, `account-export.service.spec.ts`.
- Demo seed: the account, its transactions and the split from the contract,
  in `demo-seed-data/accounts.ts` and `transactions.ts`; `seed.service.ts`
  `accountIds[acc.type]` keeps working (one CRYPTO account).
- Integration: `backend/test/integration/crypto-accounts.integration.spec.ts`
  for spec section 5, and one case in the split received-amount suite for a
  split on a CRYPTO account with a transfer line and a fee line.
- Run: the three lint commands, `npm run test:unit -- accounts sankey
  tool-definitions account-export import.dto securities.service`,
  `npm run migration:lint`, `npm run build && npm run test:integration --
  crypto-accounts split-transfer`.
  Observe: creating a CRYPTO account in CAD is refused with
  `accountCurrencyKindMismatch`; a CHEQUING account in BTC likewise.

## Phase 2A: currencies UI and the decimals registry (frontend)

- `lib/exchange-rates.ts`: `CurrencyInfo.kind`, `CurrencyInfo.quoteSymbol`,
  `CreateCurrencyData` / `UpdateCurrencyData` likewise, `CurrencyKind` type.
- `CurrencyForm.tsx`: a **Kind** choice (Fiat currency / Cryptocurrency); for
  Cryptocurrency a **Price symbol** field with **Verify** that calls the
  securities lookup (`securitiesApi.lookup`) and accepts only
  `securityType === 'CRYPTO'`, prefilling the name; decimal places default 4
  for a coin; the non-ISO notice now says the code is not ISO and offers the
  Cryptocurrency kind, linking to the new wallet guide section
  (`docsUrl('cryptoWallets')`); the precision note from spec decision 4.
- `CurrencyList.tsx` / the Currencies page: a kind pill and the price symbol
  beside a crypto row.
- `lib/currency-decimals.ts`: a registry `registerCurrencyDecimals(list)` /
  `decimalPlacesForCurrency(code)`; `useNumberFormat.formatCurrency`,
  `formatCurrencyPrecise` and `lib/format.ts getDecimalPlacesForCurrency`
  consult it before `Intl`. Filled by a `CurrencyRegistryLoader` beside
  `PreferencesLoader` (once per session, `getCurrencies(true)`), and by the
  Currencies page after a save. A coin unknown to the registry still formats
  (at `Intl`'s 2), so nothing throws.
- `docs-links.ts`: `cryptoWallets: { page: 'accounts', section:
  'cryptocurrency-wallets' }` and `cryptoCurrencies: { page:
  'currency-management', section: 'cryptocurrencies' }`.
- i18n: `en/currencies.json` keys only; `npm run i18n:pseudo`.
- Run: `npm run lint && npm run type-check && npm run i18n:check`,
  `npm run test -- currencies useNumberFormat format currency-decimals docs-links`.
  Observe: a BTC amount renders with four places once the registry holds BTC.

## Phase 2B: the account type (frontend)

- `types/account.ts` union; `account-type-meta.tsx` (`CRYPTO`:
  `CubeTransparentIcon`, amber ramp); `account-detail-views.ts` (`banking`);
  `net-worth-account-types.ts` (after `CASH`); `AccountList.tsx` order and
  filter; `AccountBalancesReport.tsx` keys; `account-utils.ts`
  `formatAccountType`; `import-utils.ts` options (and the `toHaveLength`
  test); `bank-sync` eligibility excludes `CRYPTO`;
  `InvestmentTransactionForm` funding accounts exclude `CRYPTO`.
- `AccountForm.tsx`: the picker option; when the type is `CRYPTO` the
  currency picker lists `kind === 'CRYPTO'` currencies only, otherwise `FIAT`
  only, with a hint linking to the Currencies page when none exists; no
  institution requirement, no credit limit, no interest rate; the opening
  balance `CurrencyInput` takes the currency's decimal places from the
  registry.
- i18n: `en/common.json accountTypes.CRYPTO`, `en/accounts.json
  form.accountTypeOptions.crypto` and the form hints, `en/reports.json
  accountBalances.accountTypes.CRYPTO`; `npm run i18n:pseudo`.
- Run: `npm run lint && npm run type-check && npm run i18n:check`,
  `npm run test -- accounts account-type net-worth-account-types import-utils
  AccountBalancesReport bank-sync-account-type`.
  Observe: the Accounts page groups a Bitcoin Wallet under its own pill and
  opens the banking detail view.

## Phase 3: documentation, locales, screenshots

- `website/docs/accounts.md`: the type table (11 types) and a
  "Cryptocurrency Wallets" section (form, detail page, buying, spending, the
  transfer with a network fee as a split, precision); `currency-management.md`:
  a "Cryptocurrencies" section (kind, price symbol, verification, rates
  including weekends, the four-place limit, three-letter codes);
  `investments.md#cryptocurrency`: the two models and when each fits, the
  note rewritten; `getting-started.md` type list. `npm run docs:build`.
- `docs/financial-semantics.md` section 3 (the crypto provider and the
  weekend tick), `docs/system-invariants.md` (INV-CRYPTO-001 `partial`,
  INV-CRYPTO-002 `enforced`, catalog rows and entries), `docs/cron-jobs.md`,
  `docs/specs/sankey-cash-flow.md` type table, `docs/backend/securities-and-providers.md`
  if it lists FX providers.
- Every locale for the new keys in both layers, never `xx` by hand.
- `e2e/docs-screenshots/accounts.spec.ts`: `create-account-form-crypto`,
  `account-crypto-detail`, `crypto-transfer-fee-split`, and `accounts-list`
  retaken; `currency-management.spec.ts`: `currency-form-crypto` and
  `currencies-page` retaken. `e2e/helpers/factories.ts` `AccountType` gains
  `CRYPTO`. Captured against the stack per `website/README.md`, then
  `oxipng`, then `npm run docs:build` and `npm run docs:check`.

## Gates before review

Per `AGENTS.md`: backend lint, tsc, typecheck, `test:changed`,
`migration:lint`, `build`, `test:integration`; frontend lint, type-check,
`i18n:check`, `test:changed`, `build`; `scripts/verify-schema.sh`,
`node scripts/check-migration-prefixes.mjs`, `node scripts/check-docs-manifests.mjs`,
`node scripts/check-env-docs.mjs`; `trail check`.
