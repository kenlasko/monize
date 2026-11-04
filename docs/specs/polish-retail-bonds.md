# Polish Retail Treasury Bonds (TOS, ROR, COI, EDO and four more)

Specification for the implementation of sovereign bond support proposed
in discussion kenlasko/monize#1650: a small generic bond domain, and the Polish
retail savings bonds as its first products (TOS, ROR, COI, EDO, OTS, DOR, ROS
and ROD). Written before the implementation, per
`docs/financial-calculation-contract.md` section 9. The engine's own
specification (architecture, adapter contract, follow-ups) is
`docs/specs/sovereign-bonds.md`; how to add another country is
`docs/backend/bond-adapters.md`.

Every product rule below is taken from the issue letters (*listy emisyjne*) of
the Minister of Finance for the October 2026 series, and each rule names its
paragraph. A rule that the letters do not state is marked **assumption** and
is listed in section 10.

| Series | Letter | Product |
| --- | --- | --- |
| `TOS1029` | List emisyjny nr 97/2026 of 21 September 2026 | 3-year, fixed rate, compounded |
| `ROR1027` | List emisyjny nr 95/2026 of 21 September 2026 | 1-year, NBP reference rate, monthly coupons |
| `COI1030` | List emisyjny nr 98/2026 of 21 September 2026 | 4-year, CPI-linked, annual coupons |
| `EDO1036` | List emisyjny nr 99/2026 of 21 September 2026 | 10-year, CPI-linked, compounded |

## Official sources (country code `PL`)

The sources the Polish adapter reads, which `backend/src/bonds/adapters/pl/`
fetches only on a person's action (INV-BOND-008) and which
`adapter-docs.guard.spec.ts` requires this document to name:

| Source | What it is | Address |
| --- | --- | --- |
| obligacjeskarbowe.pl | The Ministry of Finance's retail bond site: the product pages, the series pages and the issue letters (*listy emisyjne*) of every program (OTS, ROR, DOR, TOS, COI, ROS, EDO, ROD) | https://www.obligacjeskarbowe.pl/oferta-obligacji/ |
| NBP | The reference rate (`PL_NBP_REFERENCE`): the archive and the current table of the National Bank of Poland's interest rates | https://static.nbp.pl/dane/stopy/stopy_procentowe_archiwum.xml and https://static.nbp.pl/dane/stopy/stopy_procentowe.xml |
| GUS | The 12-month CPI (`PL_CPI_GUS_YOY`): the landing page of the monthly price indices and the CSV it links, all on stat.gov.pl | https://stat.gov.pl/obszary-tematyczne/ceny-handel/wskazniki-cen/wskazniki-cen-towarow-i-uslug-konsumpcyjnych-pot-inflacja-/miesieczne-wskazniki-cen-towarow-i-uslug-konsumpcyjnych-od-1982-roku/ |

## 1. Scope

In scope (phases 1 to 5 of the plan):

- the country-agnostic bond domain (section 2.0): instrument, versioned
  terms, rate, observation, principal, capitalization, accrual and
  redemption primitives, holding lot, cash flow, valuation;
- a calculation engine in exact decimal arithmetic;
- the Polish adapter: business-day calendar, benchmark definitions and the
  eight product templates (TOS, ROR, COI, EDO, OTS, DOR, ROS, ROD), data under
  `backend/src/bonds/adapters/pl/templates/`; the adapter ships no series
  (spec `bond-program-securities.md` 2.6). The October 2026 series (TOS1029,
  ROR1027, COI1030, EDO1036, OTS0127, DOR1028, ROS1032, ROD1038) are the terms
  documents under `backend/src/bonds/adapters/pl/fixtures/series/`, the
  golden and unit-test fixtures, and enter a deployment only through a fetch
  or a manual entry;
- persistence of programs, instruments, terms versions, announced period rates
  and benchmark series and values in global, country-agnostic tables;
- fetchers for the NBP reference rate and the GUS CPI, run at boot and by a
  lease-guarded cron (section 9), for the benchmarks a stored series reads
  only, and the boot seed of the adapters' programs (no series);
- linking a `securities` row to a bond program (`bond-program-securities.md`),
  lots derived from the user's transactions (each names its series), and a daily
  `bond_engine` price (section 12);
- the read API, the detail view and its i18n (section 13).

Out of scope: a machine-readable source of the Ministry's announced period
rates (they are filled by hand); a curated series catalog (a series is fetched
from the issuer's source or entered by an administrator on the product
template, `bond-series-fetch.md`); a projected value for a future `asOf`;
taxes; the IKE/IKZE fee waiver; the eligibility check of ROS and ROD; other
countries, and the primitives they need (indexed principal, day-count
conventions, market quotes, yields) (discussion section 38). Section 2.0 is
the rule that keeps them addable.

## 2. The model

### 2.0 Country-agnostic engine (binding rule)

The engine is one deterministic cash-flow engine for every country. It is
composed of financial **primitives** (rate rule, observation rule, principal
rule, capitalization, accrual, redemption policy, penalty, rounding), and it
never branches on a country, an issuer, a program or a product code. A
country is an **adapter** (`BondAdapter`, `backend/src/bonds/bond-adapter.ts`):
data (product templates, benchmark definitions) and a business-day calendar,
registered by id. The Polish products in this specification are terms
documents built only from primitives.

Adding a country is: a calendar, benchmark definitions, product templates and
golden tests (`docs/backend/bond-adapters.md`). A new primitive (a new union
member and one engine case) is added only when an instrument has a new
economic construction, for example an inflation-indexed principal
(`INDEX_RATIO`, US TIPS) or a day-count convention (`ACT/365F`, `BUS/252`).
The research note behind this rule is the global sovereign bond study attached
to discussion kenlasko/monize#1650, sections 4 to 6, 11 and 19.

Two rules make this checkable:

- A source-scanning guard (`country-agnostic.guard.spec.ts`) fails when a file
  of the domain or the engine imports an adapter, when a file of the domain,
  the engine or a shared service directly under `backend/src/bonds/` names a
  country, currency, publisher or product literal, and when the domain or the
  engine does number arithmetic (`Number(`, `parseFloat(`, `Math.`) outside the
  calendar-date module.
- The terms parser refuses an unknown primitive with `UNSUPPORTED_PRIMITIVE`
  and the path of the field. An unknown calendar or benchmark id is not a
  parse error: the valuation reports it as missing data.

### 2.1 Instrument and terms

A **bond instrument** is one series (`TOS1029`), identified by
`(issuerCountryCode, issuerCode, seriesCode)`. Its **terms** are what its
issue document says. Terms are stored as an immutable, versioned document:
version 1 is what the document says at issue, and a correction is a new
version, never an edit. A valuation names the terms version it used.

The terms document (`schemaVersion` 1):

```text
instrument      { issuerCountryCode, issuerCode, programCode, seriesCode,
                  currency, marketability: RETAIL_REDEEMABLE, faceValue,
                  issuePrice? }   -- issuePrice only with ZERO_COUPON_DISCOUNT
saleWindow      { from, to } | null
schedule        { anchor: LOT_PURCHASE_DATE, periodMonths, periodCount,
                  rollDay: ANCHOR_DAY_CLAMPED, calendarId }
              | { anchor: ISSUE_DATE, issueDate, maturityDate,
                  periodCount: 1, calendarId }   -- ZERO_COUPON_DISCOUNT only
                -- no Polish manifest uses another anchor (COUPON_DATES:
                -- bond-marketable-primitives.md section 5.1)
accrual         { type: ACTUAL_DAYS_IN_PERIOD }
                -- ACTUAL_ACTUAL_ICMA: bond-marketable-primitives.md section 5.2
principalRule   { type: FIXED_NOMINAL }
rateRule        FIXED | BENCHMARK_PLUS_SPREAD | INFLATION_PLUS_MARGIN_AS_RATE
                | ZERO_COUPON_DISCOUNT   (see 2.2)
capitalization  { type: NONE } | { type: COMPOUND_AT_PERIOD_END,
                                   baseRounding: PER_PERIOD | NONE }
redemption      { type: MATURITY_ONLY }
              | { type: ON_DEMAND, earliestDaysAfterPurchase,
                  latestDaysBeforeMaturity,
                  blackouts: [{ type: RECORD_DAY_BEFORE_COUPON, businessDays,
                                calendarId }],
                  penalties: [{ type: FIXED_FEE_PER_UNIT, amount }
                            | { type: FORFEIT_ACCRUED_SINCE_LAST_PAYMENT }],
                  proceedsFloor: { type: FACE_VALUE,
                                   appliesTo: ALL_PERIODS | FIRST_PERIOD } | null }
rounding        { moneyDecimals: 0..4, mode: HALF_UP | HALF_EVEN | DOWN }
                -- every Polish manifest uses 2 and HALF_UP, and names no
                -- basis (PER_UNIT: bond-marketable-primitives.md section 4)
source          { provider, url, document }
```

