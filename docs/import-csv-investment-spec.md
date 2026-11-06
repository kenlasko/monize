# CSV Import: Investment Transactions -- Specification

Status: approved for implementation. This spec precedes the implementation per
the financial-feature rule in `AGENTS.md`; the truth tables below are
the contract the parser tests assert.

## Problem

The CSV import wizard only produces regular banking transactions. The parser
(`backend/src/import/csv-parser.ts`) hardcodes every row's investment fields to
empty and reports `accountType: "CHEQUING"`, so the shared commit path never
routes to `ImportInvestmentProcessorService`, and a CSV targeting an
`INVESTMENT_BROKERAGE` account is rejected outright. Brokerage CSV exports
(buys, sells, dividends, reinvestments, cash movements) cannot be imported.

## Approach

Teach `parseCsv` to emit the same `QifParseResult` shape the QIF investment
path already produces. In investment mode the parser populates
`QifTransaction.security/action/price/quantity/commission` with the canonical
QIF action codes `ImportInvestmentProcessorService` already understands,
returns `accountType: "INVESTMENT"` and a `securities[]` list, and the entire
existing commit pipeline (security mapping step, `createSecurities`, holdings,
cash legs, post-processing) is reused. The processor gains exactly two new
action codes (`addshares`, `removeshares`); nothing else about the commit path
changes.

## Invariants

1. **`investmentMode` absent or false leaves the parser byte-identical to its
   previous behaviour.** Locked by a regression test that deep-equals output
   on a fixture.
2. **The parser only emits action codes it resolved.** The processor's
   `actionMap` falls back to `BUY` for unknown codes
   (`import-investment-processor.service.ts`); the parser must never let an
   unresolved value reach it. Unknown actions fall back to *cash* (below),
   never to BUY.
3. **No money value is defaulted to keep a formula running.** A missing price
   is `null` (unknown), never `0`. A row whose cost or proceeds cannot be
   established is rejected and reported, not imported with invented numbers.
4. **Direction is carried by the action, not the sign.** Quantity, price and
   commission are `abs()`'d on parse; a negative quantity on a SELL row means
   the same as a positive one.
5. **Rejected rows are absent from `transactions[]`** so the
   imported/skipped/errors accounting stays truthful, and each rejection is
   reported in `investmentSummary.rejectedRows` at parse (preview) time and
   recorded among the import result's skipped rows (`rejectedInvestmentRows`,
   one per row, with its reason).
6. **Derived prices round-trip.** When price is derived from the row amount,
   re-deriving the total from the stored quantity/price/commission reproduces
   the file's amount within money rounding (±0.01). Prices are rounded to 10
   decimal places (`NUMERIC(24,10)`), never 4 -- a rate/price is not money.

## Column mapping additions

`CsvColumnMappingConfig` gains (all optional; the three copies in
`backend/src/import/csv-parser.ts`, `backend/src/import/dto/import.dto.ts` and
`frontend/src/lib/import.ts` stay in sync):

| Field | Meaning |
|---|---|
| `investmentMode` | Enables everything below; persisted in saved presets |
| `actionColumn` | Required in investment mode |
| `securityColumn` | Symbol or name; required in investment mode |
| `quantityColumn` | Shares/units |
| `priceColumn` | Per-share price |
| `commissionColumn` | Commission/fees |
| `actionKeywords` | Per-action keyword overrides (see below) |

The existing amount column (or debit/credit pair) supplies the row's total
amount. The sign/type-column machinery (`amountTypeColumn`, `incomeValues`,
`expenseValues`, `transferOutValues`, `transferInValues`, `reverseSign`) and
transfer rules are inert in investment mode and hidden in the UI.

## Action normalization

`normalizeCsvAction(raw, config)` returns one of the canonical actions below or
`null`. Matching is **exact** (after trim + lowercase) -- substring matching
would misfile "sell to cover taxes withheld" as a sell. Priority order:

1. User keyword lists (`config.actionKeywords`). A user list *replaces* the
   default list for that action (same semantics as `incomeValues`).
