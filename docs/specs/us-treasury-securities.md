# United States Treasury securities

Country specification of the `US` bond adapter (`backend/src/bonds/adapters/us/`):
the products, their terms in the engine's vocabulary, the official sources, the
fetch, the golden cases and what is still to verify. The engine primitives it
uses are specified in `docs/specs/bond-marketable-primitives.md`; adding a
country follows `docs/backend/bond-adapters.md`, whose section 7 this document
supersedes.

Origin: discussion kenlasko/monize#1908. The author asked for Treasury bills; a
reply asked for every US Treasury security. This adapter covers every security
Treasury sells at auction (bills, notes, bonds, TIPS, FRNs) and designs the
savings bonds (I and EE) for a later phase.

## Official sources (country code `US`)

Read on 2026-11-04 unless marked otherwise.

| What | Source |
| --- | --- |
| Formulas: coupons, accrued interest, TIPS index ratio, FRN daily accrual, yield and price | 31 CFR Part 356, Appendix B, https://www.law.cornell.edu/cfr/text/31/appendix-B_to_part_356 (official text: https://www.ecfr.gov/current/title-31/subtitle-B/chapter-II/subchapter-A/part-356) |
| Payment of principal and interest, the next-business-day rule, the TIPS principal at maturity | 31 CFR 356.30, https://www.law.cornell.edu/cfr/text/31/356.30 |
| Bill terms (4, 6, 8, 13, 17, 26, 52 weeks; sold at a discount; face value at maturity; 100 USD increments) | https://www.treasurydirect.gov/marketable-securities/treasury-bills/ |
| Notes (2, 3, 5, 7, 10 years), bonds (20, 30 years), TIPS (5, 10, 30 years), FRNs (2 years): fixed coupon every six months, TIPS principal indexed to CPI-U, FRN interest quarterly | https://www.treasurydirect.gov/marketable-securities/ |
| Auction terms and results per security, by CUSIP (JSON) | https://www.treasurydirect.gov/TA_WS/securities/search?cusip=912797WM5&format=json (reported in #1908; endpoint family `TA_WS/securities/{search,auctioned,announced}`) |
| Auction results per auction (XML, schema `Auction_v7_0_0.xsd`) | e.g. https://www.treasurydirect.gov/xml/R_20260428_1.xml (2-year FRN 91282CQM6, read 2026-11-04, saved as a fixture) |
| Ref CPI and index ratios of every TIPS, day by day, per month | e.g. https://www.treasurydirect.gov/instit/annceresult/tipscpi/2026/CPI_20260610.pdf (July 2026) |
| CPI-U, all items, not seasonally adjusted (series `CUUR0000SA0`) | Bureau of Labor Statistics, https://www.bls.gov/cpi/ ; public API https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0 |
| Federal Reserve Bank holidays (the business days of 31 CFR 356.30) | https://www.federalreserve.gov/aboutthefed/k8.htm |
| Series I savings bonds: composite rate, value, book-entry rounding | 31 CFR Part 359 (359.14, 359.39, 359.55, Appendix A), https://www.law.cornell.edu/cfr/text/31/359.39 ; https://www.treasurydirect.gov/savings-bonds/i-bonds/ |
| Series EE savings bonds | 31 CFR Part 351; https://www.treasurydirect.gov/savings-bonds/ee-bonds/ |
| Tax character of a bill's discount (interest, Form 1099-INT) | IRS Publication 550, https://www.irs.gov/publications/p550 |

Cross-check reference (conventions only, never figures or code): QuantLib
`ActualActual::Bond`, `CPIBond`, `UnitedStates::GovernmentBond`.

## 1. Scope

| Program | Product | Engine terms | Phase |
| --- | --- | --- | --- |
| `BILL` | Treasury bills, including cash management bills | `ZERO_COUPON_DISCOUNT`, `ISSUE_DATE` | 3 |
| `NOTE` | Treasury notes (fixed coupon) | `FIXED`, `COUPON_DATES` (6 months), `ACTUAL_ACTUAL_ICMA` | 3 |
| `BOND` | Treasury bonds (fixed coupon) | as `NOTE` | 3 |
| `TIPS` | Treasury Inflation-Protected Securities | as `NOTE` with principal rule `INDEX_RATIO` on `US_CPI_U_NSA` | 4 |
| `FRN` | Floating Rate Notes | `DAILY_INDEX_PLUS_SPREAD` on `US_TBILL_13W_MMY`, `COUPON_DATES` (3 months), `ACTUAL_360_DAILY_SUM` | 4 |
| `I`, `EE` | Savings bonds | section 8 of the primitives spec | 5 (designed only) |