Extension points the engine dispatches on (each a switch with `assertNever`,
so a new member fails to compile until it has its case): `schedule.anchor`,
`principalRule` (the principal is read through
`principalAt(terms, { date })`, the place an index ratio or an amortization
schedule will be passed), `accrual.type` (read through
`yearFraction(terms, period, from, to)`), `rateRule.type`,
`capitalization.type`, the penalties and `rounding.mode`. The rate's reset
frequency is the schedule's `periodMonths`: every period gets its own rate.

Every rate and amount is a decimal string, never a JSON number. Rates are
fractions (`"0.0440"` for 4.40%).

The four Polish series in this vocabulary:

| Field | TOS1029 | ROR1027 | COI1030 | EDO1036 |
| --- | --- | --- | --- | --- |
| `periodMonths` x `periodCount` | 12 x 3 | 1 x 12 | 12 x 4 | 12 x 10 |
| `rateRule` | `FIXED` 0.0440 | `BENCHMARK_PLUS_SPREAD` `PL_NBP_REFERENCE`, first 0.0400, spread 0, floor 0 | `INFLATION_PLUS_MARGIN_AS_RATE` `PL_CPI_GUS_YOY`, first 0.0475, margin 0.0150, floor 0 | same, first 0.0535, margin 0.0200, floor 0 |
| `observation` | -- | `STEP_VALUE_ON_NTH_BUSINESS_DAY_BEFORE_START_MONTH`, 10, `PL` | `MONTHLY_VALUE_MONTHS_BEFORE_START`, 2 | same |
| `capitalization` | `COMPOUND_AT_PERIOD_END`, `PER_PERIOD` | `NONE` | `NONE` | `COMPOUND_AT_PERIOD_END`, `NONE` |
| penalty | 1.00 | 0.50 | 2.00 | 3.00 |
| `proceedsFloor.appliesTo` | `ALL_PERIODS` | `FIRST_PERIOD` | `FIRST_PERIOD` | `ALL_PERIODS` |
| blackouts | none | record day, 5 | record day, 5 | none |

`FORFEIT_ACCRUED_SINCE_LAST_PAYMENT` is OTS's penalty: its letter (para 23,
points 3 and 4) pays the face value on early redemption and "no interest is
due". The penalty is the interest accrued since the period start, so the
proceeds are the period's base.

The parser (`parseBondTerms`) also holds the cross-primitive rules that are not
a product's: only a `ZERO_COUPON_DISCOUNT` instrument has an `issuePrice` (above
zero and below the face value), an `ISSUE_DATE` schedule (issue date before the
maturity date) and, then, capitalization `NONE` and redemption `MATURITY_ONLY`;
a record-day blackout needs capitalization `NONE`. No Polish product is a
discount instrument (`bond-redemption-interest.md` section 3).

The other Polish series on sale in October 2026 use the same vocabulary:

| Field | OTS0127 | DOR1028 | ROS1032 | ROD1038 |
| --- | --- | --- | --- | --- |
| `periodMonths` x `periodCount` | 3 x 1 | 1 x 24 | 12 x 6 | 12 x 12 |
| `rateRule` | `FIXED` 0.0200 | `BENCHMARK_PLUS_SPREAD`, first 0.0415, spread 0.0015 | `INFLATION_PLUS_MARGIN_AS_RATE`, first 0.0500, margin 0.0200 | same, first 0.0560, margin 0.0250 |
| `capitalization` | `NONE` | `NONE` | `COMPOUND_AT_PERIOD_END`, `NONE` | `COMPOUND_AT_PERIOD_END`, `NONE` |
| penalties | `FORFEIT_ACCRUED_SINCE_LAST_PAYMENT` | 0.70 | 2.00 | 3.00 |
| `proceedsFloor.appliesTo` | -- | `FIRST_PERIOD` | `ALL_PERIODS` | `ALL_PERIODS` |

ROS and ROD are sold only to holders of the 800+ benefit; eligibility is not
modelled. Letters: OTS nr 94/2026, DOR nr 96/2026, ROS nr 100/2026, ROD nr
101/2026, all of 21 September 2026.

### 2.1.1 One accrual formula

With `F = 12 / periodMonths`, the interest a base `B` accrues in a period at
annual rate `r` after `a` of its `D` days is `B r a / (D F)`. This is the
formula of every Polish letter: ROR annex 2 (`F = 12`), and COI annex 3, TOS
annex 2 and EDO annex 3 (`F = 1`, `D = ACT`). A full-period coupon is
`round(B r / F)` (COI annex 2: `N r`), and the compounded value at maturity is
`round(N prod(1 + r_i / F))`.

### 2.2 Rate rules

| Rule | Products | Rate of period k |
| --- | --- | --- |
| `FIXED` | TOS | `annualRate` for every period (TOS letter, para 14) |
| `BENCHMARK_PLUS_SPREAD` | ROR | k = 1: `firstPeriodRate`; k >= 2: `max(0, NBP) + spread` (ROR letter, para 15, 16, annex 1) |
| `INFLATION_PLUS_MARGIN_AS_RATE` | COI, EDO | k = 1: `firstPeriodRate`; k >= 2: `max(0, CPI) + margin` (COI letter, para 15 to 17; EDO letter, para 15 to 17, annex 1) |
| `ZERO_COUPON_DISCOUNT` | none installed | no rate: the value rises from `issuePrice` to `faceValue` over the one `ISSUE_DATE` period (`bond-redemption-interest.md` section 3) |

Observation rules (generic primitive, then the Polish use of it):

- `STEP_VALUE_ON_NTH_BUSINESS_DAY_BEFORE_START_MONTH` reads a `STEP`
  benchmark (a value in force from its effective date) on the n-th business
  day, in the named calendar, before the first day of the calendar month in
  which the period starts. `MONTHLY_VALUE_MONTHS_BEFORE_START` reads a
  `MONTHLY` benchmark at the reference month `startMonth - months`.
- **NBP** (`PL_NBP_REFERENCE`): the reference rate in force on the 10th
  business day before the first day of the calendar month in which period k
  starts (ROR letter, para 16). A business day excludes Saturdays, Sundays
  and Polish statutory holidays (para 29, 31). The rate in force on a day is the
  newest change effective on or before that day.
- **CPI** (`PL_CPI_GUS_YOY`): the 12-month CPI change announced by GUS in the
  month before the first month of period k (COI and EDO letters, para 16).
  **Assumption:** this is the final figure for the month two months before the
  period starts (a period starting in October uses August). The engine looks
  up the reference month `startMonth - 2`.

**An announced rate wins.** The Ministry announces each period's rate before
the period starts, and "the announced rate does not change" (para 17 / 18).
When an announced rate for (series, period) is stored, the engine uses it.
Otherwise it derives the rate from the stored observation. The valuation says
which (`rateSource`: `TERMS`, `ANNOUNCED`, `DERIVED`, `PROJECTED`).

### 2.3 Periods

