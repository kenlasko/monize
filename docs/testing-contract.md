# Testing Contract: canonical adversarial inputs

A shared vocabulary of inputs that have broken this codebase before, so that a
test author picks from a list instead of inventing edge cases from memory and
missing the ones that matter.

**Tests should share a canonical vocabulary of adversarial inputs, but not
every test should use every input.** Using 29 February in a function that never
interprets a date is coverage theatre: it costs a line, proves nothing, and
makes the suite look more thorough than it is. Pick the classes that apply,
skip the ones that do not, and say which you skipped when you are documenting a
matrix.

For a changed formula, parser, validator, date calculation, asynchronous state
machine, or persistence command:

1. select every input class below that the code can actually receive;
2. test at least one representative of each selected class;
3. record the rest as `N/A` when writing out a larger matrix, so a reader can
   tell "considered and irrelevant" from "not considered";
4. include at least one adversarial **combination**, not only isolated
   single-field edges.

Related contracts: `docs/financial-calculation-contract.md` (what a calculation
may claim, and its testing requirements), `docs/time-series-contract.md` (the
time dimension).

## Dates and timestamps

| Name | Canonical value | Intended failure |
| --- | --- | --- |
| Ordinary date | `2026-06-15` | Normal control case |
| Leap day | `2024-02-29` | Leap-year handling |
| Century leap day | `2000-02-29` | Century divisible by 400 is a leap year |
| Non-leap century boundary | `2100-02-28` | Treating every year divisible by 4 as leap |
| Invalid non-leap date | `2100-02-29` | Validation must reject, or normalize only by explicit contract |
| Month end | `2025-01-31` | Month addition and clamping |
| Year end | `2025-12-31` | Year rollover |
| Quarter end | `2025-03-31` | Period-boundary logic |
| Far past supported date | `1970-01-01` | Hidden assumptions that data is recent |
| Far future supported date | `2099-12-31` | Two-digit years, short horizons |
| DST spring boundary | `2025-03-30T01:30:00 Europe/Warsaw` | Local time that does not exist |
| DST autumn boundary | `2025-10-26T02:30:00 Europe/Warsaw` | Local time that happens twice |

- Date-only financial calculations should use the repository's UTC/date-only
  helpers; the DST rows apply to timestamp or local-time logic, and are `N/A`
  for a function that only ever sees `YYYY-MM-DD`.
- Test an invalid date **through the real parser or validator**. Constructing a
  JavaScript `Date` from `2100-02-29` yields an already-normalized 1 March and
  tests nothing: the question is what the boundary does with the string.
- The supported range is whatever the product contract says. `1970-01-01` and
  `2099-12-31` are stand-ins for "older and newer than anyone thought about",
  not limits in themselves.

## Numbers and money

Money is `NUMERIC(24,8)`, rounded at the currency's precision (four places for a fiat currency, up to eight for a coin; INV-MONEY-001); the values below are chosen against those precisions.

| Name | Canonical value | Intended failure |
| --- | ---: | --- |
| Zero | `0` | Known zero versus unknown |
| Negative | `-1` | Sign handling |
| Smallest stored positive unit, fiat | `0.0001` | Precision floor |
| Smallest stored positive unit, 8-place coin | `0.00000001` | Precision floor of a coin; a fee of `0.00002500` BTC must not round to zero |
| One place past the currency | `0.00001` for fiat, `0.000000001` for an 8-place coin | `errors.transactions.amountPrecisionExceeded`, never a silent round |
| Half-rounding boundary (fiat) | `0.00005` | Whether the rounding policy is stated or accidental |
| Binary floating-point pair | `0.1` and `0.2` | Floating-point accumulation |
| Ordinary decimal | `1234.5678` | Normal precision |
| Large valid decimal | `9999999999999999.99999999` | The upper shape of `NUMERIC(24,8)` (the shared-expense tables stop at `NUMERIC(20,4)`) |
| Just-over-limit decimal | `10000000000000000.00000000` | Overflow or validation rejection |
| Percentage boundary | `100` | Inclusive upper bound |
| Above the percentage boundary | `100.0001` | Validation where a percentage is capped |
| Null | `null` | Unknown value |
| Missing property | omitted | Absent versus explicit `null` |