Issuer code `US_TREASURY`, currency `USD`, marketability `MARKETABLE` for every
auctioned security. One unit is 100 USD of face value (the purchase increment of
every auctioned security), so a lot's quantity is its face value / 100: a
broker statement line "10,000.00 face" is quantity 100. The purchase form says
this next to the quantity of a linked US security (a frontend label, phase 3).

Out of scope: STRIPS, callable bonds (none outstanding), market prices of notes
and bonds, tax computation (primitives spec section 10).

## 2. Series codes

- A coupon security (note, bond, TIPS, FRN) is one series per CUSIP: a reopening
  has the same coupon, dated date, maturity, spread and base Ref CPI, so its
  terms are the original issue's; the reopening price only changes the lot cost.
  Series code: the CUSIP, 9 characters.
- A bill reopened (a 13-week bill auctioned into an outstanding 26-week CUSIP)
  has a different issue date and price per auction. Series code: CUSIP followed
  by the issue date as `YYMMDD`, 15 characters (`912797WM5261001` for the bill of
  #1908, issued 2026-10-01). Both fit `FetchBondSeriesDto` (letters and digits,
  at most 16).
- The CUSIP's check digit is validated before any request (modulus 10 "double
  add double", the CUSIP Global Services algorithm); a bad one is
  `SERIES_CODE_INVALID` with no network call.
- `programOf(code)`: `BILL` for a 15-character code whose CUSIP starts `912797`;
  null otherwise (the program of a coupon CUSIP is known only from the source).
  US terms never change after the auction and nothing is "on sale" for a person
  to follow, so the adapter has no `currentSeries`, `backfillCodes` or
  `seriesCodeFor`: a series is fetched once, by a person, from the purchase form
  or the security's Refresh (INV-BOND-008).

## 3. The fetch

`fetchSeries(code)`, all through the `BondFetch` door, provider `treasurydirect`,
host `www.treasurydirect.gov` only:

1. `GET /TA_WS/securities/search?cusip=<CUSIP>&format=json`: a JSON array, one
   object per auction of the CUSIP. A body that is not an array, an empty array
   (`SERIES_NOT_PUBLISHED`) or an object without the fields below
   (`SOURCE_FORMAT_CHANGED`) is refused.
2. The auction is the one whose `issueDate` is the code's date (a bill) or the
   original issue, `reopening` not `"Yes"` (a coupon security).
3. Fields read (names as in the TA_WS JSON, to verify against a live response,
   section 10): `cusip`, `securityType`, `securityTerm`, `issueDate`,
   `maturityDate`, `datedDate`, `interestRate`, `highPrice`, `highDiscountRate`,
   `firstInterestPaymentDate`, `interestPaymentFrequency`, `spread`,
   `refCpiOnDatedDate`, `floatingRate`, `inflationIndexSecurity`, `auctionDate`,
   and, when present, the results XML file name.
