# Spec: money stored at eight decimal places, rounded per currency

Status: approved for implementation on `claude/crypto-account-currency`
(follows `docs/specs/crypto-accounts.md`, whose decision 4 this supersedes).
Governs: the scale of every money column, the per-currency money precision,
the rounding and summing helpers in both layers, the currency `decimal_places`
ceiling, and the amount validation on every account-currency write.

Read `docs/financial-semantics.md` section 4 ("Precision by field"),
`docs/financial-calculation-contract.md` sections 1 and 7, and
`docs/database-migrations.md` ("Expand now, contract in a later release")
before changing anything here.

## 1. Goal

A cryptocurrency wallet keeps satoshi-level amounts: a 2,500-sat network fee
is `0.00002500` BTC, not zero. Bitcoin carries 8 places, most coins 8 or more;
Monize carries up to 8. Every fiat currency keeps behaving exactly as today:
the same accepted inputs, the same rounding, the same stored values, the same
display. Nothing a fiat user does changes.

## 2. What exists

- Money is `NUMERIC(20,4)` (two columns of `loan_scenarios` spell it `DECIMAL(20,4)`)
  on 55 columns across 26 tables (`database/schema.sql`),
  mirrored by `@Column({ precision: 20, scale: 4 })` on the entities and held
  together by `backend/src/entity-decimal-precision.spec.ts`.
- `MONEY_DECIMALS = 4`, `roundMoney`, `sumMoney` (integer ten-thousandths),
  `toMoneyNumber` in `backend/src/common/round.util.ts`; the same names in
  `frontend/src/lib/format.ts`, plus `entryDecimalPlaces`, `roundToEntryPlaces`,
  `awaitsRegisteredPlaces`, `loadedEntryAmount` and the currency decimals
  registry (`frontend/src/lib/currency-decimals.ts`, bounded to 0..4).
- Amount DTO fields carry `@IsNumber({ maxDecimalPlaces: 4 })` (73 sites);
  `CreateCurrencyDto.decimalPlaces` is `@Max(4)`; the backup restore clamps
  `decimal_places` to 0..4.
- Converting an amount between currencies is `applyFxConversion`, which rounds
  the result to money precision; a cross-currency transfer without a stated
  received amount is converted that way (`resolveTransferFx`,
  `resolveSplitTransferAmount`).
- `migration:lint` refuses `ALTER COLUMN ... TYPE` without a
  `-- contract-after: X.Y.Z` marker; the four earlier widenings are in a
  shrink-only grandfather list. Changing a numeric scale rewrites the table
  under an access-exclusive lock (`116_unit_prices_precision.sql` header).

## 3. Decisions

1. **Storage is `NUMERIC(24,8)` on every money column an account currency
   can reach.** Scale 8 is the ceiling a currency may use; precision 24 keeps
   the 16 integer digits the columns have today, so no existing value can be
   rejected. One migration widens 50 columns in 23 tables; the five columns
   of the three shared-expense tables stay at `NUMERIC(20,4)` because that
   subsystem is fiat by construction (section 10) and the 1.20.0 release
   parses its rows with a strict four-place reader, which an eight-place
   string would break for the length of a rollout. It and re-creates any function or view that names the
   old type; it carries `-- contract-after: 1.21.0` because the lint reads a
   type change as a contract, with a header stating that the 1.20.0 release
   reads and writes every widened table unchanged (a 4-place value is an
   8-place value, and no 1.20.0 reader of those tables parses the scale) and that the rewrite locks each table, `transactions` the longest.
   Rejected: `NUMERIC(20,8)`, which drops the integer part to 12 digits and
   could reject an existing IDR or VND balance.
2. **A currency's money precision is `max(4, decimal_places)`.** A fiat
   currency (0 to 3 places) keeps the 4 it has always been stored and rounded
   at, including the sub-cent results of an FX conversion, so every fiat path
   is byte-identical. A coin with `decimal_places` 8 is stored and rounded at
   8; one with 6 at 6. `currencies.decimal_places` is capped at 8 (DTO
   `@Max(8)`, a `CHECK (decimal_places BETWEEN 0 AND 8)` every existing row
   satisfies, the restore clamp 0..8, the form's input). A CRYPTO currency
   defaults to 8. The helper is `moneyDecimalsFor(decimalPlaces)` in both
   layers; nothing re-spells the `max`.
3. **`roundMoney` and `sumMoney` take the precision; fiat callers pass
   nothing.** `roundMoney(value, decimals = FIAT_MONEY_DECIMALS)` and
   `sumMoney(values, decimals = FIAT_MONEY_DECIMALS)` keep every existing
   caller unchanged. A caller on an account-currency path passes
   `moneyDecimalsFor(currency.decimalPlaces)`: transactions, transfers,
   splits, scheduled transactions and their posting, reconciliation, the
   balance recompute, the per-account figures of net worth and the account
   balances report before conversion, exports, the demo seed. Figures in the
   reporting currency stay at 4, because a coin is never the reporting
   currency (crypto spec decision 11). Loan, mortgage, credit, bond and
   security figures are fiat by INV-CRYPTO-001 and stay at 4.
4. **`sumMoney` is exact at 8 places.** Integer arithmetic in doubles
   overflows 2^53 at 8 places for amounts above about 90 million, so the sum
   accumulates in `BigInt` from each value's decimal string (the shift is
   decimal, never a float multiply) and divides once. Both layers. Rejected: a
   per-precision float scale, which is exact only while amounts stay small.
