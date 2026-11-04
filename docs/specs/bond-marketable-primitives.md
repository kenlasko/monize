# Bond engine: primitives for marketable and indexed securities

Specification of the engine primitives a marketable government security needs
(coupon notes and bonds, inflation-indexed principal, floating rate notes,
holdings rounded on the holding, a lot's own cost) and of the savings-bond
primitives (monthly accrual compounded semiannually). Written before the
implementation (`docs/financial-calculation-contract.md` section 9). The first
adapter that uses them is the United States (`docs/specs/us-treasury-securities.md`);
nothing here names a country, and every primitive is defined so that another
country's marketable bonds can use it (the "Global readiness" table of
`docs/specs/sovereign-bonds.md` lists them).

Origin: discussion kenlasko/monize#1908 (US Treasury bills) and the request in
the same discussion to cover every US Treasury security, not only bills.

## 1. Sources

Every formula below is taken from an official text; the numerical examples in
section 9 are computed from those texts (Python `fractions`, exact), never from
the implementation.

| Rule | Source |
| --- | --- |
| Regular coupon = par x rate / 2 whatever the days; short and long first coupon by the daily decimal of the regular half-year; accrued interest over one or two half-years; accrued interest rounded to five decimals per 1,000 par, then scaled | 31 CFR Part 356, Appendix B, section I.A and I.D (https://www.law.cornell.edu/cfr/text/31/appendix-B_to_part_356) |
| Indexed principal: Ref CPI of the first day of a month is the CPI-U (NSA) of the third preceding month; daily linear interpolation; Ref CPI and Index Ratio truncated to six decimals then rounded to five; the denominator is the Ref CPI of the dated date; interest = rate / 2 x inflation-adjusted principal on the payment date; accrued interest = unadjusted accrued interest x Index Ratio | 31 CFR 356 Appendix B, sections I.B, I.D.5, III |
| At maturity of an indexed security the holder receives the larger of the inflation-adjusted principal and par; the final interest is on the inflation-adjusted principal at maturity | 31 CFR 356.30(b) (https://www.law.cornell.edu/cfr/text/31/356.30) |
| A payment date that is not a business day is paid on the next business day without additional interest | 31 CFR 356.30 |
| Floating rate: index = the high rate of the latest 13-week bill auction converted to a simple money-market yield on actual/360, nine decimals; daily accrual = (index + spread) / 360 with a zero minimum; payment = the sum of the daily accruals of the quarter; an auction in the two business days before a payment or settlement date is excluded; intermediate values rounded to nine decimals | 31 CFR 356 Appendix B, sections I.C, IV |
| Money-market yield of a bill: `r = D / (1 - D x t / 360)` | 31 CFR 356 Appendix B, section IV.A (the FRN example) |
| Savings bond value on an accrual date: `FV = PV x (1 + CR / 2) ^ (m / 6)`, rounded to the cent; a negative composite rate is zero; a book-entry bond's value is `par / 100 x` the value of a 100 USD bond, rounded to the cent | 31 CFR 359.39, 359.55 and Appendix A to Part 359 |

A reference implementation of the same day counts exists in QuantLib
(`ActualActual(ActualActual::Bond)`, `CPIBond`, `UnitedStates(UnitedStates::GovernmentBond)`),
used here only to cross-check conventions, never as a source of figures and
never as a dependency.

## 2. What exists and what is new

The engine already has: `FIXED`, `ZERO_COUPON_DISCOUNT`, `LOT_PURCHASE_DATE` and
`ISSUE_DATE` (one period) schedules, `ACTUAL_DAYS_IN_PERIOD`, `FIXED_NOMINAL`,
rounding per unit with `moneyDecimals` 0 to 4, `STEP` and `MONTHLY` benchmarks
with unit `RATE_FRACTION`, the redemption split (`bond-redemption-interest.md`).

| # | New primitive | Kind | Needed by |
| --- | --- | --- | --- |
| P1 | `instrument.marketability: "MARKETABLE"` | instrument | every marketable security |
| P2 | `rounding.basis` (`PER_UNIT`, `PER_HOLDING`, `REFERENCE_AMOUNT`) and `rounding.unitDecimals` | rounding | coupon securities, indexed securities, savings bonds |
| P3 | Schedule anchor `COUPON_DATES` | schedule | coupon notes and bonds, indexed, floating |
| P4 | Accrual `ACTUAL_ACTUAL_ICMA` | accrual | coupon notes and bonds, indexed |
| P5 | Lot cost (`lot.cost`) as the principal base of a discount lot | lot input | bills bought on the secondary market (#1908 side question) |
| P6 | Principal rule `INDEX_RATIO` and benchmark unit `INDEX_LEVEL` | principal | inflation-indexed securities |
| P7 | Rate rule `DAILY_INDEX_PLUS_SPREAD` and accrual `ACTUAL_360_DAILY_SUM` | rate, accrual | floating rate notes |
| P8 | Savings-bond primitives (section 8) | several | savings bonds |

Each is one commit with its parser case, engine case, tests and this spec's
section, in the order of the table (`docs/backend/bond-adapters.md` section 4).
Stored terms are immutable (INV-BOND-001), so every new field is optional with
the current behaviour as its default: a terms document stored before this change
parses to exactly the same object.

## 3. P1 marketability

`instrument.marketability` accepts `RETAIL_REDEEMABLE` (unchanged) and
`MARKETABLE`.

- `MARKETABLE` means the security trades: its market price is not a function of
  its terms. The engine still computes, from the terms: the schedule, every
  coupon and principal cash flow, the accrued interest on any day, the indexed
  principal, the redemption split at maturity, and for a discount instrument the
  accreted value of a lot (section 6).
- Price policy (INV-BOND-005 becomes per marketability): the bond price service
  writes the engine price of a linked security only when every series it holds
  is `RETAIL_REDEEMABLE` or a discount instrument (`ZERO_COUPON_DISCOUNT`). For
  a linked security holding a `MARKETABLE` coupon series the engine writes no
  price; the security's price is the person's manual price (a manual price
  always wins, unchanged) and the valuation reports `marketPriceRequired: true`
  so the surface says so (`docs/financial-calculation-contract.md` 1.3: the
  reader learns why and what to do). A quote provider is still not asked about a
  linked security in this change: no provider in Monize prices a CUSIP today;
  allowing one is a separate proposal.
- A `MARKETABLE` series has `saleWindow: null` (a secondary-market lot can be
  bought on any day before maturity) and `redemption.type: "MATURITY_ONLY"` (a
  sale before maturity is a `SELL`, not a redemption; a callable bond is out of
  scope, section 10).
- A lot of a `MARKETABLE` series bought on or after its maturity date is refused
  (`PURCHASE_AFTER_MATURITY`, a new `BondValuationRefusal` code).

## 4. P2 rounding basis

```text
rounding: {
  moneyDecimals: 0..4,            // unchanged: the decimals of a lot's money
  mode: HALF_UP | HALF_EVEN | DOWN,
  basis?: PER_UNIT | PER_HOLDING | REFERENCE_AMOUNT,   // default PER_UNIT
  unitDecimals?: integer 0..12 | null,                 // PER_HOLDING and REFERENCE_AMOUNT only
  referenceAmount?: decimal string                     // REFERENCE_AMOUNT only
}
```

- `PER_UNIT` (today): every figure is rounded per unit to `moneyDecimals` and
  multiplied by the quantity.
- `PER_HOLDING`: a per-unit intermediate is rounded to `unitDecimals` when that
  is not null (31 CFR 356 App. B I.D.4: accrued interest to five decimals per
  1,000 par, which is six decimals per 100 par), multiplied by the quantity, and
  the lot figure is rounded once to `moneyDecimals`. A figure that the issuer
  computes on the holding with no per-unit rounding (an indexed coupon: rate / 2
  x inflation-adjusted principal) uses `unitDecimals: null` for that figure: see
  section 5.3 for which figures take `unitDecimals`.
- `REFERENCE_AMOUNT`: the value of one `referenceAmount` of face (a 100 USD
  savings bond) is computed and rounded to `moneyDecimals`, then scaled by
  `quantity x faceValue / referenceAmount` and rounded again to `moneyDecimals`
  (31 CFR 359.55).
- The engine applies the basis in one place (`roundLot(terms, perUnit, quantity)`
  beside `roundMoney`); no caller multiplies a rounded per-unit figure by the
  quantity itself. `redemptionSplit` keeps `payout = principalReturned + interest`
  exactly under every basis (INV-BOND-009).
- Parser: `basis` absent is `PER_UNIT`; `unitDecimals` and `referenceAmount` are
  refused with `PER_UNIT`; `referenceAmount` is required with
  `REFERENCE_AMOUNT` and must be a positive multiple of `faceValue`.

Decisions taken in the implementation, where this section left a choice open:

- A document without `basis` parses to the two-field object it always did;
  `basis` is not added to it (`roundingBasisOf(terms)` answers `PER_UNIT`), so a
  terms document stored before the change is unchanged (INV-BOND-001). An
  explicit `"basis": "PER_UNIT"` is accepted and kept as written.
- `roundLot(terms, perUnit, quantity, figure)` takes the kind of figure: only an
  `ACCRUED` interest is rounded per unit to `unitDecimals` (table 5.3); a
  principal, a regular coupon, a value and a maturity value are exact until the
  lot is rounded. `PER_UNIT` rounds every kind per unit to `moneyDecimals`.
  `unitDecimals` under `REFERENCE_AMOUNT` is applied to the same figure kind,
  before the reference value is formed.
- On `PER_HOLDING` and `REFERENCE_AMOUNT` the value of an open coupon lot is the
  principal on the holding plus the accrued interest on the holding
  (`grossLotOf`); a compounding or discount lot's value is rounded once as a
  whole. `accruedInterest` of a lot is its value less its principal on the
  holding (`principalLot`), so every lot figure is on the money grid and
  `payout = principalReturned + interest` holds exactly.
- `RedemptionSplit.perBond` keeps its meaning only under `PER_UNIT` (the lot's
  figures are these times the quantity). Under another basis it holds one unit's
  figures by the same rule, for information; the lot's figures are not their
  multiples. The valuation's per-bond `principal` is printed at the money
  decimals, or at the finer of `unitDecimals` and the money decimals under
  another basis (`unitText`).

## 5. P3 and P4: coupon dates and actual/actual

### 5.1 Schedule `COUPON_DATES`

```text
schedule: {
  anchor: "COUPON_DATES",
  datedDate: YYYY-MM-DD,        // interest accrues from this day
  firstCouponDate: YYYY-MM-DD,  // the first interest payment date
  maturityDate: YYYY-MM-DD,
  couponMonths: 3 | 6 | 12,
  endOfMonth: boolean,          // true when the regular dates are month ends
  paymentAdjustment: "NONE" | "NEXT_BUSINESS_DAY",
  calendarId: string
}
```

- Regular coupon dates are generated backwards from `maturityDate` in steps of
  `couponMonths`: with `endOfMonth` true each date is the last day of its month,
  otherwise the maturity's day of month clamped to the month (a 31st in June is
  the 30th; the next date is computed from the maturity, never from the clamped
  date, as `buildSchedule` already does). Generation stops at the last regular
  date on or before `firstCouponDate`; `firstCouponDate` must be one of the
  regular dates (else `INVALID`: the terms are inconsistent).
- Period 1 runs from `datedDate` to `firstCouponDate`; period k > 1 runs between
  consecutive regular dates; the last period ends on `maturityDate`.
- Period 1 is **regular** when `datedDate` is itself the regular date one step
  before `firstCouponDate`, **short** when it is after it, **long** when it is
  before it. The quasi-coupon periods of an irregular period are the regular
  periods (generated by the same rule, before `firstCouponDate`) that it overlaps.
- `paymentAdjustment: NEXT_BUSINESS_DAY`: the cash flow of a period is dated on
  the next business day of `calendarId` when its end is not one, with no extra
  interest (31 CFR 356.30); accrual still runs to the unadjusted date. The
  `CashFlow` gets `accrualEndDate` (the unadjusted date) beside `date`.
- The schedule does not depend on the lot. A lot holds the periods whose end is
  after its purchase date (settlement date); the coupon of the period it was
  bought in is paid in full to the holder (the accrued interest the buyer paid
  the seller is section 6.2).
- `scheduleMonthsOf` returns `{ periodMonths: couponMonths, periodCount }`;
  `scheduleDaysOf` returns the days from `datedDate` to `maturityDate`.

### 5.2 Accrual `ACTUAL_ACTUAL_ICMA`

For a period with annual rate `c` and `F = 12 / couponMonths` payments a year:

- **Regular period**: the coupon per unit is `faceValue x c / F`, whatever the
  days (31 CFR 356 App. B I.A.1: "par x rate / 2").
- **Accrued interest** on day `d` inside a regular period `[s, e)`:
  `faceValue x c / F x days(s, d) / days(s, e)`.
- **Short first period** `[dated, first)` inside the quasi-coupon period
  `[q, first)`: coupon `= faceValue x c / F x days(dated, first) / days(q, first)`.
- **Long first period**: the regular coupon of the last quasi-period
  `[q1, first)` plus `faceValue x c / F x days(dated, q1) / days(q0, q1)` for the
  earlier quasi-period `[q0, q1)` that contains `dated`. Accrued interest on a day
  inside a long period sums the elapsed fraction of each quasi-period it has
  entered (App. B I.D example 2: 44 of 181 days plus 81 of 184 days).
- With `rounding.basis: PER_HOLDING` and `unitDecimals: 6` (100 par) the accrued
  interest and an irregular coupon are rounded per unit first (App. B I.D.4); a
  regular coupon is exact and needs no per-unit rounding.
- `ACTUAL_DAYS_IN_PERIOD` stays as it is; for a regular period both give the
  same figure, and an `ACTUAL_ACTUAL_ICMA` accrual on a `LOT_PURCHASE_DATE`
  schedule is refused by the parser (a lot-anchored product has no irregular
  period, so the existing primitive is the one to use).

### 5.3 Which figures take `unitDecimals`

| Figure | Per-unit rounding (PER_HOLDING) |
| --- | --- |
| Accrued interest (non-indexed) | `unitDecimals` |
| Regular coupon (non-indexed) | none (exact) |
| Irregular first coupon (non-indexed) | `unitDecimals` |
| Indexed coupon, indexed accrued interest | none: the index ratio is already rounded to five decimals, the product is rounded on the holding (App. B I.B example: 1,963.48 on 100,000 par) |
| Floating daily accrual | nine decimals per 100 par in percent (section 7), not `unitDecimals` |
| Principal and maturity value | none |

## 6. P5 a lot's cost and purchased accrued interest

### 6.1 Cost as the principal base of a discount lot

`BondEngineInput.lot` gains `cost?: string | null`: the lot's acquisition cost
in the terms' currency, an exact decimal, excluding any accrued interest bought.
It is read only for a `ZERO_COUPON_DISCOUNT` instrument:

- Known (`cost` present): the lot's principal base is `cost`; its value on day
  `k` of the `N` days from `max(purchaseDate, issueDate)` to maturity is
  `cost + (face x quantity - cost) x k / N` (ratable accrual from the lot's own
  purchase, IRS Publication 550, "Discount on Short-Term Obligations"); the
  redemption split at maturity is `principal = principalReturned = cost`,
  `interest = face x quantity - cost`. This answers the side question of
  #1908: the interest of a bill bought on the secondary market is the face value
  less what that lot cost, not less the auction price.
- Unknown (`cost` absent or null, e.g. a transfer in with no paired leg): the
  issue price is the base exactly as today, and the valuation reports
  `principalBasis: "ISSUE_PRICE"` (otherwise `"LOT_COST"`), so the surface can
  say the interest is the auction's, not this lot's.
- A coupon security ignores `cost`: its interest is its coupons, and a
  difference between the cost and the face value at maturity is a capital gain or
  loss in the existing cost-basis machinery (the market-discount and
  bond-premium tax elections are out of scope, section 10).
- The lot fold (`bondLotsFromTransactions`) carries the cost of each acquisition
  (the row's `totalAmount` less its accrued interest, exactly as text, never a
  JavaScript number) and splits it pro rata, first in first out, when part of a
  lot leaves; the remainder keeps `cost - taken` so the parts always add up to
  the whole (the last part takes the remainder, never a rounded share).

### 6.2 Purchased accrued interest

A lot of a coupon security bought between coupon dates paid the seller the
interest accrued from the period start to the purchase date. The engine exposes
`accruedInterestOn(terms, date, quantity)` (section 5.2, with the indexed form of
section 7) so the purchase form can suggest the figure through the same code as
the valuation (a preview is the commit's code). Booking it is unchanged: the
existing `accruedInterest` field of a BUY row (`docs/specs/redemption-accrued-interest.md`).
Netting it against the first coupon is a tax question and out of scope.

## 7. P6 and P7: indexed principal and floating rate

### 7.1 Principal rule `INDEX_RATIO`

```text
principalRule: {
  type: "INDEX_RATIO",
  benchmarkId: string,           // a MONTHLY benchmark of unit INDEX_LEVEL (CPI-U NSA)
  baseReference: decimal string, // Ref CPI of the dated date, as published (5 decimals)
  lagMonths: integer >= 1,        // 3: the Ref CPI of the 1st of month M is the index of M - 3
  interpolation: "DAILY_LINEAR",
  truncateDecimals: integer,      // 6
  roundDecimals: integer,         // 5
  maturityFloor: "PAR" | "NONE"
}
```

- `refIndex(d)` for day `t` of a month of `D` days, month `M` of `d`:
  `I(M - lag) + (t - 1) / D x (I(M + 1 - lag) - I(M - lag))`, truncated to
  `truncateDecimals` then rounded (`HALF_UP`) to `roundDecimals`.
- `indexRatio(d) = refIndex(d) / baseReference`, truncated then rounded the same
  way.
- `principalAt(terms, { date })` = `faceValue x indexRatio(date)` (unrounded;
  rounded on the holding by the rounding basis).
- Coupon of a period = `faceValue x c / F x indexRatio(period end)` (the
  unadjusted accrual end, not the business-day adjusted payment date: App. B
  I.B.5 says "for the interest payment date"; to verify, section 11 of the
  country spec).
- Accrued interest on `d` = the unindexed accrued interest of section 5.2 x
  `indexRatio(d)` (App. B III.A: `Aadj = A x Index Ratio`).
- At maturity with `maturityFloor: PAR`: principal paid =
  `max(faceValue x indexRatio(maturity), faceValue)` per unit (31 CFR 356.30(b));
  the final coupon is on the inflation-adjusted principal, not on the floor.
- `PrincipalContext` gains what the rule needs: the benchmark observations and
  the projection (the existing comment in `accrual.ts` names this seam).
- Missing data (INV-BOND-002): a day whose two monthly observations are not both
  stored has an unknown index ratio; every figure that depends on it is null
  with the observation listed in `missing`, never the last ratio carried on. A
  future period uses the projection when the caller supplies one (an assumed
  annual inflation), and is `PROJECTED`; otherwise `UNKNOWN`.
- Benchmark unit: `BenchmarkSeriesDefinition.unit` gains `"INDEX_LEVEL"` (values
  are index levels, e.g. "335.123", not fractions). `benchmark_series.unit` is
  free text: no migration. A rate rule never reads an `INDEX_LEVEL` benchmark and
  a principal rule never reads a `RATE_FRACTION` one (`assertConsistent`, a
  terms error, and a check in the valuation service that the stored series'
  unit matches).

### 7.2 Rate rule `DAILY_INDEX_PLUS_SPREAD`, accrual `ACTUAL_360_DAILY_SUM`

```text
rateRule: {
  type: "DAILY_INDEX_PLUS_SPREAD",
  benchmarkId: string,             // a STEP benchmark: the index in force from the day after its observation
  spread: signed decimal string,   // may be negative (a reopening at a premium)
  floor: decimal string,           // "0": the daily accrual rate never goes below it
  lockoutBusinessDays: integer,    // 2: a value observed within this many business days before a payment date is not used for that period
  calendarId: string,
  dailyDecimals: integer           // 9: the daily accrual per 100 par, in percent of par, rounded
}
accrual: { type: "ACTUAL_360_DAILY_SUM" }
```

- The index in force on day `x` is the latest observation strictly before `x`
  (an auction's rate applies from the next calendar day), except that an
  observation dated within `lockoutBusinessDays` business days before the end of
  the period containing `x` is ignored for the days after it in that period.
- Daily accrual per 100 par: `round(max(index(x) + spread, floor) / 360 x 100, dailyDecimals)`
  in the units of App. B IV (0.000597286 for 0.095022819 % + 0.120 %).
- Period interest per unit = the sum of the daily accruals of its days (start
  inclusive, end exclusive) x `faceValue / 100`; rounded on the holding.
- Accrued interest on `d` = the same sum up to `d` exclusive.
- `RateScheduleEntry.annualRate` of a floating period is null; the entry gains
  `dailyRates: { from, to, index, rate }[]` (runs of equal rates, so a 91-day
  quarter is a few entries, not 91). `rateSource` is `DERIVED` when every day's
  index is stored, `PROJECTED` when some day uses the projection, null otherwise.
- Missing data: a day whose index is not stored (the source has not published
  the auction, or the series is not fetched) makes the period's interest unknown
  unless the projection supplies a value; never the last value carried forward
  into an unpublished week (INV-BOND-002). Observations are dense (weekly), so
  "not stored" means "no observation after the day before".
- The parser accepts `DAILY_INDEX_PLUS_SPREAD` only with `ACTUAL_360_DAILY_SUM`,
  a `COUPON_DATES` schedule and capitalization `NONE`, and the other way round.
- `decimal()` refuses a negative value; the spread uses a new
  `signedDecimal()`; nothing else accepts a negative.

## 8. P8 savings-bond primitives (later phase)

Designed here so that the US adapter can declare the programs; implemented in a
later phase (the country spec's plan, phase 5). Each row is one union member.

| Primitive | Definition |
| --- | --- |
| Schedule `rollDay: "FIRST_OF_PURCHASE_MONTH"` on `LOT_PURCHASE_DATE` | periods of `periodMonths` (6) from the first day of the month of purchase; `periodCount` 60 (30 years) |
| Accrual `WHOLE_MONTHS_COMPOUND` | value on the first day of a month: `PV x (1 + CR / 2) ^ (m / 6)`, `m` the whole months elapsed in the period, `PV` the value at the period start; interest accrues only on the first of a month (between two such days the value is the earlier one); rounded with `rounding.basis: REFERENCE_AMOUNT` (100 USD) |
| Rate rule `FIXED_PLUS_INFLATION_COMPOSITE` | `CR = fixed + 2 x i + fixed x i`, `i` the semiannual inflation rate of a STEP benchmark in force on the period start, rounded to four decimals (`HALF_UP`), not below zero |
| Rate rule `FIXED` with `validPeriods` | a fixed rate known for the first N periods; later periods are unknown (INV-BOND-002) |
| Redemption window by months `earliestMonthsAfterPurchase` | 12 |
| Penalty `FORFEIT_LAST_MONTHS_INTEREST` | `{ months: 3, untilMonthsAfterPurchase: 60 }`: the value is the value 3 months earlier, never below the purchase price |
| Value floor `GUARANTEED_MULTIPLE_AT_MONTHS` | `{ months: 240, multiple: "2" }`: at 240 months the value is at least twice the purchase price |
| Unit face `0.01` | a savings bond is bought to the cent (minimum 25 USD), so a lot's quantity is a whole number of cents and `faceValue` is "0.01"; no change to the integer quantity of the lot fold |

## 9. Numerical examples (computed from the official formulas)

| # | Case | Inputs | Expected |
| --- | --- | --- | --- |
| E1 | Bill auction price | 26-week, discount 4.285 %, 182 days | price per 100 = 97.833694 (`100 x (1 - 0.04285 x 182 / 360)` = 97.833694444, six decimals) |
| E2 | Bill held to maturity, lot cost known | 100 units of 100 face, cost 9,783.37 | value on day 91 of 182 = 9,891.69 (9,783.37 + 216.63 x 91 / 182 = 9,891.685, HALF_UP at 2); split at maturity: principal 9,783.37, interest 216.63, payout 10,000.00 |
| E3 | Bill bought on the secondary market | same bill, bought on day 91 for 9,895.00 (100 units) | value at maturity 10,000.00; interest 105.00 (not 216.63) |
| E4 | Accrued interest, one half-year | 6 3/4 %, 92 of 184 days | 16.87500 per 1,000; 2,531.25 on 150,000 (App. B I.D example 1) |
| E5 | Accrued interest, two half-years | 10 3/4 %, 44 of 181 plus 81 of 184 days | 36.72798 per 1,000; 404.01 on 11,000 (App. B I.D example 2) |
| E6 | Short first coupon | 8 3/8 %, dated 1990-07-02, first coupon 1990-12-31, quasi-period from 1990-06-30 (184 days), 182 days | 41.419837 per 1,000 (41.419836957 exact; App. B prints 41.419837004 from the nine-decimal daily decimal); 828.40 on 20,000 |
| E7 | Long first coupon | 7 7/8 %, dated 1990-12-03, first coupon 1991-08-15, 74 of 184 days in the quasi-period 1990-08-15 to 1991-02-15 | 55.210598 per 1,000; 386.47 on 7,000 (App. B I.A example) |
| E8 | Indexed coupon | 3 7/8 %, base Ref CPI 164, Ref CPI 166.2 on the payment date, 100,000 par | index ratio 1.01341; interest 1,963.48 (App. B I.B example) |
| E9 | Daily Ref CPI and index ratios | CPI-U NSA March 2026 330.213, April 333.020, May 335.123; bases 161.74000, 164.39333, 177.50000 | Ref CPI 2026-07-02 = 333.08784 (ratios 2.05940, 2.02616, 1.87655); 2026-07-15 = 333.96974 (2.06486, 2.03153, 1.88152); 2026-07-31 = 335.05516 (2.07157, 2.03813, 1.88763) (Treasury, "Ref CPI and Index Ratios for July 2026", https://www.treasurydirect.gov/instit/annceresult/tipscpi/2026/CPI_20260610.pdf) |
| E10 | Indexed principal at maturity, deflation | 1,000 par, index ratio 0.98000 at maturity | principal paid 1,000.00 (floor); final coupon on 980.00 |
| E11 | Money-market yield | discount 0.095 %, 91 days | 0.095022819 % (App. B IV.A) |
| E12 | Floating daily accrual | index 0.095022819 %, spread 0.120 % | 0.000597286 per 100 par per day (App. B IV.A) |
| E13 | Floating negative spread floor | index 0.095022819 %, spread -0.150 % | daily accrual 0 (the floor) |
| E14 | Savings bond composite rate | fixed 0.90 %, semiannual inflation 1.67 % | 0.0426 (0.0425503 rounded to four decimals) |
| E15 | Book-entry savings bond value | par 34.59, value of a 100 USD bond 101.96 | 35.27 (0.3459 x 101.96 = 35.267964) (App. A to Part 359) |

## 10. Out of scope

- Market price of a marketable security, a yield-to-price computation and a
  quote provider for a CUSIP (section 3 says what the surface shows instead).
- Callable bonds, STRIPS components (a later primitive: a discount instrument
  with no auction, accreted by the constant-yield method from the lot's cost),
  Cash Management Bills priced differently from bills (they are bills here).
- Tax: market discount, bond premium amortization, original issue discount
  reporting, the de minimis rule, netting purchased accrued interest.
- Corporate, agency and municipal bonds: no official machine-readable terms
  source exists for them; the primitives above are country- and issuer-agnostic,
  so an administrator's manual entry on a template could cover them later.

## 11. Invariants touched

INV-BOND-002 (unknown index days and CPI months are unknown), INV-BOND-003
(exact until the issue document rounds, now per basis), INV-BOND-005 (price
policy per marketability, section 3), INV-BOND-009 (split under every rounding
basis and with a lot cost). `docs/system-invariants.md` is updated in the commit
that changes each mechanism.

## 12. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Parser | unit | each new member valid; unknown field; number instead of string; negative refused except the spread; every refused combination of sections 3, 4, 5.2, 7.1, 7.2; a terms document stored before the change parses unchanged (snapshot of every Polish fixture) |
| Rounding basis | unit | PER_UNIT unchanged on every Polish golden; PER_HOLDING E4, E5, E6, E7, E8; REFERENCE_AMOUNT E15; payout = principalReturned + interest under each basis |
| Coupon schedule | unit | regular, short and long first period; end-of-month maturity (Feb 28/29, Aug 31); a 31st clamped; payment on a holiday moved to the next business day with the accrual end unchanged; a lot bought mid-period holds that period's full coupon |
| Lot cost | unit | E2, E3; cost absent -> ISSUE_PRICE basis; fold splits cost FIFO and the parts sum to the whole |
| Indexed | unit | E8, E9, E10; a missing CPI month -> nulls and `missing`; projection -> PROJECTED |
| Floating | unit | E11, E12, E13; lockout; a missing week -> unknown; projection |
| Golden | golden | the country spec's cases |