Periods are anchored on the purchase date of the lot, not on the series
(EDO para 14: interest accrues "from the day of sale"). Period k starts at
`addMonthsClamped(purchaseDate, (k - 1) * periodMonths)` and ends at
`addMonthsClamped(purchaseDate, k * periodMonths)`, where the day of month is
`min(purchaseDay, daysInMonth)` and is always computed from the purchase
date, never from the previous period end. The ROR letter, annex 3, is the
truth table for this rule (31.10.2026 gives 30.11, 31.12, 31.01, 28.02, 31.03,
30.04). Maturity is the end of the last period.

`ACT` / `D` is the actual number of days in the period, start inclusive, end
exclusive. `a` is the number of days from the period start inclusive to the
calculation day `d` exclusive.

### 2.4 Amounts per bond

All amounts are computed for **one bond** and rounded to 0.01 PLN where the
letter rounds, then multiplied by the lot quantity. Rounding is half-up
(**assumption**: the letters say "rounded to two decimal places" and name no
mode).

| Product | Interest of period k | Value at maturity | Early redemption on day d in period k |
| --- | --- | --- | --- |
| TOS | compounded, not paid | `W = round(N (1+r)^3)` (annex 1) | `WP = round(N_{k-1} (1 + r a / ACT) - b)`, `N_{k-1} = round(N (1+r)^{k-1})`, floor 100 in every period (annex 2) |
| EDO | compounded, not paid | `W = round(N prod(1 + r_i))` (annex 2) | `WP = round(N prod_{i<k}(1 + r_i) (1 + r_k a / ACT) - b)`, no intermediate rounding, floor 100 in every period (annex 3) |
| COI | `O = round(N r_k)`, paid on the period end (annex 2, para 19) | `N` plus the last coupon | `WP = round(N (1 + r a / ACT) - b)`, floor 100 in period 1 only (annex 3) |
| ROR | `O = round(N r a / (D F))`, `F = 12`, paid on the period end (annex 2, para 20) | `N` plus the last coupon | `WP = round(N (1 + r a / (D F)) - b)`, floor 100 in period 1 only (annex 4) |

`b` is the early redemption fee: TOS 1.00, ROR 0.50, COI 2.00, EDO 3.00
(para 24 / 26 of each letter). In TOS and EDO, and in the first period of ROR
and COI, the fee is capped at the accrued interest; the floor of 100 is that
cap. From period 2, ROR and COI deduct the full fee, so the value can be below
the face value.

`capitalization.baseRounding` is `PER_PERIOD` for TOS (annex 2 rounds `N_{k-1}`)
and `NONE` for EDO (annex 3 rounds only the result).

### 2.5 Early redemption window

`redemption.earliestDaysAfterPurchase` is the issuer's number N of calendar
days that must fully elapse after the sale ("after seven calendar days", N = 7
in every Polish template). The sale day is not counted (Civil Code art. 111
par. 2), so the period ends with `purchaseDate + N` and the first request is on
`purchaseDate + N + 1`, the 8th day after the purchase for the Polish products.
The last request is 20 calendar days before maturity
(`latestDaysBeforeMaturity`, para 21 / 23 / 25). ROR and COI also exclude the
record day (the 5th business day before a coupon date). Outside the window
`earlyRedemptionValue` is `null` and `earlyRedemptionRefusal` names the rule
(`TOO_EARLY`, `TOO_LATE`, `RECORD_DAY`, `NOT_REDEEMABLE`, `MATURED`). The engine
values the request as if `d` were the calculation day; the five-business-day
settlement lag (para 26) is out of scope.

### 2.6 Valuation of a lot

Input: the issue, its terms version, the announced rates, the reference
observations, the lot (`purchaseDate`, `quantity`), `asOf`, and an optional
projection assumption (a fraction per benchmark id, `projection`). Output:

```text
asOf, seriesCode, termsVersion, quantity, maturityDate
status             OPEN | MATURED | REFUSED
refusal            { code: PURCHASE_OUTSIDE_SALE_WINDOW,
                     params: { from, to, purchaseDate } } | null
                   -- a lot bought outside terms.saleWindow (null = no
                   restriction) is REFUSED: every figure below is null and
                   valuationComplete is false
currentPeriod      { index, start, end, annualRate | null, rateSource | null }
                   -- always present for an OPEN lot; annualRate and rateSource
                   are null while the period's rate is unknown; null for a
                   MATURED or REFUSED lot
rateRule           the terms' rate rule as stated: type, benchmarkId, the
                   first-period rate, the margin or spread, the benchmark floor
rateSchedule       one entry per period: { index, start, end, annualRate | null,
                   rateSource | null, benchmark: { benchmarkId, observation,
                   value | null, flooredValue | null } | null, addend | null }
                   -- the observation the rule reads for that period, the
                   value found (or assumed, when PROJECTED), the value after
                   the floor, and the margin or spread added to it
principal          per-bond compounded base at the start of the period | null
accruedInterest    lot | null: grossValue - faceValue x quantity, i.e. all
                   capitalized interest plus the current accrual for a
                   compounding bond, and the current period's accrual for a
                   coupon bond
grossValue         lot, principal + accrued interest, no fee | null
earlyRedemptionValue  lot | null, earlyRedemptionRefusal
knownCashflows     [{ date, type: INTEREST | PRINCIPAL, amount, status: KNOWN }]
projectedCashflows [{ ..., status: PROJECTED }]
                   -- a future flow whose amount cannot be computed is
                   emitted with status UNKNOWN and amount null (in the
                   projected list), never dropped; amount is null only for
                   UNKNOWN
maturityValueKnown     | null
maturityValueProjected | null
nextPayment        every cash flow, from both lists and UNKNOWN included, dated
                   on the earliest date after asOf; [] for a matured or
                   refused lot
nextRateReset      start of the next period when the rule reads a benchmark
                   and a next period exists, else null
nextCapitalization end of the current period when the bond compounds and the
                   period is not the last, else null
projectionAssumptions  [{ benchmarkId, value (fraction), basis: SUPPLIED | LATEST_OBSERVATION,
                        observation (YYYY-MM-DD or YYYY-MM; null when SUPPLIED) }]
dataCompleteness   { termsComplete, referenceDataComplete, earlyRedemptionTermsComplete }
missing            [{ benchmarkId, observation (YYYY-MM, or YYYY-MM-DD for a
                   step series), publisher | null }]  what to obtain, and
                   where; publisher is null only when the benchmark itself
                   is absent from the input
projectionMissing  [{ benchmarkId, publisher | null }]  a benchmark a future
                   period needs for which there is neither a stored
                   observation nor a supplied assumption
valuationComplete  all three flags true, and the lot is not REFUSED
```

An early redemption is a figure (`earlyRedemptionValue`), not a cash-flow
type: a redemption that happened is the user's `SELL` or `REDEEM`
transaction, which the lots read (12.2).

A completed period with a missing observation is named in `missing`; a future
period without any basis is named in `projectionMissing`. The security-level
response also carries `benchmarkCoverage: [{ benchmarkId, coveredThrough |
null, lastFetchedAt | null }]` (top level, not per lot), so the card can say
how fresh the reference data is. `asOf` after today is refused with
`AS_OF_IN_FUTURE` (here and on the scenarios endpoint; the date picker's
maximum is today); a future projection is the job of the scenarios (13.3).

## 3. Invariants

- **INV-BOND-001 Issue terms and announced rates are immutable.** A stored
  terms version and a stored announced rate are never updated or deleted; a
  correction is a new terms version. Mechanism: a row-level `BEFORE UPDATE OR
  DELETE` trigger on the terms, the rates, the instruments and the programs that
  raises (an `INSERT ... ON CONFLICT DO NOTHING` never reaches it). `TRUNCATE` is not covered: it is
  a table-owner operation no application path issues, and the integration
  test reset relies on it.