2. Built-in defaults (`DEFAULT_INVESTMENT_ACTION_KEYWORDS`).
3. The QIF action-code vocabulary (`buy`, `sell`, `div`, `intinc`, `cglong`,
   `cgshort`, `cgmid`, `stksplit`, `shrsin`, `shrsout`, `reinvdiv`, `reinvint`,
   `reinvlg`, `reinvsh`, `reinvmd`, `xin`, `xout`, ...) so Quicken-style CSV
   exports work with no configuration.
4. `null` -- unknown.

Canonical actions and the QIF code the parser emits for each:

| Canonical | Emitted code | Processor maps to |
|---|---|---|
| `buy` | `buy` | `BUY` |
| `sell` | `sell` | `SELL` |
| `dividend` | `div` | `DIVIDEND` |
| `interest` | `intinc` | `INTEREST` |
| `capitalGain` | `cglong` | `CAPITAL_GAIN` |
| `reinvest` | `reinvdiv` | `REINVEST` |
| `split` | `stksplit` | `SPLIT` |
| `transferIn` | `shrsin` | `TRANSFER_IN` |
| `transferOut` | `shrsout` | `TRANSFER_OUT` |
| `addShares` | `addshares` (new) | `ADD_SHARES` |
| `removeShares` | `removeshares` (new) | `REMOVE_SHARES` |
| `cashIn` | `xin` | plain cash transaction on the linked cash account |
| `cashOut` | `xout` | plain cash transaction on the linked cash account |

`xin`/`xout` with no transfer account are booked by
`ImportInvestmentProcessorService.processCashTransfer` as plain cash
transactions on the brokerage's linked `INVESTMENT_CASH` account -- exactly
where brokerage deposits, withdrawals and fees belong. `xout` amounts are
negated by the processor when positive; the parser passes the signed amount
through.

**Unknown-action fallback (user decision):** a row whose action value resolves
to `null` is imported as a cash transaction -- `xin` when the amount is
positive, `xout` when negative -- and the raw action value is reported in
`investmentSummary.cashFallbackValues` so the preview shows exactly which
values fell back. A fallback row with no parseable amount is rejected (there is
nothing truthful to book).

## Missing-data truth table

Q = quantity, P = price, A = |row amount|, C = commission (default 0).
"Unknown" = column unmapped, or cell empty/unparseable. Rules per row:

| Action | Q | P | A | Outcome |
|---|---|---|---|---|
| buy/reinvest | known | known | any | emit; processor computes total = Q*P + C |
| buy/reinvest | known | unknown | known | derive P = round10((A - C) / Q); derived P <= 0 -> treat P as unknown |
| buy/reinvest | known | unknown | unknown | downgrade to `addshares` (price stored as NULL); reported as "uncosted shares" |
| buy/reinvest | unknown | - | - | reject |
| sell | known | known | any | emit; total = Q*P - C |
| sell | known | unknown | known | derive P = round10((A + C) / Q) |
| sell | known | unknown | unknown | **reject** -- downgrading to removeShares would silently drop the cash proceeds |
| dividend/interest/capitalGain | - | - | known | emit with amount A; Q/P passed through when present |
| dividend/interest/capitalGain | - | - | unknown | reject |
| split | known (ratio) | - | - | emit (total 0) |
| split | unknown | - | - | reject |
| transferIn/transferOut/addShares/removeShares | known | optional | - | emit; P is basis for inflows when present |
| transferIn/transferOut/addShares/removeShares | unknown | - | - | reject |
| cashIn/cashOut (incl. unknown-action fallback) | - | - | known | emit `xin`/`xout` with the signed amount |
| cashIn/cashOut | - | - | unknown | reject |

Security cell required for: buy, sell, reinvest, split, transferIn,
transferOut, addShares, removeShares. Rows missing it are rejected. Dividend,
interest and capitalGain may omit the security (the processor books them
without one); when present it is passed through. cashIn/cashOut ignore the
security cell.

`round10(x)` = round half away from zero to 10 decimal places, matching
`NUMERIC(24,10)` price storage. Never `toFixed(4)` -- a price is not money.

## Numerical examples