4. Cross-checks before any write (INV-BOND-006), each a `SOURCE_INCONSISTENT`
   with a short machine `params.field`:
   - the response's `cusip` equals the requested one;
   - a bill: `highPrice` equals `100 x (1 - highDiscountRate / 100 x days / 360)`
     rounded to six decimals, `days` from issue to maturity (the formula of
     #1908, checked: 97.833694 for 4.285 % over 182 days);
   - a coupon security: `firstInterestPaymentDate` is a regular coupon date of
     the maturity at the frequency (6 months, 3 for an FRN), and after the dated
     date;
   - a TIPS: `refCpiOnDatedDate` present and positive;
   - an FRN: `spread` present;
   - when the results XML is named: `CUSIP`, `SecurityType`, `IssueDate`,
     `MaturityDate`, `DatedDate`, `InterestRate`, `Spread`, `HighPrice`,
     `RefCPIDatedDate` agree with the JSON (the XML element names are verified,
     fixture `R_20260428_1.xml`).
5. Bounds (`SOURCE_INCONSISTENT`): a bill's term 4 to 52 weeks and price below
   100; a coupon rate 0 to 20 %; a spread -1 % to 1 %; a maturity at most 31
   years after issue; a base Ref CPI 100 to 1,000.
6. The program comes from the source (`securityType` and the two flags); a code
   whose program the person did not link is refused by the existing link check.
7. The filled template goes through `parseBondTerms`; `termsVersion` 1,
   `publishedAt` the auction date, `source` `{ provider: "treasurydirect", url, document: "auction <date>" }`.

No `manualSeries` in phases 3 and 4: every auctioned security is in the source.

## 4. Terms of each product

Every per-series value is filled by the fetch; the templates hold the rest
(`templates/*.template.json`, no per-series key, `no-automatic-bonds.guard.spec.ts`).

```text
BILL  instrument { marketability MARKETABLE, faceValue "100", issuePrice <highPrice> }
      saleWindow null
      schedule { anchor ISSUE_DATE, issueDate, maturityDate, periodCount 1, calendarId "US" }
      accrual ACTUAL_DAYS_IN_PERIOD, principalRule FIXED_NOMINAL
      rateRule ZERO_COUPON_DISCOUNT, capitalization NONE, redemption MATURITY_ONLY
      rounding { moneyDecimals 2, mode HALF_UP, basis PER_HOLDING, unitDecimals null }

NOTE, BOND
      instrument { marketability MARKETABLE, faceValue "100" }
      saleWindow null
      schedule { anchor COUPON_DATES, datedDate, firstCouponDate, maturityDate,
                 couponMonths 6, endOfMonth <maturity is a month end>,
                 paymentAdjustment NEXT_BUSINESS_DAY, calendarId "US" }
      accrual ACTUAL_ACTUAL_ICMA, principalRule FIXED_NOMINAL
      rateRule { FIXED, annualRate <interestRate / 100> }
      capitalization NONE, redemption MATURITY_ONLY
      rounding { moneyDecimals 2, mode HALF_UP, basis PER_HOLDING, unitDecimals 6 }

TIPS  as NOTE, with
      principalRule { INDEX_RATIO, benchmarkId US_CPI_U_NSA, baseReference <refCpiOnDatedDate>,
                      lagMonths 3, interpolation DAILY_LINEAR, truncateDecimals 6,
                      roundDecimals 5, maturityFloor PAR }

FRN   as NOTE, with
      schedule.couponMonths 3
      accrual ACTUAL_360_DAILY_SUM
      rateRule { DAILY_INDEX_PLUS_SPREAD, benchmarkId US_TBILL_13W_MMY, spread <spread / 100>,
                 floor "0", lockoutBusinessDays 2, calendarId "US", dailyDecimals 9 }
```

## 5. Calendar `US`

Business days of the Federal Reserve Banks: Monday to Friday except New Year's
Day (1 January), Birthday of Martin Luther King Jr. (third Monday of January),
Washington's Birthday (third Monday of February), Memorial Day (last Monday of
May), Juneteenth National Independence Day (19 June, from 2022), Independence
Day (4 July), Labor Day (first Monday of September), Columbus Day (second Monday
of October), Veterans Day (11 November), Thanksgiving Day (fourth Thursday of
November), Christmas Day (25 December). A holiday on a Sunday is observed on the
Monday after; a holiday on a Saturday is not observed on the Friday before (the
Banks are open). Source: https://www.federalreserve.gov/aboutthefed/k8.htm.

## 6. Benchmarks

| Code | Kind, unit | Publisher, host | Observation |
| --- | --- | --- | --- |
| `US_CPI_U_NSA` | `MONTHLY`, `INDEX_LEVEL` | BLS, `api.bls.gov` | key `YYYY-MM`, the CPI-U all items NSA level as published ("335.123"); `coveredThrough` the last day of the newest month in the response |
| `US_TBILL_13W_MMY` | `STEP`, `RATE_FRACTION` | Treasury, `www.treasurydirect.gov` | one per 13-week bill auction, dated on the auction date: `r = D / (1 - D x t / 360)`, `D` the high discount rate, `t` the days from issue to maturity, rounded to nine decimals in percent (eleven as a fraction); `coveredThrough` the newest auction date |