- **INV-BOND-002 A missing rate is unknown, never substituted.** A period that
  has started and whose rate is neither in the terms, announced, nor derivable
  from the stored observation for its own month or day has no rate. The engine
  never uses another month's CPI, the latest NBP rate, 0 or the first-period
  rate in its place; values that depend on it are `null` and every such `null`
  is named in `missing` and makes `valuationComplete` false. A period that has
  not started is `PROJECTED` from a named assumption (supplied, else the
  newest stored observation, section 4), labelled as such, and never `KNOWN`.
- **INV-BOND-003 Money is exact until the letter rounds it.** The engine uses
  exact rational arithmetic (no JavaScript `number` on a money or rate path)
  and rounds only at the points section 2.4 names.
- **INV-BOND-004 Known and projected never mix.** A cash flow is `KNOWN` only
  when every rate it depends on is `TERMS`, `ANNOUNCED` or `DERIVED`.
  `maturityValueKnown` is `null` while any period rate is projected.

INV-BOND-005 to INV-BOND-009 (price, catalog entry, series of a transaction,
nothing without a person, redemption split) are in `docs/system-invariants.md`.

## 4. Truth table: rate of period k

| k | Announced rate stored | Observation stored | Period started (`start <= asOf`) | Rate | `rateSource` | Effect |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | any | any | any | `firstPeriodRate` / `annualRate` | `TERMS` | known |
| >= 2 | yes | any | any | announced | `ANNOUNCED` | known |
| >= 2 | no | yes | any | `max(0, obs) + margin` | `DERIVED` | known |
| >= 2 | no | no | yes | none | -- | values `null`, `referenceDataComplete = false`, `missing` names the observation |
| >= 2 | no | no | no | `max(0, assumption) + margin` | `PROJECTED` | projected; `null` if no assumption is given and no observation exists |

The default projection assumption is the newest stored observation of the
series, and the assumption names it as structured data, never a sentence
(`{ benchmarkId: "PL_CPI_GUS_YOY", value: "0.0290", basis:
"LATEST_OBSERVATION", observation: "2026-08" }`; a supplied assumption has
basis `SUPPLIED` and a null observation). The client composes the sentence from
its translated catalog and formats the percentage by the reader's number
preference.

## 5. Numerical examples

Each line is computed with exact fractions and rounded half-up. The
fixtures copy these values, never the implementation's output.

| # | Case | Inputs | Expected |
| --- | --- | --- | --- |
| E1 | TOS1029 maturity value | r = 4.40% | `N1 = 104.40`, `N2 = 108.99`, `W = 113.79` (equals TOS letter, para 14) |
| E2 | TOS1029 early, period 1 | purchase 2026-10-15, d = 2027-04-15, a = 182, ACT = 365 | `101.19` |
| E3 | TOS1029 early, period 1, below floor | purchase 2026-10-15, d = 2026-10-25, a = 10 | `99.12` -> `100.00` |
| E4 | TOS1029 early, period 2 | d = 2028-01-15, a = 92, ACT = 366 | `104.55` |
| E5 | EDO1036 early, period 1, below floor | purchase 2026-10-01, d = 2027-04-01, a = 182, ACT = 365 | `99.67` -> `100.00` |
| E6 | EDO1036 early, period 2 | r2 = 4.90% (hypothetical), d = 2028-04-01, a = 183, ACT = 366 | `104.93` |
| E7 | EDO1036 maturity | r1 = 5.35%, r2..r10 = 4.90% (hypothetical) | `162.04` |
| E8 | COI1030 coupon, period 1 | r1 = 4.75% | `4.75` |
| E9 | COI1030 early, period 1 | purchase 2026-10-15, d = 2027-01-15, a = 92, ACT = 365 | `99.20` -> `100.00` |
| E10 | COI1030 early, period 2, no floor | r2 = 4.40% (hypothetical), d = 2027-10-16, a = 1, ACT = 366 | `98.01` |
| E11 | ROR1027 coupon, period 1 | purchase 2026-10-31, period to 2026-11-30, D = 30, r = 4.00% | `0.33` |
| E12 | ROR1027 early, period 1 | d = 2026-11-15, a = 15 | `99.67` -> `100.00` |
| E13 | ROR1027 coupon, period 3 | 2026-12-31 to 2027-01-31, D = 31, r = 3.75% (hypothetical) | `0.31` |
| E14 | NBP observation day | period starts in November 2026 | 2026-10-19 |
| E15 | NBP observation day across holidays | period starts in January 2027 (24, 25, 26 Dec are holidays) | 2026-12-16 |
| E16 | Lot | E2 with quantity 25 | `2529.75` |

The golden fixtures of OTS, DOR, ROS and ROD (`backend/src/bonds/adapters/pl/`
`ots-cases.json`, `dor-cases.json`, `ros-cases.json`, `rod-cases.json`) are
not copies of E1 to E16 and were not taken from section 5 or from the
engine's output: each value was computed independently from the formulas of
the issue letters (OTS nr 94/2026, DOR nr 96/2026, ROS nr 100/2026, ROD nr
101/2026) with exact fractions, half-up. The values below are the same
computation, kept here so a fixture edited to match the engine is visible
against the letter formula:

| # | Case | Inputs | Expected |
| --- | --- | --- | --- |
| E17 | OTS0127 coupon and maturity value | purchase 2026-10-15, r = 2.00%, `F = 4` (letter para 14, 17) | coupon `100 x 0.02 / 4 = 0.50`; `W = 100.50` |
| E18 | OTS0127 early redemption | d = 2026-12-01, a = 47 (letter para 23 points 3 and 4) | accrued `0.2554` forfeited, proceeds `100.00` |
| E19 | DOR1028 coupon, period 1 | purchase 2026-10-15, r1 = 4.15%, `F = 12` | `100 x 0.0415 / 12 = 0.3458` -> `0.35` |
| E20 | ROS1032 maturity | r1 = 5.00%, r2..r6 = 3.40% CPI + 2.00% = 5.40% (hypothetical), no intermediate rounding | `136.58` |
| E21 | ROD1038 maturity | r1 = 5.60%, r2..r12 = 3.40% CPI + 2.50% = 5.90% (hypothetical) | `198.39` |
| E22 | Quantity | OTS0127 E18 with quantity 30 | `3000.00` |

The remaining fixture cases (window days 6, 7 and 20 days before maturity,
the DOR record day, early redemption of ROS and ROD) apply the same letter
formulas to the inputs their descriptions state.

## 6. Missing-data policy

- Missing terms version: the read service refuses with a `TERMS_NOT_FOUND`
  error whose `params` name the series. No valuation is produced.
- Errors and refusals reach a client as a code and `params`, never as an
  English sentence; the server maps each code to a translated message. The
  domain codes are `QUANTITY_INVALID`, `DATE_INVALID`, `DECIMAL_INVALID`,
  `AS_OF_BEFORE_PURCHASE`, `BENCHMARK_NOT_READ`, `INSTRUMENT_NOT_FOUND`,
  `INSTRUMENT_ID_NOT_FOUND`, `TERMS_NOT_FOUND` (no version stored),
  `TERMS_VERSION_NOT_FOUND` (the named version is not stored),
  `TERMS_MISMATCH`, `PROGRAM_NOT_FOUND`, `AS_OF_IN_FUTURE`,
  `PURCHASE_OUTSIDE_SALE_WINDOW` (a lot
  refusal, not an error), and the link and undo codes
  `LINK_REQUIRES_BOND_TYPE`, `LINK_QUANTITY_NOT_BONDS` and
  `UNDO_LINK_INVALID` (section 12.1). A lots refusal (`BondLotsRefusal`) is
  `{ code, detail, params: { action, date, quantity } }`; `detail` is for the
  log and is never shown.
- Every `null` figure caused by a missing observation is named in `missing`
  and makes `valuationComplete` false.
- A started period without a rate: section 4. `missing` names the series and
  the observation (`PL_CPI_GUS_YOY 2027-08`, or `PL_NBP_REFERENCE on
  2026-10-19`) and the publisher stored with the benchmark series (GUS, NBP).
