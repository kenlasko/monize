# Multi-Currency Transaction Entry (Discussion #910)

Status: planned, not yet implemented.

## Context

Users travelling abroad want to record transactions in the currency they actually paid in (e.g. EUR on a CAD account), have Monize convert to the account currency using the exchange rate for the transaction date, automatically book their bank's foreign-transaction fee as a split, and retain the original amount/currency/rate per transaction (banks apply differing intraday rates). Today a standard transaction's `currency_code` is always the account's currency and `exchange_rate` is 1; only cross-currency *transfers* handle FX.

The codebase already has mature currency infrastructure to build on: a `currencies` table + CRUD UI (`CurrencyForm` with Yahoo lookup), an `exchange_rates` table with per-date rates and carry-forward/backfill (`ExchangeRateService.getRateForDate`), and `currency_code`/`exchange_rate` columns on `transactions`.

Decisions confirmed with the user:

- Data model: new nullable columns on `transactions`, not a separate table (reuse the existing `exchange_rate` column for the per-transaction rate).
- Fee applies to both purchases and refunds (fee split always an expense on the absolute converted value).
- Deferred to later iterations: imports, scheduled transactions, AI/MCP *writes* of foreign-entered transactions. In scope: AI/MCP read surfaces, and basic FX visibility/filtering in the transaction list.

## Core invariants (do not break)

- `transactions.amount` and `transactions.currency_code` always stay in the account's currency. Balances (`AccountsService.updateBalance` / `recalculateCurrentBalance`), per-currency totals, and reports are untouched.
- Foreign entry is stored *alongside*: `original_amount` + `original_currency_code` (NULL = ordinary transaction). `exchange_rate` = account-currency units per 1 unit of original currency; `convertedBase ~ roundMoney(originalAmount x rate)`.
- Authoritative values are `original_amount` (as typed) and `amount` (final, possibly user-overridden). The rate is derived/stored for display: on override, frontend recomputes `rate = base / original` (10 dp).
- Splits stay entirely in account currency and must sum to `amount` (existing `validateSplits` check enforces base + fee = amount).
- Fee math (via `roundMoney` / `roundToCents`):
  `base = round(original x rate)`; `fee = -round(|base| x feePercent / 100)`; `amount = base + fee`.

## Phase 1 -- Database

1. `database/migrations/100_accounts_fx_fee.sql` (idempotent, style of `096_accounts_overpayment_payee_id.sql`):
   - `accounts.fx_fee_percent NUMERIC(8,4) NULL`
   - `accounts.fx_fee_category_id UUID NULL` + FK `REFERENCES categories(id) ON DELETE SET NULL` + index.
2. `database/migrations/101_transactions_original_currency.sql`:
   - `transactions.original_amount NUMERIC(20,4) NULL`
   - `transactions.original_currency_code VARCHAR(3) NULL` + FK to `currencies(code)`
   - `transaction_splits.is_fx_fee BOOLEAN NOT NULL DEFAULT false` (marks the auto-generated fee split for read-only re-identification on edit).
3. Mirror all changes in `database/schema.sql` (same PR -- project rule).

## Phase 2 -- Backend

4. Entities:
   - `transactions/entities/transaction.entity.ts`: `originalAmount` (decimal 20,4, nullable), `originalCurrencyCode` (varchar 3, nullable).
   - `transactions/entities/transaction-split.entity.ts`: `isFxFee` (boolean, `is_fx_fee`, default false).
   - `accounts/entities/account.entity.ts`: `fxFeePercent` (decimal 8,4, nullable, numericTransformer), `fxFeeCategoryId` + ManyToOne relation (pattern: `interestCategoryId`).
5. DTOs:
   - `create-transaction.dto.ts`: `originalAmount?` (`@IsNumber({maxDecimalPlaces:4})`, same bounds as amount), `originalCurrencyCode?` (`@IsCurrencyCode()`); `UpdateTransactionDto` inherits, allow explicit null to clear.
   - `create-transaction-split.dto.ts`: `isFxFee?: boolean`.
   - `create-account.dto.ts` / `update-account.dto.ts`: `fxFeePercent?` (`@Min(0) @Max(100)`), `fxFeeCategoryId?` (`@IsUUID`).
6. `transactions.service.ts` -- in existing QueryRunner flows (same-row columns, no new multi-table ops):
   - `create()`: validate `originalAmount`/`originalCurrencyCode` provided together; if code equals account currency, strip both (tolerant); when foreign, require `exchangeRate > 0` and matching sign between `originalAmount` and `amount`. Fields flow through the DTO spread automatically.
   - `update()`: add both fields to the field-by-field copy block (~lines 1861-1876) with `?? null` clearing; same validation against the (possibly changed) account. Balance diff logic untouched.