5. **Converting into a currency rounds at that currency's precision.**
   `applyFxConversion(amount, rate, toDecimals = FIAT_MONEY_DECIMALS)`; the
   transfer and split-transfer conversions pass the target currency's money
   precision, so 1,700 CAD into BTC at `0.0000073529` is `0.01249993` BTC, not
   `0.0125`. A stated received amount is stored as given at its own currency's
   precision (INV-SPLITFX-001 unchanged).
6. **An amount with more places than its currency allows is refused, not
   rounded.** DTO amount fields accept up to 8 places syntactically; the
   service refuses an amount whose places exceed the account currency's money
   precision (`errors.transactions.amountPrecisionExceeded`, naming the
   currency and its places) inside the write transaction, on every writer of
   an account-currency amount (create, update, bulk, split lines, transfers,
   scheduled, posting, rules, imports, AI and MCP actions, bank sync). A fiat
   amount at 5 places is refused today by the DTO and stays refused. Rejected:
   silently rounding, because a figure the user typed would then differ from
   what was stored, and because 4-place fiat inputs are the only ones ever
   accepted today.
7. **The client enters an amount at its currency's precision.** The registry
   bound becomes 0..8; `entryDecimalPlaces` is the registered places, else
   `MONEY_SCALE` (8) for a non-ISO code not yet registered, else 2;
   `roundMoney` on the client mirrors the server's signature; `CurrencyInput`
   handles up to 8 places; formatters show a coin at its registered places
   (`Intl` accepts fraction digits to 20). Fiat rendering is unchanged.
8. **Exchange rates are untouched.** `NUMERIC(20,10)`, `roundFxRate`, the
   canonical orientation and the implied rate of a stated received amount
   (`roundFxRate(received / |amount|)`) all stay as they are.
9. **Rolling deployment.** While 1.20.0 pods serve beside 1.21.0, they write
   4-place values into 8-place columns (valid) and round an 8-place coin row to
   4 on some read paths (cosmetic, gone when the rollout completes). The
   shared-expense tables are not widened. One transient effect is accepted:
   a 1.20.0 pod's shared-expense bank booking reads `transactions.amount` and
   `transaction_splits.amount` through its strict four-place parser, so for
   the length of a multi-replica rollout that one action can answer "Enter a
   valid amount at the supported currency precision"; group reads, balances
   and journals are unaffected, nothing is written wrongly, and a
   single-replica install never sees it. Rejected: a two-release path (a
   tolerant reader first, the widening a release later), because the whole
   point of this change is the widening and the affected action is a retry
   away. No
   contract step follows; the widened type is the final shape.

## 4. Invariants