- Coverage of a `STEP` benchmark (NBP): a day after the series' `covered_through` date is unknown, even
  if an older rate exists, because a newer change may not be stored yet.
  The fetcher sets `covered_through` to the effective date of the NBP current
  table only when that date is proven; when the current table's effective date
  is not in the archive and the archive's newest change is older than the
  previous current-table date allows (it cannot prove that no decision is
  missing), `covered_through` is the archive's newest date, so later days are
  unknown, not silently derived.
- Freshness of the GUS CPI: the fetcher discovers the CSV link from the GUS
  landing page first and uses its constant URL only as a fallback; a file whose
  newest observation is older than 3 months is refused as a stale feed and is
  a failure. Persistent failures of either fetcher are recorded through
  `ProviderHealthService`, so the existing outage alerts fire.
- CPI: a reference month with no stored row is unknown. A negative value is
  stored as is and floored at 0 in the rate rule only.
- `asOf` before the purchase date: refused (`AS_OF_BEFORE_PURCHASE`).
  `asOf` on or after maturity: the lot is matured and early redemption is
  refused (`MATURED`). A matured coupon (non-compounding) lot has
  `principal = grossValue = faceValue x quantity` and `accruedInterest = 0`; it
  needs no rate, because its last coupon is a past cash flow paid on the
  maturity date and is no longer part of the holding's value
  (`maturityValueKnown` still shows face plus the last coupon, 105.00 for
  COI1030 period 4 at 5.00%, so a coupon lot's daily price falls from its
  accrued level to 100.00 on the maturity day, as it does after every coupon).
  A matured compounding lot has `grossValue = the maturity value` and needs
  every period's rate.

## 7. Persistence

Global reference data with no owner (RLS bucket: exempt, same rationale as
`exchange_rates` and `market_index_prices`):

| Table | Key | Mutability |
| --- | --- | --- |
| `bond_programs` | `id` (UUIDv5 of `issuerCountryCode\|issuerCode\|programCode`); unique `(issuer_country_code, issuer_code, program_code)` | insert only; `bond_reject_mutation()` refuses UPDATE and DELETE (INV-BOND-001) |
| `bond_instruments` | `id` (UUIDv5 of `issuerCountryCode\|issuerCode\|seriesCode`); unique `(issuer_country_code, issuer_code, series_code)`; `bond_program_id` NOT NULL | insert only; `bond_reject_mutation()` also refuses UPDATE and DELETE (INV-BOND-001) |
| `bond_terms_versions` | `(bond_instrument_id, version)`, with `content_hash` | immutable (INV-BOND-001) |
| `bond_period_rates` | `(bond_instrument_id, period_number)` | immutable (INV-BOND-001) |
| `benchmark_series` | `code`; `kind` `STEP` or `MONTHLY`, `publisher`, `unit`, `covered_through` | insert; `covered_through` moves forward |
| `benchmark_values` | `(benchmark_code, observation_date)` | insert, correction by update |

No table names a country or a product: a German, US or Japanese instrument is
a row in the same tables. The Polish data enters through the adapter, never
through the migration.

Rates are `NUMERIC(20,10)` (an exchange-rate-like quantity, not money); the
face value is a decimal string in the terms document. All six tables are
excluded from the user backup: they are reference data a deployment re-fetches.
`securities.bond_program_id` and `investment_transactions.bond_instrument_id`
are `NULL` in the support backup (`docs/support-backup.md`). A lot is not
stored: lots are derived from the user's transactions (section 12.2) and the
engine takes one as input.

## 8. Versioning and recomputation

A valuation is computed on read and is not stored, so there is nothing to
invalidate. A new terms version changes only valuations that ask for it; the
read service uses the newest version unless the caller names one. A new
announced rate or observation changes the next read.

## 9. Concurrency