1. **Derived buy price.** Q=10, A=1004.95, C=4.95 ->
   P = (1004.95 - 4.95) / 10 = 100.0000000000. Processor total =
   10 * 100 + 4.95 = 1004.95 -- reproduces the file amount exactly.
2. **Derived sell price.** Q=3, A=295.05 (proceeds), C=4.95 ->
   P = (295.05 + 4.95) / 3 = 100.0000000000. Processor total =
   3 * 100 - 4.95 = 295.05.
3. **Fractional reinvest.** Q=0.4276, A=45.67, C=0 ->
   P = 45.67 / 0.4276 = 106.8054256314 (10dp). Re-derived total =
   round2(0.4276 * 106.8054256314) = 45.67.
4. **Uncosted inflow.** Q=25, no price, no amount -> `addshares`, price NULL.
   Holdings gain 25 shares; average cost is untouched; nothing pretends to
   know what was paid.

## Parse-result reporting

`QifParseResult` gains an optional field (absent for QIF/OFX and for regular
CSV):

```ts
investmentSummary?: {
  actionCounts: Record<string, number>;   // canonical action -> row count
  cashFallbackValues: string[];           // distinct unknown action values imported as cash
  uncostedShareRows: number;              // buy/reinvest rows downgraded to addshares
  rejectedRows: { reason: string; count: number }[];
};
```

It flows through `ParsedQifResponseDto` to the wizard, and the Review step
renders it -- per-action counts, which values fell back to cash, and what was
rejected and why. This is the user's only chance to catch a keyword miss
before committing; the import result then lists each rejected row by its row
number, date and reason among its skipped rows.

## Mode detection (user decision)

The wizard auto-detects investment mode from headers
(`looksLikeInvestmentCsv`: an action-ish, a security-ish and a quantity-ish
header all present) and pre-fills the investment column matches, with an
explicit Banking/Investment toggle in the column-mapping step as the final
say. The toggle and all investment fields persist in saved mapping presets
(jsonb -- no migration).

## Out of scope (v1, documented deliberately)

- **Duplicate detection for plain rows.** Same pre-existing gap as QIF:
  re-importing the same file doubles positions. Transfer-shaped rows keep the
  existing counting dedupe.
- **Categories on cash-fallback rows.** `processCashTransfer` has no category
  path; fixing that touches QIF behaviour.
- **OFX investment statements** remain unsupported.

## Test matrix

Adversarial inputs drawn from `docs/testing-contract.md` where applicable.

Parser (`csv-parser.spec.ts`):
- `normalizeCsvAction`: defaults, case/whitespace, user list replaces default,
  QIF-code passthrough, unknown -> null.
- One case per truth-table row, including: derived price both directions at
  10dp; derived P <= 0; addshares downgrade stores no price; sell with no
  proceeds rejected; missing security rejected; negative Q/P abs()'d;
  8-decimal quantities; thousands separators and parenthesized amounts in
  quantity/price/commission cells.
- Mixed fixture (buys + sells + dividend + deposit + fee + one bogus action):
  correct codes, bogus value in `cashFallbackValues` booked by sign, counts
  correct, rejected rows absent from `transactions[]`.
- Regression lock: same fixture with `investmentMode` unset deep-equals the
  pre-change output.

Service (`import.service.spec.ts`): `securityMappings` forwarded (fails
against the previous hardcoded `[]`); investment CSV vs non-brokerage account
rejected and the reverse; `investmentSummary` passes through the parse
response.

Processor (`import-investment-processor.service.spec.ts`): `addshares` /
`removeshares` mapping; missing price persists NULL, not 0; `xin` with no
transfer account books one cash `Transaction` on `linkedAccountId` and no
`InvestmentTransaction`.

Frontend: auto-match and `looksLikeInvestmentCsv` positives/negatives; toggle
shows/hides fields and clears sign/type config; securityMappings built and
sent for investment CSVs, untouched (`[]`) for regular; preselected account of
the wrong type does not skip account selection; Review renders the summary and
warnings.

Per the testing contract: after writing each invariant's test, break the
invariant once on purpose (re-hardcode the `[]`, default unknown actions to
`buy`) and confirm the suite goes red.