The CPI fetcher reads the BLS public API (v2 without a key, to verify the
limits) and refuses a value that is not a positive decimal, a duplicated month,
or a month later than the request date. A revision of a published month is not
expected (CPI-U NSA is not revised; 31 CFR 356 App. B I.B.4 covers a
discontinued index); a changed stored value is logged and refused, as for the
Polish benchmarks. The 13-week fetcher reads
`TA_WS/securities/auctioned?format=json&type=Bill&days=<n>`, keeps `securityTerm`
`13-Week`, and computes the yield in `ExactDecimal`.

## 7. Golden cases

Read by `adapters/us/golden.spec.ts` from `*-cases.json`, each with its source;
computed from the official formulas, never from the engine.

| File | Cases |
| --- | --- |
| `bill-cases.json` | E1, E2, E3 of the primitives spec, on the fixture of `912797WM5` (issue 2026-10-01, maturity 2027-04-01, 26-week, 4.285 %, price 97.833694) |
| `note-cases.json` | E4, E5, E6, E7 on terms written for each App. B example (the dates and rates the appendix gives) |
| `tips-cases.json` | E8; E9 on the three TIPS of the July 2026 table (912810FD5, 912810FH6, 912810FQ6) with the CPI-U observations of March, April and May 2026; E10 |
| `frn-cases.json` | E11, E12, E13; the fixture `91282CQM6` (issued 2026-04-30, maturity 2028-04-30, spread 0.103 %, first payment 2026-07-31, quarterly) parses and its schedule has 8 quarterly periods ending on 31 July, 31 October, 31 January and 30 April (end of month) |

## 8. Missing-data policy

As INV-BOND-002 and the primitives spec: an unpublished CPI month or 13-week
auction makes the dependent figure unknown, named in `missing` with its
publisher; a coupon security's market price is never derived (the surface asks
for a manual price, primitives spec section 3); a bill lot with no cost uses the
auction price and says so (`principalBasis`).

## 9. Test matrix

| Area | Kind | Cases |
| --- | --- | --- |
| Adapter shape | unit | country, zone `America/New_York`, programs `BILL`, `NOTE`, `BOND`, `TIPS`, `FRN` with `faceValue` "100" and `infoUrl`, benchmarks with hosts, `specDoc` this file |
| Calendar | unit | every holiday of 2026 and 2027, Sunday observance (Juneteenth 2027-06-19 is a Saturday: not observed; 2022-06-19 Sunday: Monday 20 June), weekends |
| CUSIP | unit | check digit valid and invalid, series code grammar (9 or 15 characters) |
| Fetch | unit, fixtures | each program from its fixture; refusals: another host, a redirect, non-200, empty array, missing field, bill price disagreeing with its discount rate, first coupon not a regular date, JSON and XML disagreeing; no test touches the network |
| Templates | unit | every template filled from its fixture parses |
| Golden | golden | section 7 |
| Benchmarks | unit, fixtures | BLS response parsed, refusals; 13-week yields from a saved auction list |
| Guards | guard | `adapter-docs.guard.spec.ts`, `no-automatic-bonds.guard.spec.ts`, `country-agnostic.guard.spec.ts` (US literals added to `FORBIDDEN`) |

## 9a. Decisions of phase 3

Points the sections above left open, as built (`backend/src/bonds/adapters/us/`):

- **Error codes.** An empty answer is `SERIES_NOT_PUBLISHED` (the existing code;
  there is no `SERIES_NOT_FOUND`). A TIPS or FRN is refused with the new
  `PRODUCT_NOT_SUPPORTED` (param `product`, `TIPS` or `FRN`), before the results
  file is requested; phase 4 removes the refusal. A permanent 4xx on the JSON or
  the XML is `SOURCE_DOCUMENT_MISSING` (param `document` `auction data` or
  `results`); 5xx, 429, a redirect, a timeout and a network error are
  `SOURCE_UNAVAILABLE`; a body over 2 MB (JSON) or 1 MB (XML) is
  `SOURCE_FORMAT_CHANGED` `field=size`.