The writers of the reference tables are `BondCatalogService` (seeds
the adapters' programs at boot, no series and no network, each in its own
transaction with `INSERT ... ON CONFLICT DO NOTHING`; and stores a fetched or
entered series' terms versions with `INSERT ... ON CONFLICT
(bond_instrument_id, version) DO NOTHING`, so a concurrent writer of the same
version inserts nothing and raises nothing, and a stored version whose
`content_hash` differs from the entry's is refused as a conflict; the trigger refuses any UPDATE or DELETE of a
stored row but never fires on an insert; a currency the seed has to create is
created inactive, through a `CurrenciesService` method only the catalog uses
(`ensureCatalogCurrency`, called by the seed and by a series store), so it is
not offered to users) and `BenchmarkRefreshService` (NBP and GUS observations, under
the `bond-benchmarks` lease of `FetchSyncService`, at boot and by cron, only for
the benchmarks the newest terms version of a stored series reads, and once
after a series is stored for a benchmark it reads that was never fetched; the
`benchmark_series` row of a benchmark a series reads is stored with the series,
in the same transaction, so a valuation names the publisher of an observation it
lacks before the first fetch lands; with no stored series nothing is
fetched, spec `bond-program-securities.md` 2.6).
Benchmark freshness at boot is decided by the last successful fetch, not by
`covered_through`, which only records how far the data reaches.

The writer of prices is `BondPriceService` (`FetchSyncJob.BondPrices` lease for
the daily fan-out):

- recomputes of one security are serialized by a transaction-scoped advisory
  lock keyed on the security id, so two recomputes never interleave their
  read, upsert and delete;
- unlinking a security deletes that security's `bond_engine` rows in the same
  transaction as the unlink;
- for a linked security the engine row replaces every non-manual row on its
  days and a manual price always wins, whatever the write order (the engine
  upsert's `WHERE` never admits `source = 'manual'`; a transaction-derived price
  never replaces a `bond_engine` row; engine rows store `adjusted_close`
  `NULL`, and a manual price written over one does not inherit it; section
  12.3);
- creating, editing, voiding or deleting an investment transaction of a linked
  security, and a restore, dispatch the recompute after the commit;
- a provider write re-checks the link at write time, inside its own
  transaction, and drops the price of a security that has become linked;
- a currency referenced by a bond instrument counts as in use, so the currency
  in-use check refuses its deletion.

## 10. Assumptions to confirm

1. Rounding mode is half-up (section 2.4).
2. The CPI used for a period starting in month M is the final figure for
   M - 2 (section 2.2).
3. "After seven calendar days" allows a request on `purchaseDate + 8`
   (section 2.5). Decided 2026-10-11: `purchaseDate + N + 1`, the sale day not
   counted (Civil Code art. 111 par. 2); `earliestDaysAfterPurchase` is the
   letter's N (7).
4. Polish statutory holidays include 24 December from 2025 on.

Each one is to be checked against a rate table or an early redemption
statement published by the Ministry or an issuing agent before the product
values are shown to a user.

Evidence collected on 2026-10-11 (supporting, not a confirmation):

- 1: the issue letters give one product rounded to two decimals
  (`W = N·(1+r1)·…·(1+rk)`), so the compounded base is not rounded per year;
  they name no rounding mode. krbob/edo-calculator rounds half-up at the end;
  31 CFR 359.55 states half-up for US savings bonds.
- 2: the letters take the CPI "announced by GUS in the month preceding the
  first month of the period"; GUS announces month X in X+1, so M-2.
  krbob/edo-calculator and Kaligula0/Finance-Quote-module-Obligacje-Skarbowe
  use M-2.
- 1 and 2, official confirmation: with the real GUS CPI of month M-2 and
  half-up rounding of the per-bond result only, the engine reproduces the
  Ministry's interest table of EDO0524 (47.10, 50.28, 64.28, 72.83) and the
  stated maturity value of EDO0423 (147.05), and the dated examples on the ROR
  and EDO product pages (golden files `edo0524-cases.json`,
  `edo0423-cases.json`, `ror0623-cases.json`). Both assumptions are taken as
  confirmed.
- 3: the letters say "not earlier than after seven calendar days from the sale
  date". Under Civil Code art. 111 §2 the sale day is not counted, which reads
  as a first request on `purchaseDate + 8`. No published dated example was
  found; decided by the owner on 2026-10-11 in favour of the Civil Code reading.
- 4: the letters refer to statutory days off; 24 December is one from 2025
  (Dz.U. 2024 poz. 1965). QuantLib's Polish settlement calendar does not have
  it yet.

## 11. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Exact arithmetic | unit | parse, add, multiply, divide, half-up at `.xx5`, negative values, refusal of a non-decimal string |
| Period schedule | unit | ROR annex 3 rows for purchase days 1, 28, 29, 30, 31; leap year; maturity |
| Business days | unit | E14, E15, Easter-based holidays for 2026 and 2027 |
| Products | golden | E1 to E16 from a JSON fixture per product; for OTS, DOR, ROS and ROD the fixtures are computed from the letters (section 5, E17 to E22) |
| Missing data | unit | each row of section 4; `missing` content; matured coupon lot (principal = grossValue = face x quantity, accrued 0, no rate needed) and matured compounding lot (needs every rate); `asOf` before purchase |
| Error codes | unit | each domain error carries `code` and `params` (section 6), never a sentence; `BondLotsRefusal` has `code`, `detail`, `params` |
| Attribution (13.2) | unit | TOS 4.40 / 4.5936 / 4.79556; EDO period 2 split (E24); `benchmarkPart + addendPart = interest` for every benchmark period; each part `null` when the period's rate, or an earlier rate of a compounding bond, is unknown |
| Scenarios (13.3) | unit | E25: values -0.5 and 1.0 accepted (inclusive), 7 values and 1.0001 refused, a foreign benchmark refused with 400; known periods stay known; every figure `null` with a `refusal` when lots cannot be derived |
| Scenarios (13.3) | integration | route `/scenarios` and `assume=` on valuation, owner-scoped (another user's security answers 404) |
| Chart (13.4) | unit | cumulative interest ends at the rate schedule's total; projected periods flagged; no interest computed in the client |
| Window | unit | day 7 and 8 after purchase, 21 and 20 days before maturity, ROR record day |
| Terms parsing | unit | a valid document per Polish manifest; unknown field, number instead of string, unknown primitive (`UNSUPPORTED_PRIMITIVE`) refused; unknown calendar or benchmark id reported as missing data |
| Country-agnostic engine | guard | no domain or engine file imports an adapter or names a country or product literal (section 2.0) |
| Immutability | integration | update and delete of a terms version, of an announced rate and of an instrument raise; a stored version stored again with differing content is a conflict and changes nothing |
| Sale window, lot status, UNKNOWN flows | unit | a lot outside `saleWindow` is REFUSED with every figure null; MATURED and OPEN `currentPeriod` shape; UNKNOWN cash flow with `amount` null; `projectionMissing` |
| Future `asOf` | unit, integration | valuation and scenarios refuse `asOf` after today (`AS_OF_IN_FUTURE`) |
| Fetchers | unit | GUS link discovery and fallback; a feed older than 3 months refused; NBP `covered_through` when the archive cannot prove coverage; failures recorded through `ProviderHealthService` |
| Price precedence | integration | section 12.3 |
| Lots per account | unit | FIFO per account; paired transfer keeps purchase dates |
| Link validation | unit, integration | BOND type only; unit-quantity check; lowercase UUID; undo; update_security preview |
| Restore, support backup | integration | support backup drops the link; restore reports `{ count, symbols }` and recomputes |
| Read service | integration | loads the newest version, applies announced over derived, names the version |

## 12. Portfolio integration (phase 3)

### 12.1 Link

> A security links to a bond **program** (`securities.bond_program_id`,
> `bond_auto_fetch`) and each share-moving transaction names its **series**
> (`investment_transactions.bond_instrument_id`, INV-BOND-007):
> `docs/specs/bond-program-securities.md`.

A user's `securities` row may point at one bond program through a nullable
`securities.bond_program_id` (`ON DELETE RESTRICT`). The link is checked in
the write's own transaction (`assertBondLink`, shared by the update, the
AI/MCP `update_security` preview and the undo of a security edit) and refused
unless: the program exists; the security's currency equals the program's
currency (INV-PRICE-001: a stored price is in the currency the security is
recorded in; the form blocks a currency change of a linked security instead of
silently unlinking it); the security type is `BOND` (`LINK_REQUIRES_BOND_TYPE`;
changing the type of a linked security away from `BOND` is refused unless the
same request unlinks it); and, when the link is being set, every priced trade of
the security (`BUY`, `SELL`, `REINVEST` and its variants, not void) has a price
within [0.5, 2] x the face value of the series it is read as
(`BOND_UNIT_PRICE_BAND`), because otherwise the quantity is not a number of
bonds (`LINK_QUANTITY_NOT_BONDS`). The id is canonicalized to lowercase before
it is compared or stored, and whether the link changed is decided inside the
transaction from the row locked `FOR UPDATE`. An undo or redo snapshot carries
`bond_program_id` and is applied through the same checks; a restored state that
fails them is refused (`UNDO_LINK_INVALID`). The security form sends
`bondProgramId` only when the link changed. A linked security is never
refreshed from a quote provider: the bond engine is its only automatic price
source (spec section 1 of the discussion: Yahoo and MSN are not a source of
retail bond terms or values).

`bond_programs` is seeded per deployment from the adapters' programs and
`bond_instruments` is reference data excluded from the user backup, stored per
deployment by a fetch or an entry, so the ids are deterministic: a UUIDv5 of
`issuerCountryCode|issuerCode|programCode` for a program and of
`issuerCountryCode|issuerCode|seriesCode` for an instrument. A restored link
therefore points at the same program on any deployment whose catalog has it; a
restore onto a deployment without it restores the link as `NULL` and says so
(`unlinkedBondSecurities: { count, symbols }`, symbols capped at 50, omitted
when zero; the UI lists them and says how to relink), rather than failing the
restore. A backup carries the identity of the series its rows
reference (the `bondCatalog` member: country, issuer, program, series code,
never terms). Before the restore transaction the missing series are fetched
from the official source, paced and capped
(`docs/backup-restore-contract.md` section 3a), and each row is remapped to the
catalog's id by identity. A transaction whose series could not be obtained is
restored without it, counted in `unlinkedBondSeries: { count }`, and the
series are reported in `unrecoveredBondSeries: { count, series: [{
issuerCountryCode, seriesCode, reason }] }`. After a restore commits, every
linked security of the user is recomputed. The support backup always writes the
link and the series as `NULL`.

### 12.2 Lots

> A lot also carries the series of its transaction, and a removal may name one
> (`docs/specs/bond-program-securities.md` sections 2.3 and 2.4).

The lots of a linked security are derived from the user's investment
transactions on it, **per account**, in register order, `VOID` rows excluded:

| Action (base) | Effect |
| --- | --- |
| `BUY`, `REINVEST`, `ADD_SHARES` | a new lot dated `transaction_date` |
| `TRANSFER_IN` with a linked `TRANSFER_OUT` of the same security | none new: the pair moves the quantity first-in first-out from the source account's lots to the destination account, keeping the purchase dates |
| `TRANSFER_IN` without a linked leg | a new lot dated `transaction_date`, flagged `purchaseDateAssumed` |
| `SELL`, `REDEEM`, `REMOVE_SHARES`, unlinked `TRANSFER_OUT` | removes quantity first-in first-out from the lots of the row's own account |
| `SPLIT` | lots unknown (a bond does not split); valuation refused with the reason |
| cash-only actions | none |

A lot is `{ accountId, instrumentId, purchaseDate, quantity, purchaseDateAssumed }`.
The holding fields of discussion section 13 that a lot does not carry are not
needed for retail bonds: the cost stays on the transactions (the existing
cost-basis code reads it), and a retail bond is bought at par on the day of
sale, so there is no separate settlement date and no accrued interest paid.

A lot quantity that is not a whole number of bonds, or a removal larger than
the open lots of its account, makes the lots unknown; the reason is named, nothing is
guessed.

### 12.3 Daily price

For each calendar day `D` from the earliest lot date to today, the unit price
of a linked security is

```text
price(D) = sum over lots open on D of grossValue(lot, asOf = D) / sum of their quantities
```

rounded half-up to 10 decimals (`security_prices.close_price` is
`NUMERIC(24,10)`), computed with `ExactDecimal`; the blend is over the lots of
all accounts. A lot bought outside `terms.saleWindow` is refused (section 2.6)
and has no `grossValue`, so its days get no price row. The series is valued from
one resolution of each lot's schedule and period rates (a period that started on
`D` has the same rate or the same "missing" whether resolved on `D` or today),
so a recompute costs O(days + lots x periods), not a resolution per day. `grossValue` is principal
plus accrued interest, before the early redemption fee and tax: the economic
value of the holding. The early redemption value is shown beside it in the
detail view (section 13), never instead of it.

A day on which any open lot has no `grossValue` (a started period without a
rate, INV-BOND-002; a matured compounding lot without every rate) gets no price
row. The portfolio then carries the last
priced day, as for any security, and the detail view names what is missing.

**Price precedence for a linked security.** A transaction-derived price is one
lot's trade price, not the holding's value. Rows are written with `source =
'bond_engine'` and `adjusted_close` `NULL` (coupons are recorded as `INTEREST`
income; the close is the value) by `INSERT ... ON CONFLICT (security_id,
price_date) DO UPDATE ... WHERE security_prices.source IS DISTINCT FROM 'manual' AND (the
close or the source differs)`: the engine row replaces every non-manual row
(provider and transaction-derived) on its days, a manual price is never
overwritten, and an unchanged day is not rewritten. A transaction-derived price
never replaces a `bond_engine` row (the replaceable-source list of the
transaction-price upsert excludes it for a linked security), and a manual price
written over an engine row takes its own `adjusted_close`, not the engine's. A
bond engine row for a day that no longer has a price (lots changed) is deleted;
the delete touches only `bond_engine` rows.

### 12.4 When prices are written

- after a link is set or changed (the request recomputes that security);
- after an investment transaction of a linked security is created, edited,
  voided or deleted, on every entry point (UI service, bulk, AI action, MCP,
  import);
- after a restore commits, for every linked security of the user;
- on the "refresh price" of a linked security, which first fetches its
  program's current offer and a bounded piece of its history
  (`BondSeriesService.fetchProgramOffer`, `bond-program-securities.md` 2.5) and
  then recomputes the engine prices instead of calling a provider;
- after a series is stored (a fetch, the offer, the cron, the backfill, an
  administrator's entry), for the securities of its program;
- daily, after the benchmark refresh, for every linked security of every user
  (system fan-out, then each user in its own context; one user's failure does
  not stop the others);
- on demand through `POST /bonds/securities/:securityId/recompute`.

The recompute runs after the commit of the change that triggered it, never
inside it (INV-CACHE-001). The request recompute and the cron use one
definition of today, the user's financial today.

### 12.5 Read API

Every route is under `AuthGuard('jwt')` (`backend/src/bonds/bonds.controller.ts`);
the security routes are owner-scoped and another user's security, or one not
linked to a bond program, answers 404. The catalog routes are global reference
data.

| Route | Answers | Spec |
| --- | --- | --- |
| `GET /bonds/programs` | the catalog's programs: `id`, `issuerCountryCode`, `issuerCode`, `programCode`, `currency`, `seriesCount`, `newestSeriesCode`, `infoUrl` (the issuer's page for the product, from the adapter; null when none) | `bond-program-securities.md` 4 |
| `GET /bonds/programs/:programId/refresh-progress` | `{ startedAt, phase: offer\|series\|done\|null, done, total, seriesCode, finishedAt }` of the program's Refresh; 404 for an unknown program | `bond-program-securities.md` 2.5 |
| `GET /bonds/instruments` | the catalog's series (`id`, issuer country, issuer, program, series, `currencyCode`, `termsProvider`) | here |
| `GET /bonds/offer?countryCode=&assume=` | the series on sale, with projections | `bond-offer-and-history.md` 2 |
| `GET /bonds/history?countryCode=&programCode=` | the program's terms by sale month | `bond-offer-and-history.md` 3 |
| `POST /bonds/instruments/fetch` | fetch a series by country and code | `bond-series-fetch.md` 5.1 |
| `POST /bonds/instruments/manual` | an administrator's entry | `bond-series-fetch.md` 5.2 |
| `GET /bonds/securities/:securityId/valuation?asOf=&assume=` | see below | here |
| `GET /bonds/securities/:securityId/scenarios?benchmarkId=&values=&asOf=` | inflation scenarios | 13.3 |
| `GET /bonds/securities/:securityId/series-on-sale?date=` | the series a purchase on a date is given, or `null` | `bond-program-securities.md` 4 |
| `GET /bonds/securities/:securityId/series-holdings?accountId=&date=[&excludeTransactionId=]` | the series an account holds | `bond-program-securities.md` 4 |
| `GET /bonds/securities/:securityId/redemption-split?date=&quantity=&bondInstrumentId=&accountId=[&excludeTransactionId=]` | what redeeming pays, split into principal and interest | `bond-redemption-interest.md` 2.2 |
| `POST /bonds/securities/:securityId/recompute` | recompute the engine prices; `{ written, deleted }` | 12.4 |

The valuation answers `{ securityId, program, autoFetch, asOf, lots, series,
benchmarkCoverage, totals, refusal }`: one `BondValuation` per lot (section
2.6) with the lot's `instrumentId`, `accountId`, `purchaseDate`, `quantity` and
`purchaseDateAssumed`; `series` is one `{ instrumentId, seriesCode,
programCode, termsSource, redemptionTerms }` per series held
(`redemptionTerms` is the terms' redemption policy: window, penalties and
proceeds floor, or null for `MATURITY_ONLY`); `totals` are `quantity`,
`grossValue`, `earlyRedemptionValue` and `accruedInterest`, each null unless
every lot has the figure; `refusal` names why the lots cannot be derived.
`asOf` after today is refused (`AS_OF_IN_FUTURE`).

Market surfaces do not read the engine's rows as market moves: Top Movers and
the daily-change boards, and the global "last price update" marker, exclude
bond-linked securities and `bond_engine` rows. Wherever price sources are
listed, `bond_engine` has a translated label.

## 13. Detail view (phase 4)

There is no standalone bonds page. The views live on the detail page of a
program-linked security (`frontend/src/app/securities/[id]/page.tsx`):

- **Overview, "Your series"** (`SecurityBondCard`): one row per series held
  (series, quantity, purchase dates, gross value, accrued interest, early
  redemption value, current rate, next rate change, maturity) and a total row;
  a row expands to its lots (purchase date, status, current period, rate with
  `rateSource`, principal, the next payment, known and projected maturity
  value) and to the rate schedule with its indexation notice, the early
  redemption fee from `redemptionTerms`, the next rate reset and capitalization
  dates and the interest chart. The card has an as-of date (its maximum is
  today), a "Recalculate prices" button (`POST .../recompute`) and the scenario
  panel (13.3). Below the table: the projection assumptions, the
  `missing` list with the publisher to obtain each item from, the benchmarks no
  future period can be projected from, and how fresh the reference data is from
  `benchmarkCoverage`. A partial-data notice names the `dataCompleteness`
  causes when `valuationComplete === false`. A lot shows its status: "Matured"
  for a matured lot and the translated refusal reason for a refused one, never
  "Unknown"; a period whose rate is unknown shows the missing observation.
- **Overview, "The bond kind"** (`SecurityBondProgramCard`): the rate rule in
  words, length, capitalization and early redemption fee and floor, read from
  the newest series of the program, and the auto-fetch switch.
- **Overview, "On sale now"** (`BondOfferTab`): `bond-offer-and-history.md` 5.
- **"Terms history" tab** (`SecurityBondTermsTab`, in place of "Price history"
  for a bond-linked security): `bond-offer-and-history.md` 5.
- **Breakdown card** (beside Key information, in place of the sector, country
  and asset-class splits): the holding by series and by maturity year, and what
  the kind is (issuer country, interest rate, interest, term to maturity).
  Shares are drawn only when every value is known.
- **Key information**: the issuer's page for the product, from the program's
  `infoUrl`, shown as a link by its host when it is an https address.
- **Documents tab, "Issue letters"** (`SecurityIssueLetters`): one row per
  series held, then the series on sale not held, each with the document its
  stored terms were read from and a link to it (or "entered by hand").
- **Refresh progress** (`BondRefreshProgress`): a progress bar polling
  `GET /bonds/programs/:programId/refresh-progress` while the security's
  Refresh runs.

Percentages and amounts are localized by the reader's number format
preference. The issuer, program and benchmark are shown by translated labels
(`securityDetail.bond.issuers`, `.programs`, `.benchmarks`: `PL_MF` is "Ministry
of Finance (PL)"), falling back to the code. The security form
(`SecurityForm`) shows a Country select for a `BOND` security (the countries of
the catalog's programs, and "Other": a bond no program supports, which works
as a plain security with a quote provider), then the bond-kind picker for that
country; choosing a bond kind fills the symbol, name and currency of a new
security and shows the auto-fetch switch.

How the rate is set is shown, not only its value: the rate rule in words (for
EDO1036: "period 1: 5.35%; then the 12-month CPI published by GUS + 2.00%
margin, a negative CPI counted as 0"), and a table of every period of the lot
with its dates, rate and `rateSource`, and, for a benchmark period, the
observation used (CPI 2027-08 = 3.4%), the floor when it applied, and the
margin. A projected period says it is projected and names the assumption; a
period whose observation is missing says which one. A benchmark id is shown
by a translated name where the catalog has one (`PL_CPI_GUS_YOY`: "CPI, 12
months (GUS)"), else by the id itself.

### 13.1 Indexation notice

A lot whose rate rule reads a benchmark says so in words before any figure:
for EDO1036 bought 2026-10-02, "Inflation-indexed: from 2027-10-02 (period 2)
the rate is the 12-month CPI published by GUS + 2.00% margin, recalculated
every period". The date is the lot's own period 2 start, because periods are
anchored on the purchase date.

### 13.2 Interest attribution

Each period's interest per bond is split by the components of its rate, so a
reader sees what the margin earned and what inflation earned:

```text
interest_k   = base_k * r_k / F                     (exact; base_k per 2.4)
fixed_k      = interest_k                           when rateSource is TERMS
benchmark_k  = base_k * flooredValue_k / F          for a benchmark period
addend_k     = base_k * addend_k / F                for a benchmark period
announced_k  = interest_k                           when ANNOUNCED (no split
                                                    is stated, so none is made)
```

For a benchmark period `benchmark_k + addend_k = interest_k` exactly, in the figures the scenarios
return (rounding rule: 13.3). For a
compounding bond `base_k` already holds earlier interest, so interest earned
on earlier inflation counts as interest of the period it accrues in, by the
same split; the attribution is per period and never retroactive. The
rate schedule entry carries `interest`, `fixedPart`, `benchmarkPart`,
`addendPart` and `announcedPart` per bond (strings, unrounded to 10 places for
display; the money figures of section 2.4 keep their own rounding), each
`null` when the period's rate is unknown. Lot figures are per bond times the
quantity.

A fixed-rate rule's interest is labelled "Fixed-rate interest"; "(1st period)"
is added only to the first period of a benchmark rule.

Numerical examples (computed from the formulas above with exact fractions;
E23 and E24 are the same computation as the implementation's fixtures and are
not read from its output):

| # | Case | Inputs | Expected |
| --- | --- | --- | --- |
| E23 | TOS1029 attribution | r = 4.40%, bases 100, 104.40, 108.99 | interest `4.40`, `4.5936`, `4.79556` (all `fixedPart`); their sum `13.78916` while `W - N = 13.79` (see below) |
| E24 | EDO1036 period 2 attribution | base 105.35, CPI 3.4% (floor not applied), margin 2%, so r2 = 5.4% | `interest 5.6889`, `benchmarkPart 3.5819`, `addendPart 2.107`; `3.5819 + 2.107 = 5.6889` per bond |

### 13.3 Inflation scenarios

`GET /bonds/securities/:securityId/scenarios?benchmarkId=...&values=a,b,...[&asOf=YYYY-MM-DD]`
values the security's lots as of `asOf` (default today; the same bounds as the
valuation, so a future `asOf` is refused with `AS_OF_IN_FUTURE`; the panel uses
the card's date and states it) with every future period of that
benchmark projected at each given value (at most 6 values, each between -0.5
and 1.0 as a fraction). Known periods stay known: a scenario never replaces an
observation or an announced rate. Per scenario it returns the lots' maturity
value, total interest and its attribution (13.2) summed over the lots, each
`null` if any lot cannot be valued. When the lots cannot be derived (section
12.2) every figure is `null` and `refusal` names why. An assumption about a
benchmark the instrument's rate rule does not read is refused with a 400, here
and on `assume`, because it would return unchanged figures that look like a
scenario. The detail view shows a table for the
presets 0%, 2.5%, 5% and 8% and one value the reader types, and labels every
scenario figure as a projection under that assumption.

The bounds -0.5 and 1.0 are inclusive and so is the limit of 6 values (a 7th
value, or a value outside the bounds, is refused with a 400).

**Rounding rule of the scenario figures.** Interest per period per bond is: for
a coupon period (capitalization `NONE`), the coupon as paid, rounded per bond
as section 2.4 says; for a compounding period, the exact accrual. The parts
(13.2) of a period are split exactly, and the rounding residual of a period is
assigned to the addend part, so the parts sum to the period's interest. A lot's
figures are the per-bond sum times the quantity, rounded once per lot, for every
figure; `totalInterest` is the sum of the rounded parts. The chart (13.4) ends
at `totalInterest`.

**Total interest versus maturity value.** For a compounding bond,
`maturityValue` is the per-bond maturity value rounded as section 2.4 says (each
period for TOS, the result for EDO) times the quantity, and `maturityValue - face`
and `totalInterest` differ by cents (E23: 13.79 against 13.78916), the letter's
rounding, disclosed, not reconciled. For a coupon bond (COI, ROR, DOR, OTS) the
two are not close: `maturityValue` is the final payment only, face plus the last
coupon, because the earlier coupons were paid out; `maturityValue - face` is the
last coupon, while `totalInterest` is every coupon (COI1030 x10, v = 0.025:
`maturityValue` 1040.00, `totalInterest` 167.50). The panel captions the
`maturityValue` column of a coupon bond as the final payment at maturity.

Example E25 (EDO1036, 10 bonds bought 2026-10-01, valued 2027-10-16, period 2
CPI 3.4% known, r2 = 5.4%, r1 = 5.35%; every later period projected at the
scenario value `v`, margin 2%, floor 0):

| Scenario `v` | `maturityValue` | `totalInterest` | fixed | benchmark | addend |
| --- | --- | --- | --- | --- | --- |
| 0 | `1301.00` | `301.00` | `53.50` | `35.82` | `211.68` |
| 0.05 | `1907.90` | `907.86` | `53.50` | `605.44` | `248.92` |

For `v = 0.05`, `maturityValue - face = 907.90` against `totalInterest =
907.86`: per-bond rounding of the maturity value against exact interest. The
known period 2 stays at 3.4% in both scenarios.

`GET .../valuation` accepts an optional `assume=<benchmarkId>:<value>` with
the same rule, so the per-period table and the chart can follow the reader's
chosen scenario.

### 13.4 Chart

A stacked chart over the lot's period ends shows cumulative interest per
bond (or for the holding) split into fixed (period 1), margin and inflation
(benchmark) parts; projected periods are drawn distinctly from known ones and
the legend names the assumption. It reads the rate schedule of 13.2; it never
recomputes interest in the client.
