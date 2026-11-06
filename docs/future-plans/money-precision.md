# Plan: money at eight places, rounded per currency

Executes [`docs/specs/money-precision.md`](../specs/money-precision.md); read
the spec first. The task list is [`money-precision-tasks.md`](./money-precision-tasks.md).

## Assumptions (verified against the tree, 2026-11-06)

- 55 money columns in 26 tables are `NUMERIC(20,4)` or `DECIMAL(20,4)`; no
  function, view or `RETURNS TABLE` names the type and nothing rounds with
  `ROUND(x, 4)`. `shared_validate_entry_allocations()` compares sums exactly
  and relies on entry and allocations sharing a scale (fiat, unchanged).
- `backend/src/entity-decimal-precision.spec.ts` parses every `*.entity.ts`
  and `schema.sql` and requires `precision`/`scale` to match per column.
- `migration:lint` refuses `ALTER COLUMN ... TYPE` without
  `-- contract-after: X.Y.Z`; the grandfather list is shrink-only. The four
  earlier widenings are bare `ALTER TABLE ... ALTER COLUMN ... TYPE`, which is
  inherently re-runnable.
- `round.util.ts`: `MONEY_DECIMALS = 4`, `roundMoney(v)`, `sumMoney(values)`
  (integer ten-thousandths in doubles), `toMoneyNumber(v)`. 569 `roundMoney`
  calls in 112 files, 102 `sumMoney` in 36. The frontend mirrors them in
  `lib/format.ts` (`MONEY_DECIMALS`, `roundMoney`, `sumMoney` with a literal
  10000) and bounds its decimals registry to 0..4.
- `applyFxConversion` (`common/fx-entry.util.ts` ~131-136) rounds base, fee
  and amount with `roundMoney`; the transfer and split-transfer conversions
  call it.
- 73 DTO fields carry `maxDecimalPlaces: 4`; the AI `amountSchema` refines at
  10000; the rules engine, email receipts, shared expenses and MNY import
  scale at 10000 (`MONEY_SCALE`, `MONEY_UNITS`, `SHARED_MONEY_SCALE`,
  `AMOUNT_SCALE`).
- The inventory (the sweep of 2026-11-06) classifies every site as (a) an
  amount in the account's currency, (b) a reporting-currency figure, (c)
  fiat-only, (d) other; the per-currency work is class (a) only.

## Contract shared by every phase

Backend `backend/src/common/round.util.ts`:
- `MONEY_SCALE = 8` (the column scale), `FIAT_MONEY_DECIMALS = 4`.
- `moneyDecimalsFor(decimalPlaces: number | null | undefined): number` =
  `Math.max(FIAT_MONEY_DECIMALS, Math.min(MONEY_SCALE, decimalPlaces ?? 2))`.
- `roundMoney(value, decimals = FIAT_MONEY_DECIMALS)`,
  `sumMoney(values, decimals = FIAT_MONEY_DECIMALS)` (exact, `BigInt` over
  decimal strings), `toMoneyNumber(value, decimals = FIAT_MONEY_DECIMALS)`.
- `MONEY_DECIMALS` stays exported as an alias of `FIAT_MONEY_DECIMALS` with a
  deprecation comment, so untouched fiat callers compile unchanged.
- `backend/src/common/amount-precision.util.ts`:
  `decimalPlacesOf(value: number | string): number` and
  `assertAmountPrecision(amount, currency: { code, decimalPlaces }, field)`
  throwing `BadRequestException` with `tr("errors.transactions.amountPrecisionExceeded", ..., { code, places, field })`.
- `applyFxConversion(amount, rate, options?)` gains `toDecimals` (default 4).
- `currencies.decimal_places` 0..8; `CRYPTO_DEFAULT_DECIMAL_PLACES = 8`.

Frontend `frontend/src/lib/format.ts`:
- `MONEY_SCALE = 8`, `FIAT_MONEY_DECIMALS = 4`, `moneyDecimalsFor` (same rule),
  `roundMoney(value, decimals = 4)`, `sumMoney(values, decimals = 4)` exact,
  `MONEY_DECIMALS` alias kept; `entryDecimalPlaces` returns the registered
  places, else `MONEY_SCALE` when `awaitsRegisteredPlaces`, else 2;
  `lib/currency-decimals.ts` `MAX_DECIMAL_PLACES = 8`.

Demo data: BTC `decimalPlaces 8`; the wallet's transactions become
`+0.01249993` (bought for 1,700.00 CAD), `-0.00043210` (coffee),
and the sale split `-0.00502500` = transfer `-0.00500000` (received 650.00 CAD)
plus fee `-0.00002500`.

## Phase 1A: storage, helpers, currency ceiling (backend, first)