A value the API domain forbids does not need a calculation test -- it needs a
test proving the **real validation path** rejects it. Hand-constructing an
object past the DTO pipeline and asserting the formula copes is the wrong
question.

## Collections and aggregation

Where applicable: empty; one item; two items; many items; a duplicate; all
components known; **one component unknown**; several unknown; all unknown; the
same item held across multiple accounts; mixed positive and negative values.

The one-unknown case is **mandatory** for any field named `total*`,
`portfolioValue`, `transferValue`, `gain`, `loss`, `tax`, `costBasis`,
`estimated*`, or any percentage or allocation over an aggregate denominator.
That is the case the missing-value rule exists for, and the one a naive
implementation passes by filtering the unknown away.

## Currency conversion

Where applicable: same currency; a direct rate; an inverse rate; a missing
rate; a stale rate; **historical transaction rates versus a current valuation
rate**; a zero or negative rate rejected; several currencies where one
conversion is unknown.

The pair that produces a plausible and wrong answer:

```text
10 units bought at 100 USD, historical USD/PLN 3.00  -> cost 3,000 PLN
10 units worth 100 USD today, current USD/PLN 4.00   -> value 4,000 PLN

Correct:  gain 1,000 PLN, tax at 19% = 190 PLN
Current FX applied to the historical cost:
          cost 4,000 PLN, gain 0, tax 0
```

Both sides move with the currency, so an unchanged foreign price reports no
gain at all. Nothing about the output looks wrong.

## Identifiers and ownership

Where applicable: a valid owned id; a syntactically invalid id; a well-formed
but unknown id; a valid id owned by **another user**; an id of the right shape
but the wrong entity type; a stale or deleted id.

## Asynchronous and concurrent operations

Where applicable: duplicate concurrent requests; out-of-order responses; a
stale revision; the loser of an `ON CONFLICT DO NOTHING` race; a rejection
arriving after a competing state change; a retry after a transient failure; an
idempotent repeat; a mutation response landing after the selection changed.

The last two rows connect to the rules they exist for: rejection ordering in
`docs/financial-calculation-contract.md` section 7, and request-key ownership
in `docs/frontend/api-and-cache.md`.

## Strings and optional fields

Where applicable: empty string; whitespace only; ordinary Unicode; combining
characters; the maximum accepted length; one character over it; HTML or
script-like input **through the real sanitizer**; optional `undefined`;
optional `null`; optional empty string, which is what a form actually sends for
a field the user left alone.

## Combinations

Single-axis cases are not enough. A calculation with more than one dimension
needs at least one pairwise adversarial combination -- the defects that survive
review are usually the product of two ordinary conditions, each individually
handled:

```text
foreign currency + missing cost basis
leap day + month-end recurrence
stale response + dirty form
two accounts + same security + one missing price
negative value + currency conversion
duplicate concurrent request + rejected ownership check
```

An exhaustive Cartesian product is not wanted; one deliberate pair per
calculation is.

## Fixtures and shared constants

The intended follow-up is a small set of named constants, so the value and the
reason travel together:

```ts
TEST_DATES.LEAP_DAY;
TEST_DATES.MONTH_END;
TEST_MONEY.ZERO;
TEST_MONEY.ROUNDING_HALF;
TEST_MONEY.MAX_DECIMAL_20_4;
```

They do not exist yet, and this document adds no code. When they arrive they
must be immutable; named for the property under test rather than the literal;
free of hidden expected results, so a factory never quietly decides the
assertion; incapable of constructing a shape production cannot produce; and
faithful to the real collaborator's return types.

Prefer a builder that starts from a valid production-shaped object and makes
**one explicit mutation** for the case at hand. One universal fixture that
every test copies is how a suite comes to exercise a single input shape many
times over.

## Negative control

For each new invariant, record -- in the change description or beside the test:

```text
Invariant:
Canonical adversarial input:
Minimal mutation that recreates the defect:
Test that fails under that mutation:
```

Worked example:

```text
Invariant: a rejected cross-scenario command commits no state.
Input:     signal belonging to A, request naming B.
Mutation:  move the strategy validation to after repository.save().
Failure:   the rejection test reloads the row and finds executed = true.
```

This is a note, not a framework. No permanent mutation-testing infrastructure
is required -- the point is that you performed the check once and wrote down
what it proved.