- **Which code names what.** A bare CUSIP whose answer holds a bill, or a
  15-character code whose auction is not a bill, is `SERIES_CODE_INVALID`.
  `programOf` answers `BILL` only for a valid 15-character code with CUSIP
  prefix `912797`; the adapter has no `seriesCodeFor`, `currentSeries`,
  `backfillCodes` or `manualSeries`, so the purchase form's "Fetch" offer does
  not exist for the US yet (to build: an input for a CUSIP, see section 10).
- **Fields read.** `securityTerm` is not read: it names the original term, which
  is not the days of a reopened bill; the bill's term is its issue to maturity
  days (28 to 364). `xmlFilenameCompetitiveResults` is the field that names the
  results file; only a plain `*.xml` file name is requested, under `/xml/`. A
  JSON number is refused where a string is expected. `interestPaymentFrequency`
  must read semiannual (case-insensitive, `Semi-Annual`) for a note or a bond.
- **Cross-checks as built.** A bill: the price formula (six decimals, half up,
  `ExactDecimal`), the term, an auction not after its issue, a price below 100
  and a nonzero rate. A coupon security: the rate 0 to 20 %, the dated date not
  after the issue, the maturity after the issue and at most 31 years out, the
  first coupon a regular date (`buildCouponSchedule`, maturity at a month end
  gives `endOfMonth`). The results file: `CUSIP`, `SecurityType` (case folded),
  `IssueDate`, `MaturityDate`, a note's `DatedDate` and `InterestRate` (the
  results element, else the announcement's), and `HighPrice` (required for a
  bill, compared for a note when both state it).
- **Terms.** The bill's `issuePrice` is `highPrice` as stated; a note's
  `annualRate` is the percent over 100 as an exact fraction ("0.04285");
  `source` is `{ provider "treasurydirect", url the search URL, document "auction
  <auctionDate>" }`; `publishedAt` the auction date. A bill's `unitDecimals` is
  null (the price is exact to six decimals and the holding is rounded once).
- **API.** `GET /bonds/programs` gives each program its `faceValue` (the
  template's nominal, "100" for the US) so the form can say "One unit = 100 USD
  face value" without naming a country.
- **Guard.** `country-agnostic.guard.spec.ts` forbids `USD`, `US`, `BILL`,
  `NOTE`, `TIPS`, `FRN` and `treasurydirect` in the domain, the engine and the
  shared services; `BOND` is not listed, it is the domain's own word.

## 10. To verify before merge

The shell of the session that wrote this could not reach `treasurydirect.gov`,
`api.bls.gov` or `api.fiscaldata.treasury.gov`; these points are inferred and
must be checked against live responses, and the constructed fixtures replaced by
recorded ones:

- The TA_WS JSON field names and value formats (`"Yes"`/`"No"` flags, dates with
  a time part, rates in percent as strings), the name of the field that gives the
  results XML file, and the `securityType` values of a TIPS and an FRN. The
  fixtures `ta-ws-*.json` under `adapters/us/series/fixtures/` are built from the
  XML fixture and #1908 and are marked as constructed in their file header note
  (`fixtures/README.md`).
- That a TIPS coupon uses the index ratio of the unadjusted coupon date when that
  date is not a business day.
- The BLS API version and limits without a key, and the TA_WS `days` limit for
  the 13-week history an FRN issued two years ago needs.
- The FRN rule for an auction on the day of a lockout boundary (App. B I.C.3).
- The phase 3 fetch reads only fixtures: the live `search` answer for a bill, a
  note and a reopening, the exact `interestPaymentFrequency` text, whether a
  bill's price is rounded or truncated at the sixth decimal, whether the results
  file names a note's coupon in `AuctionResults` or only in the announcement, and
  whether a CMB shorter than 28 days (refused here) exists as a security people
  hold.
- The purchase form has no way to name a CUSIP (no `seriesCodeFor`): a person
  fetches through `POST /bonds/instruments/fetch` until a CUSIP input is built.
- Savings bonds: whether the value of a 100 USD bond is computed from a 25 USD
  bond (31 CFR 359 Appendix A) before the book-entry scaling.