- Migration `<UTC stamp>_money_scale_8.sql`: `ALTER TABLE t ALTER COLUMN c
  TYPE NUMERIC(24, 8)` for all 55 columns (one `ALTER TABLE` per table),
  header per spec decision 1, `-- contract-after: 1.21.0`; a second file (or
  the same, one change) adds `CHECK (decimal_places BETWEEN 0 AND 8)` on
  `currencies` with the drop-then-add recipe. `schema.sql` matches. Every
  entity column `precision: 24, scale: 8`; `entity-decimal-precision.spec.ts`
  passes with its `UNIT_PRICE_COLUMNS` check untouched and its header
  comment corrected.
- `round.util.ts` per the contract, with `round.util.spec.ts` covering the
  defaults, 8-place rounding, `sumMoney` exactness above 2^53/1e8 and
  `moneyDecimalsFor` (null, 0, 2, 3, 4, 6, 8, 9).
- `amount-precision.util.ts` and its spec; the English error key; pseudo.
- `applyFxConversion` `toDecimals` with spec cases; callers unchanged (the
  transfer paths pass it in 1B).
- Currency ceiling: DTO `@Max(8)`, `CRYPTO_DEFAULT_DECIMAL_PLACES = 8`,
  restore clamp 0..8 (`restore-currencies.spec.ts`), `shared-db.ts`
  `currencyPlaces` keeps refusing > 4 and `shared-groups` creation refuses a
  `CRYPTO` currency (`errors.sharedExpenses.groupCurrencyMustBeFiat`);
  `payroll-deduction-rules` creation refuses a `CRYPTO` bill account
  (`errors.payroll.billAccountMustBeFiat`).
- Demo seed per the contract (`crypto-rates.ts`, `transactions.ts`), with
  the counterpart legs' implied rates recomputed; `demo-seed.service.spec.ts`.
- Source guard `backend/src/common/money-precision.guard.spec.ts`: lists the
  class (a) files (from the inventory) and fails a bare `roundMoney(x)`,
  `sumMoney(x)` or `toMoneyNumber(x)` without a decimals argument in them,
  with a baseline that is the full list on the day it lands and shrinks as 1B
  to 1D convert each file (the guard's baseline is shrink-only; its failure
  message names `moneyDecimalsFor`).
- Run: `npm run lint && npx tsc --noEmit && npm run typecheck`,
  `TZ=UTC npm run test:unit -- round.util amount-precision fx-entry currencies restore-currencies entity-decimal-precision demo-seed crypto-rates money-precision`,
  `npm run migration:lint`, root `node scripts/check-migration-prefixes.mjs`,
  `scripts/verify-schema.sh`.

## Phase 1B: transactions, transfers, splits (backend)

Files: `transactions/transactions.service.ts`, `transaction-transfer.service.ts`,
`transaction-split.service.ts`, `transaction-bulk-update.service.ts`,
`convert-to-transfer.ts`, `split-received-amount.util.ts`,
`transaction-search-parse.util.ts`, `common/split-amount.util.ts`,
`common/deletion-balance.util.ts`, `common/currency-minor-unit.util.ts`,
`action-history/action-history.service.ts` (fingerprint and recompute), the
DTOs `create-transaction`, `create-transaction-split`, `create-transfer`,
`update-transfer` (`maxDecimalPlaces: 8` on account-currency amounts).
- Every `roundMoney`/`sumMoney` on an account-currency amount takes the
  account currency's `moneyDecimalsFor`; the currency row is loaded once per
  operation inside the transaction (a small `loadCurrencyPlaces(manager,
  codes)` helper in `common/`, reused by 1C and 1D).
- `assertAmountPrecision` on create, update, bulk, split lines
  (`validateSplits`), transfers (both legs, `toAmount`, `transferTargetAmount`),
  convert-to-transfer, undo.
- `resolveTransferFx` and `resolveSplitTransferAmount` convert into the
  target currency at its precision; `validateSplitAmountSum` compares at the
  parent currency's precision; the split fingerprint uses the same.
- Tests: new cases per spec sections 5 and 6 in the existing specs; the
  integration suite `money-precision.integration.spec.ts` (create, update,
  split, transfer, convert) against BTC at 8 and CAD at 4, plus a CAD amount
  at 5 places still refused; the guard baseline shrinks by these files.

## Phase 1C: scheduled, accounts, balances, net worth, reports (backend)