7. `transaction-split.service.ts`: carry `isFxFee` through `createSplitsInternal` / `addSplit`; validate at most one fee split per transaction and that it is kind=category.
8. Rate endpoint -- `currencies.controller.ts`, in the static `exchange-rates/*` group (above `:code` routes):
   `GET /currencies/exchange-rates/rate?from&to&date` -> `{ rate: number | null }`, thin wrapper over `ExchangeRateService.getRateForDate` (already does carry-forward + Yahoo backfill). Validate `YYYY-MM-DD`, currency-code params, throttle 10/min like `lookup`.
9. `accounts.service.ts`: validate `fxFeeCategoryId` ownership (existing pattern); reject `fxFeePercent` set with no category (`tr()` BadRequest).
10. AI/MCP read surfaces (both layers, per project rule): include `originalAmount`, `originalCurrencyCode`, `exchangeRate` on transaction rows in `mcp/tools/transactions.tool.ts` and `ai/query/tool-executor.service.ts` (shared shaping in `transaction-tool-prep.service.ts` where applicable); emit only when `originalCurrencyCode` is non-null. Note in tool descriptions that these are read-only metadata (writes deferred).
11. List filter: `transactions.controller.ts` `findAll` gains `originalCurrencyCodes` (comma-separated) query param -> `transactions.service.ts` `findAll` adds `andWhere("transaction.original_currency_code IN (...)")`.
12. Backend i18n (English only during development): new `errors.transactions.*` / `errors.accounts.*` keys in `backend/src/i18n/locales/en/*.json`; full locale pass at acceptance.

## Phase 3 -- Frontend

13. API/types:
    - `lib/exchange-rates.ts`: `getRateForDate(from, to, date)`, dedupe-cached per `from:to:date`.
    - `types/transaction.ts` + `lib/transactions.ts`: `originalAmount`/`originalCurrencyCode` on `Transaction` and create/update payloads; `isFxFee` on split types; `originalCurrencyCodes` filter param in `buildFilterParams`.
    - `types/account.ts` + `lib/accounts.ts`: `fxFeePercent`, `fxFeeCategoryId`.
14. `components/transactions/CurrencyPickerButton.tsx` (new) -- square button left of Amount showing the entry currency's symbol (button pattern: history/Split buttons in `NormalTransactionFields.tsx`, `flex items-stretch space-x-2`, `flex-shrink-0 mt-6 px-2.5 border rounded-md`). Opens an anchored popover (pattern: `RecentTransactionsPopover`) listing active currencies from `exchangeRatesApi.getCurrencies()` as `symbol -- CODE Name`, plus an "Add currency..." row opening the existing `CurrencyForm` in a `Modal` (pattern: `TagForm`-in-`Modal` inside `TransactionForm`). On create, refresh list and select the new currency.
15. `NormalTransactionFields.tsx` / `SplitTransactionFields.tsx`: place `CurrencyPickerButton` left of the Amount `CurrencyInput`; Amount prefix/decimals follow the entry currency (`getCurrencySymbol`, `getDecimalPlacesForCurrency`). Hidden in transfer mode (transfers already handle FX).
16. `TransactionForm.tsx` -- core state flow:
    - State: `entryCurrency` ('' = account currency), `fxRate`, `rateOverriddenRef` (starts true when editing an existing foreign transaction so a date fix doesn't clobber the bank's stored rate), `displayCurrency: 'original' | 'account'`.
    - Foreign currency picked -> Amount edits the foreign total (`originalAmount` form field); fetch rate (debounced ~300 ms) for `(entryCurrency -> account currency, transactionDate)`; refetch on date change unless overridden. FX panel under Amount: editable converted-base `CurrencyInput` (the override), rate caption "1 EUR = 1.4523 CAD (date)", warning when rate is null (leave base enabled for manual entry; suggest latest stored rate via `useExchangeRates().getRate` labeled as latest-not-dated).
    - Recompute helper: base/fee/amount as per invariants. If account has `fxFeePercent` + `fxFeeCategoryId` and mode is normal -> switch to split mode seeding `[purchase row (selected category, base), fee row (isFxFee, fee category, fee, localized memo)]`. On recompute: always update the fee row; with exactly two rows also update the purchase row; with extra manual rows, only the fee row updates and the existing `remaining` indicator guides rebalancing.
    - Converted-base override -> `rate = base / original` (10 dp), mark overridden, recompute fee/amount.
    - Reset to account currency -> clear FX fields, remove fee row, collapse to normal mode via existing convert-to-regular path when one category row remains.
    - Submit (`performSubmit`): payload gains `originalAmount`, `originalCurrencyCode`, `exchangeRate`; splits carry `isFxFee`. Block submit with a toast if foreign and no rate and no converted override.
    - Edit-mode toggle (presentational only): two-pill `CAD | EUR` toggle next to Amount when `originalCurrencyCode` set; 'original' view shows foreign amounts (splits shown converted via `amount / exchangeRate` as read-only text -- editing amounts only in account view); 'account' view behaves exactly like today.
    - Extend `buildTransactionSchema` with the two optional fields. Reconciled-edit warning keeps comparing account-currency `amount` (unchanged).
    - Sticky entry currency: mirror the remembered-date pattern in `frontend/src/lib/lastTransactionDate.ts` (sessionStorage JSON `{value, savedAt}`, 1-hour expiry). New module `frontend/src/lib/lastTransactionCurrency.ts` with `getRememberedTransactionCurrency()` / `rememberTransactionCurrency(code)` under key `monize-last-transaction-currency`. On new-transaction init (not edit/duplicate), seed `entryCurrency` from the remembered code -- treated as no-op when it equals the selected account's currency. After a successful create, remember the entry currency used ('' when the account currency was used, which clears the stickiness), at the same call site where `rememberTransactionDate` is invoked. Unit-test alongside `lastTransactionDate.test.ts`.