- **INV-MONEY-001 (precision is the currency's).** An amount in an account's
  currency is stored at `moneyDecimalsFor(currency.decimal_places)` places,
  never more, never rounded to fewer: a write with more places is refused;
  rounding on a derived figure (a conversion, a sum, a delta) is at that
  precision. Mechanism: `assertAmountPrecision` on every writer,
  `roundMoney(x, decimals)` and `applyFxConversion(..., toDecimals)` at the
  derivation sites; `sumMoney` exactness by construction. Status: `enforced`
  for the writers listed in `docs/system-invariants.md`, with the source
  guard `money-precision.guard.spec.ts` failing a bare `roundMoney(` or
  `sumMoney(` in a file on the account-currency paths it lists.
- **INV-FX-001 and INV-SPLITFX-001 unchanged** in meaning; their examples
  gain a coin row.

## 5. Truth table

| Currency | decimal_places | money precision | input 12.345 | input 0.00002500 | 0.1 + 0.2 summed |
|---|---|---|---|---|---|
| CAD | 2 | 4 | accepted (3 places), stored 12.3450 | refused (8 > 4) | 0.3000 |
| JPY | 0 | 4 | accepted, stored 12.3450 (as today) | refused | 0.3000 |
| BHD | 3 | 4 | accepted | refused | 0.3000 |
| BTC | 8 | 8 | accepted, stored 12.34500000 | accepted, stored 0.00002500 | 0.30000000 |
| coin at 6 | 6 | 6 | accepted | accepted (trailing zeros are not precision; `0.00002501` is refused) | 0.300000 |

## 6. Numerical examples

| Case | Figures |
|---|---|
| Network fee | wallet split total `-0.00502500` BTC: transfer line `-0.00500000` to Primary Chequing (received 650.00 CAD stated, implied rate `130000.0000000000`), fee line `-0.00002500` to Fees: Network fee |
| Buy from chequing, no received amount stated | `-1700.00` CAD at `BTC->CAD 136000.1234567890`: received `roundToDecimals(1700 / 136000.1234567890, 8) = 0.01249999` BTC |
| Same, received amount stated | `0.01249993` BTC stored as given; implied rate `roundFxRate(0.01249993 / 1700) = 0.0000073529` |
| Fiat conversion | `100.00` USD at `1.3652` into CAD is `136.5200`, as today |
| Exact sum | `sumMoney([20999999.99999999, 0.00000001], 8) = 21000000.00000000`; the float form would be off by 1e-8 or more |
| Overflow guard | `sumMoney` of 1e9 units at 8 places needs 1e17 integer units, beyond 2^53; `BigInt` carries it exactly |
| Legacy row | a CAD balance `5420.5000` reads back as `5420.50000000`; `Number()` gives the same double, `roundMoney` at 4 gives `5420.5` |

## 7. Missing data and failure policy

- A currency row with `decimal_places` null or absent reads as 2 (the column
  default); its money precision is 4.
- The client before the registry loads: an unregistered non-ISO code is
  entered at 8 places (lossless), an ISO code at 2.
- A refused precision names the currency and its places and where to change
  them (the Currencies page), per `docs/financial-calculation-contract.md`
  section 1.3.

## 8. Test matrix

| Claim | Kind | Where |
|---|---|---|
| migration widens the 50 money columns idempotently; `schema.sql` matches; entity precision matches schema | `migration:lint`, `verify-schema.sh`, `entity-decimal-precision.spec.ts` | CI |
| `roundMoney`/`sumMoney`/`toMoneyNumber` default to 4 and honour 8; `sumMoney` exact above 2^53/1e8 | unit | `round.util.spec.ts`, `format.test.ts` |
| truth table of section 5 on create, update, split lines, transfer, scheduled, post | integration | `money-precision.integration.spec.ts` |
| conversion into a coin rounds at 8 (`resolveTransferFx`, `resolveSplitTransferAmount`) | unit + the split received-amount suite | existing specs, new cases |
| every writer refuses a precision breach (bulk, AI, MCP, rules, import, bank sync) | unit per path | the path's spec |
| a fiat amount at 5 places is still refused | unit | transactions DTO/service specs |
| currency `decimal_places` 9 refused, 8 accepted; restore clamps to 8 | unit | currencies DTO spec, `restore-currencies.spec.ts` |
| client: `CurrencyInput` at 8 places round-trips `0.00002500`; formatters show 8 places for a registered coin; fiat byte-identical | unit | `CurrencyInput.test.tsx`, `useNumberFormat` tests |
| source guard: no bare `roundMoney(`/`sumMoney(` on the listed account-currency paths | guard | `money-precision.guard.spec.ts` |
| docs name `decimal(24,8)` and the per-currency rule; website pages say eight places | `docs:check`, `doc-paths` | CI |

## 9. Documentation

`AGENTS.md` "Financial math" first sentence; `docs/financial-semantics.md`
section 4 table and the crypto subsection's precision bullet;
`docs/financial-calculation-contract.md` where it says 4dp; `docs/specs/crypto-accounts.md`
decision 4 (superseded, pointing here) and section 6; `docs/system-invariants.md`
(INV-MONEY-001); `website/docs/accounts.md` and `currency-management.md`
precision paragraphs; `website/docs/investments.md` where it says four;
`frontend/CLAUDE.md` and `docs/frontend/forms-and-formatting.md` registry
paragraph; the demo seed and screenshots (`currencies-page`,
`currency-form-crypto`, `crypto-transfer-fee-split`, `account-crypto-detail`).

## 10. Scope cuts and fiat-only subsystems

Precision beyond 8 (wei, 18 places); widening currency codes beyond three
letters; changing fiat rounding from 4 to the currency's own places; a
contract step dropping the old scale (none exists: widening is the final
shape).

Subsystems that stay at four places because they hold fiat by construction,
each with the guard that keeps a coin out: shared expenses (`shared-money.ts`
BigInt scale 10,000; a shared group's currency must be `FIAT`, refused
otherwise), email receipts (merchant receipts, `MONEY_UNITS` 10,000), payroll
deduction rules (a bill's account; a `CRYPTO` bill account is refused on the
rule), warranties' purchase price (its own fiat `currency_code`), loans,
mortgages, credit, bonds, securities and investment cash (INV-CRYPTO-001),
budgets and every reporting-currency figure (a coin is never the reporting
currency). Their columns are widened with the rest for one storage shape, except the
three shared-expense tables (decision 1); their arithmetic passes nothing and
keeps 4.