Files: `scheduled-transactions/*.service.ts` and DTOs, `accounts/accounts.service.ts`
(balances, thresholds, recompute, closing), `accounts/balance-forecast.*`,
`accounts/account-balances-report.service.ts` (per-account figures),
`delegation/joint-accounts.service.ts`, `net-worth/net-worth.service.ts`
(per-account balance before conversion only), `transaction-reconciliation.service.ts`,
`categories/category-detail.service.ts`, `payees/payee-detail.service.ts`,
`transactions/transaction-analytics.service.ts` (per-account totals with a
currency), `accounts/account-export.service.ts` (running balance; CSV/QIF
print the stored string), `accounts/dto/create-account.dto.ts` /
`update-account.dto.ts` (opening balance and thresholds at 8;
`assertAmountPrecision` in the service).
- Same rules as 1B; the reporting-currency figures in these files stay at 4
  and are left alone (the inventory names each line).
- Tests per path; the guard baseline shrinks.

## Phase 1D: imports, bank sync, rules, AI and MCP (backend)

Files: `import/ofx-parser.ts`, `import/csv-parser.ts`, `import/qif-parser.ts`
(parse at the account's precision; a coin CSV with 8 places imports whole),
`import/import.service.ts`, `import-context.ts`, `import-post-processing.service.ts`,
`import-transfer-dedupe.ts`, `import-regular-processor.service.ts` (the
`applyFxConversion` caller), `bank-sync/*` (`bankBalance`, planner,
fingerprint, preview, `toFixed(4)`), `transaction-rules/*` (`MONEY_SCALE`
sites compare through `roundToDecimals(x, MONEY_SCALE)` equality or
`sumMoney`, never a 10000 float scale; `explain-rule-row.dto.ts` and
`rule-amount.ts` regexes admit 8 places), `ai/query/tool-input-schemas.ts`
`amountSchema` (8 places), the AI and MCP actions that write amounts
(`assertAmountPrecision`), `ai-review/ai-review-work.service.ts`,
`support-backup-scope.ts`. MNY import stays at 4 (fiat source) with a
comment. Email receipts and shared expenses stay at 4 (spec section 10).
- Tests per path; the guard baseline shrinks to empty, at which point the
  guard's list is the enforcement of INV-MONEY-001.

## Phase 2A: frontend

- `lib/format.ts` and `lib/currency-decimals.ts` per the contract;
  `CurrencyInput` at 8 places (parse, format, expression evaluation);
  `currency-form-schema.ts` and `CurrencyForm.tsx` max 8, coin default 8, the
  precision notice text; `useNumberFormat` ceilings that cap a coin below 8
  (`formatCurrencyPrecise` 6, `formatQuantity` 4 is quantities and stays).
- Every class (a) site from the inventory: `SplitEditor`, `SplitAmountFields`,
  `TransactionForm`, `split-rows.ts`, `PostTransactionDialog`,
  `ScheduledTransactionForm`, `OverrideEditorDialog`, `UpcomingBills`,
  `lib/forecast.ts`, `lib/minor-unit-booking.ts`, `lib/balance-history.ts`,
  `lib/running-balance.ts`, `lib/fx-fees*.ts`, `reconcile-rows.ts`,
  `TransactionList.tsx`, `app/transactions/page.tsx`, `AccountForm`,
  `BankSyncAccountRow`: `roundMoney(x, moneyDecimalsFor(places))` or
  `roundToEntryPlaces`, `sumMoney(xs, decimals)`, no literal 10000 on an
  account amount. Reporting-currency and fiat sites untouched.
- Tests: fixtures registering BTC at 8; `0.00002500` round-trips through
  `CurrencyInput`, the split editor balances `-0.00502500`, the forecast and
  running balance keep 8 places; fiat expectations byte-identical. A frontend
  source guard in `src/test/` mirrors the backend's for the listed files.
- Run: `npm run lint && npm run type-check && npm run i18n:check`,
  `TZ=UTC npm run test -- <the files>`.

## Phase 3: documentation, locales, screenshots, review

- `AGENTS.md` "Financial math" first paragraph; `frontend/CLAUDE.md`;
  `docs/financial-semantics.md` (sections 1, 3 crypto bullets, 4 table);
  `docs/financial-calculation-contract.md`; `docs/testing-contract.md`;
  `docs/frontend/forms-and-formatting.md` and `financial-figures.md`;
  `docs/system-invariants.md` (INV-MONEY-001, the `NUMERIC(20,4)` mentions);
  `docs/specs/crypto-accounts.md` decision 4 and section 6; the specs that
  cite `decimal(20,4)` get one line each; website pages (`accounts.md`
  precision paragraph and fee example, `currency-management.md`,
  `investments.md`); `docs:build`.
- Locales for the new error keys and the changed notice; pseudo.
- Screenshots retaken: `currencies-page`, `currency-form-crypto`,
  `account-crypto-detail`, `crypto-transfer-fee-split`, `accounts-list`.
- `/code-review` then the `/audit` protocol at the pinned head, fixes, gates
  (changed specs and guards only), `trail check`, a learning replacing
  the "four-place limit stands" clause.