17. `SplitEditor.tsx`: `SplitRow.isFxFee`; fee rows render as static text with an "auto" badge, no delete button, excluded from distribute/remaining targets; `toSplitRows`/`toCreateSplitData` round-trip `isFxFee`; optional `displayCurrencyCode`/`displayRate` props for the toggle.
18. `AccountForm.tsx` (+ `buildAccountSchema`): "Foreign Currency Conversion Fee" block under the Currency select (~line 693): percent `Input` (step 0.01, % suffix) + category `Combobox` (`valueIsId`, inline create cloned from `handleAssetCategoryCreate`, 'Parent: Child' supported). Zod refinement: percent set => category required. Add fields to both `defaultValues` branches and `AccountFormModal` submit cleaning.
19. Transaction list FX visibility (in-scope reporting, v1):
    - `TransactionRow.tsx`: when `originalCurrencyCode` set, show the original amount as small secondary text in the amount cell (e.g. "EUR 100.00").
    - `TransactionFilterPanel.tsx` + `useTransactionFilters.ts` + `page.tsx`: "Currency" `MultiSelect` filter (options = currencies actually present on the user's transactions or active currencies) -> `originalCurrencyCodes` param. A dedicated spending-by-currency report is deferred.
20. Frontend i18n (English only during development) -- `en/transactions.json`: `form.currencyPicker.*`, `form.fx.*` (convertedAmount, rateCaption, noRateWarning, usingLatestRateHint, feeSplitMemo, feeAutoBadge, displayToggle.account/original), `form.toasts.fxRateRequired`, `filters.currency`; `en/accounts.json`: `form.fields.fxFeePercent`, `form.fields.fxFeeCategory`, help + validation keys. Regenerate pseudo: `npm run i18n:pseudo` (both apps). Full locale pass only at acceptance (final commit).

## Phase 4 -- Tests

- Backend (Jest): `transactions.service.spec.ts` (persist/strip/validate FX fields; balance uses `amount` not `originalAmount`; update sets and clears), `transaction-split.service.spec.ts` (isFxFee persisted; more than one fee split rejected; non-category fee rejected), `currencies.controller` rate endpoint (rate, null, bad date/code), `accounts.service.spec.ts` (fee fields; percent-without-category rejected; category ownership), findAll `originalCurrencyCodes` filter.
- Frontend (Vitest): `CurrencyPickerButton.test.tsx` (list, select, add-currency modal); `TransactionForm` tests with mocked `getRateForDate` (rate fetch + converted base; auto split with read-only fee; recompute on amount change; override sets effective rate; revert collapses to normal; submit payload correct); `SplitEditor` fee-row read-only/not-deletable/excluded-from-distribute; `AccountForm` fee fields round-trip + validation; `lastTransactionCurrency` unit tests; i18n parity after pseudo regen.
- Manual/e2e verification: run `docker compose -f docker-compose.dev.yml up`; create EUR expense on CAD account with 2.5% fee end-to-end (check split amounts, account balance delta = converted total); edit and toggle home/original display; change date -> rate refetch; unknown-pair currency (null-rate path, manual base entry); foreign refund (positive amount, fee still negative); sticky currency carried into the next new transaction and expiring after an hour; currency filter + row secondary display in the list; MCP `list_transactions` shows original fields.

## Sequencing

DB (1-3) -> backend (4-12, deployable alone since all fields optional) -> frontend (13-20) -> tests alongside each step.

## Deferred (explicitly out of v1)

Imports (QIF/CSV), scheduled transactions, AI/MCP creating foreign-entered transactions, per-split foreign amounts / foreign entry inside split rows, bulk edit of FX fields, dedicated spending-by-currency report.
