# Spec: FX conversion completeness

Status: approved for implementation on `claude/detailed-error-review-54i3b3`.
Governs: audit finding P5-009 (missing exchange rates silently treated as 1:1)
and design risk DR-02 (look-ahead to a future rate before history begins).

Read `docs/financial-calculation-contract.md` section 1 first; this spec applies
that rule to currency conversion specifically.

## 1. The defect this replaces

Two conversion paths turned "no rate available" into "rate 1.0":

```typescript
// net-worth.service.ts
const result = convertWithRateLookup(amount, from, to, getRate);
return result ?? amount;                    // <- 1:1

// portfolio-calculation.service.ts
rate = reverseRate !== null ? 1 / reverseRate : 1;   // <- 1:1
```

`convertWithRateLookup` returns `null` precisely so the caller can decide, and
both callers decided to lie. 1,000 USD reported into a EUR total came out as
1,000 EUR rather than 900 EUR: an 11.11% overstatement that is *numerically
plausible*, which is what makes it dangerous. Nothing in the response let a
consumer tell a real 1:1 pair (USD/USD, or a genuinely pegged pair) from an
absent one.

## 2. Invariants

1. **Rate 1 is only ever used when the source and destination currency are the
   same string.** No other branch may produce it as a fallback.
2. A conversion has three outcomes, and they stay distinguishable:
   - `{ value, rate, known: true }` -- a rate was found (or none was needed).
   - `{ value: null, rate: null, known: false }` -- no rate exists for the pair.
   - It is never `{ value: amount, rate: 1 }` for differing currencies.
3. **A total containing an unconverted component is not a total.** Per the
   financial calculation contract section 1, the total field is `null` and the
   partial sum, when still useful, goes in a separately named field with the
   reason attached.
4. A conversion gap is **named**, following the existing `ReplayedLot.basisGap`
   precedent: the response says which pair could not be resolved, not merely
   that something was wrong.
5. Zero is not a valid rate. `convertWithRateLookup` already rejects an inverse
   rate of 0; a direct rate of 0 or a negative rate is equally invalid and is
   treated as absent rather than applied.

## 3. Shape

```typescript
type FxGap = "missing_rate" | "value_unknown";

interface FxTotal {
  /** null unless every component converted. */
  total: number | null;
  /** Sum of the components that did convert. Always present. */
  knownSubtotal: number;
  /** "USD->EUR" for each pair that had no rate. Empty when complete. */
  missingPairs: string[];
  /** Components left out for a reason with no pair to name. */
  unknownCount: number;
}
```

`FxAggregate` (`backend/src/common/fx-aggregate.ts`) accumulates this. Callers
add signed amounts and read the quadruple at the end; they never branch on `null`
themselves, which is what kept the old code's `?? amount` out of sight. Each
component is rounded to four places half away from zero by `roundMoney` before
it is accumulated, so `-0.00005` adds `-0.0001` exactly as `roundMoney` answers
it; a bare `Math.round(x * 10000)` rounded a negative midpoint toward zero
(Discussion #2136).

**A component can go missing for two reasons, and only one of them has a
currency to blame.** A missing *rate* is a fact about a pair, and naming it
(`missingPairs`) tells the reader what to fix. A component whose *value* is
unknown -- a scheduled occurrence whose own settlement rate could not be
resolved, an unpriced holding -- is unknown in every currency, so filing it under
a pair would send the reader to refresh a rate that is already there. `addUnknown`
records it by count instead (`unknownCount`), and `isComplete` is false for
either cause: checking `missingPairs` alone reported a total containing an
unpriceable component as complete. `frontend/src/lib/currency-total.ts` splits
the same two causes as `missingCurrencies` and `excludedCount`.

## 4. Numerical examples

| Components | Rates available | total | knownSubtotal | missingPairs |
| --- | --- | ---: | ---: | --- |
| 1,000 USD into EUR | USD->EUR 0.9 | 900 | 900 | [] |
| 1,000 USD into EUR | EUR->USD 1.1111 (inverse only) | 900.0090 | 900.0090 | [] |
| 1,000 USD into EUR | none | `null` | 0 | ["USD->EUR"] |
| 500 EUR + 1,000 USD into EUR | none for USD | `null` | 500 | ["USD->EUR"] |
| 500 EUR + 1,000 USD into EUR | USD->EUR 0.9 | 1,400 | 1,400 | [] |
| 0 USD into EUR | none | 0 | 0 | [] |
| 1,000 EUR into EUR | n/a, same currency | 1,000 | 1,000 | [] |
| 1,000 USD into EUR | USD->EUR 0 | `null` | 0 | ["USD->EUR"] |

Note row 6: **zero needs no rate.** Zero converts to zero at any rate, so a
zero component records no gap -- an emptied foreign account is a settled zero,
not an unknowable value, and both conversion doors (`convertToDefault` and
net worth's `convertCurrency`) short-circuit it before the rate lookup. Note
also row 3 vs row 8: a `knownSubtotal` of 0 can mean "nothing converted"; only
`missingPairs` distinguishes it from a real zero, which is why it is not
optional.

Note the last row: an empty portfolio holds zero and reports `total: 0` with no
missing pairs -- zero is a known answer. `null` is reserved for "not known", per
`AGENTS.md` rule that the two must not be conflated.

## 4a. Staging: what lands now, and what follows

Making `assets` / `liabilities` / `netWorth` / `totalPortfolioValue` nullable is
the correct end state and it changes public response shapes, every chart that
reads them, and the copy that explains a partial total in 22 locales. That is a
separate change with its own frontend work; landing it half-done would leave
charts rendering `null` as a gap in the line with nothing telling the user why,
which is a worse failure than the one being fixed.

**Stage 1 (this branch).** The silent lie is removed and the gap is made
visible:

- `convertToDefault` and `convertCurrency` return `null` for an unresolvable
  pair. Rate 1 is unreachable unless the currency codes are equal.
- Every aggregation accumulates through `FxAggregate`, so an unconvertible
  component is *recorded*, never folded in at 1:1.
- The existing numeric total field carries `knownSubtotal`, and the response
  gains `missingRatePairs` (and `fxComplete`) beside it. A consumer can see
  exactly which pair is missing -- which satisfies the contract's "silence is
  what turns a subtotal into a lie" requirement even before the field goes
  nullable.
- Every such aggregation logs at warn level with the pair and the date.

**Stage 2 (follow-up).** `total*` fields become `number | null`, frontend charts
render an explicit "incomplete" state, and the copy is translated. The
`FxAggregate.total` getter already implements the nullable semantics and is
covered by tests, so stage 2 is a matter of changing the field each call site
reads (`knownSubtotal` -> `total`) plus the consumer work.

Stage 1 is therefore strictly better than the previous behaviour and does not
pretend to be stage 2. `fxComplete: false` with a numeric subtotal is a known,
documented interim state, not an assertion that the total is complete.

## 5. Persisted snapshots (deliberately out of scope here)

`monthly_account_balances` stores converted values. Marking a persisted snapshot
incomplete needs a schema column and a migration, and is therefore a separate
change; this spec covers the calculation and response layers. Until that lands,
a snapshot row whose conversion was incomplete is written from the
`knownSubtotal` **and** logged at warn level with the missing pairs, so the gap
is observable rather than silent. This is recorded as a known limitation, not as
correct behaviour.

## 6. DR-02: look-ahead -- closed, the fallback is removed

`findBestRate` used to fall back to the *earliest* available rate when none
existed on or before the valuation date, which values a historical point using
a rate from its future. That is look-ahead, and the time-series contract
forbids it. The original decision here was to keep it and log it, and to leave
changing it as a product decision "not made here".

**Issue #1390 makes that decision: the fallback is removed.** What it produced
was not an approximation but a different number every time the history moved,
and the case that reported it was a 285-day hole in `exchange_rates` back-filled
with a rate first observed nine months after the dates it was pricing --
silently, because the figure looked plausible and the only signal was a log
line nobody reads. A rate struck after a date is not evidence about that date.

The same issue settles the other half, which DR-02 never covered: an
**unboundedly old** carried-forward rate is not a rate either. Section 2.2 of
`docs/time-series-contract.md` already says an exchange rate is a price; a
price from nine months ago does not describe today any more than one from next
June does.

The policy now, in one place -- `backend/src/common/time-series/fx-rate-resolver.ts`:

| Question | Answer |
| --- | --- |
| Which observation prices a date? | The most recent one dated **on or before** it, in either stored direction. |
| How old may it be? | At most `FX_MAX_RATE_AGE_DAYS` (45). Long weekends, public holidays on either side and a provider outage fit comfortably inside that; a market move does not. |
| Direct or inverse? | Whichever observed the date more recently. A tie goes to direct, so the answer is deterministic. (2026-09-19: a pair is now stored in one orientation, INV-FX-003, so for rows written since then only one of the two exists and this rule decides nothing. It still decides for older rows, until the contract migration collapses them.) |
| Nothing admissible? | `null`, with a named reason: `no_observation`, `only_after_date`, `stale_observation`, `unknown_currency`, `invalid_date`. |
| A date that names no day? | Unknown, with reason `invalid_date`. A request parameter declared `string` may arrive as an array, and every rule above is a lexicographic comparison of `YYYY-MM-DD` strings. |
| Equal codes? | `1`, without consulting the history. Nothing else may produce `1`. |
| Missing code? | Unknown. Not `1`. |
| "Right now"? | `live` mode: the freshest observation, under the same age bound. |

Every rate lookup that feeds a reported figure routes through it, each in the
mode that matches the question it is answering. The dated doors are
`convertAtDate` / `resolveIndexedRate` (the chart and daily-balance indexes),
`ExchangeRateService.resolveStoredRate` and `getRateForDate`,
`PortfolioCalculationService.resolveDailyRate` (the intraday chart's own
per-bar close) and `InvestmentReportDataService.fxRate`. The `live` doors --
`ExchangeRateService.getLiveRate` and
`PortfolioCalculationService.convertToDefault` -- answer "right now" and are
bounded by the same age rule but **not** dated: `convertToDefault` is not a
historical lookup, and a caller holding a date must not use it as one.

**Closed: the capital-gains report now converts each boundary at its own
date.** `calculateCapitalGains`' local `fxRate` used to value every past
position through the live door at `todayYMD()`, so a past period's figure moved
with today's currency market -- and one rate priced both ends of every period,
which read a currency's move over the window as no move at all. It now takes the
dated historical door (`resolveStoredRate` in `historical` mode) at the
boundary's own date: the start value uses the FX at `priceLookupStart`, the end
value the FX at `periodEnd`, cached per `(pair, date)`. A boundary whose pair has
no admissible rate on or before its date is `null` per section 2 (not a silent
1:1 and not today's rate), and a held position with no accepted price on a
boundary is `null` too rather than valued at zero; a genuine zero quantity is
zero without a rate. (`calculateTWR`'s `computeValueAtDate` was the other half of
this gap and is gone with the function: the summary's time-weighted return is
now the invested measure, which converts every day at its own rate through the
shared rate index.) `buildRateIndex` and
`buildDailyRateIndex` load the reported window plus one age bound before it,
rather than a fixed day margin, so a date's rate does not change when the chart
around it is widened. A caller that converts at a date *later* than the window
it asked for states that date as `buildRateIndex`'s `conversionHorizon`:
`NetWorthService` prices every monthly point at the month end, so its wrapper
passes `monthEndDate(endDate)` and a June point is the same figure whether the
range ends 2024-06-15 or 2024-07-31. The loader never widens on a guess, so a
caller that converts inside its window loads exactly its window. `backend/src/common/time-series/fx-rate.one-door.spec.ts`
fails a new newest-rate read outside the door and carries the shrink-only
baseline of the dateless call sites that remain.

**A rate is not the only thing that can be missing, and the two are not one
flag.** In the investment report an unpriced holding withholds the portfolio
denominator by exactly the same arithmetic as an unresolvable pair, so
`InvestmentReportDataService.computeHoldings` answers `pricesComplete` and
`unpricedSymbols` beside `fxComplete` and `missingPairs`, and
`InvestmentReportViewer` reads each `=== false` and names the cause it has. One
flag for both would have sent a reader to the Currencies screen to repair a
price.

Reporting the gap to API consumers is still the `FxAggregate` quadruple of
section 3: a pair the resolver refuses lands in `missingPairs` and clears
`fxComplete`, exactly as a pair with no rows at all does. The *reason* travels
in the warn log (once per pair per computation) rather than on the pair string,
because `missingPairs` is a public field the frontend reads.

## 7. Test matrix

Every row of section 4, plus:

- same currency, no rates loaded at all;
- direct rate present, inverse absent, and the reverse;
- direct rate of 0 and a negative direct rate (treated as absent);
- a mixed portfolio where exactly one of three currencies is unresolvable --
  asserts `total === null` while `knownSubtotal` covers the other two;
- a liability component (negative amount) that cannot convert;
- the look-ahead case: rate history starts after the valuation date;
- assertion that no code path returns `amount` unchanged for differing
  currencies (source-scanning guard on `?? amount` beside a conversion).

## An amount and its currency are one value, and an aggregate spans one currency or none

A helper that takes a currency and never reads it is worse than one that has no currency at all: `sumEffectiveOccurrences`'s deleted predecessor accepted `{amount, currencyCode}` and summed only the numbers, so passing it the *right* code fixed nothing and a 1,350 CAD occurrence joined a 500 USD one as 1,850 in the reader's default currency. Convert before summing -- `FxAggregate` on the server, `sumConverted` / `sumEffectiveOccurrences` on the client -- and make the missing rate nameable: a pair with no rate withholds the total and is reported (`upcomingBillsMissingRates`, `LlmUpcomingScheduledResult.missingRatePairs`, `ConvertedTotal.missingCurrencies`), while a component whose own value is unknown is excluded by count, because it is unknown in *every* currency and naming a pair would send the reader to fix a rate that is already there -- two causes, two repairs, so a surface that folds them into one message sends the reader to the wrong one. **A total also has to say which currency it is in**: `totalsCurrency` travels beside the AI/MCP rollups and is named in the summary line a model quotes, because the items keep their own settlement currencies and a bare number is what let a CAD figure be read as USD. Formatting is the same rule at one row's scale: `formatCurrency(amount)` with no code prints whatever the reader's default is.

### The currency a total falls back to is one constant, and it is derived, not restated

Thirteen sites spelled out `pref?.defaultCurrency || "USD"`; ten said USD, two said CAD, and one hid CAD behind a local `DEFAULT_CURRENCY`, so Portfolio and the GEM report quoted one user's money in a currency Net Worth never used. It was **twenty-three** copies across both layers -- sixteen USD, seven CAD, one of those behind a local `DEFAULT_CURRENCY` alias -- so two widgets on one dashboard disagreed and a preference-less user's bills page converted and labelled in CAD while the assistant answered the same question in USD. `preferredCurrency` / `resolveUserDefaultCurrency` (`backend/src/common/default-currency.util.ts`) and `preferredCurrency` (`frontend/src/lib/default-currency.ts`) are the only readers, `FALLBACK_DEFAULT_CURRENCY` the only literal on each side -- and the currency the startup hook guarantees a `currencies` row for is that same constant, since a fallback to a code with no row resolves no rate and withholds every converted total. `default-currency.guard.spec.ts` and `default-currency.contract.test.ts` scan their own layer for the shape and for an aliased copy, check the constant against the column's own default, and check the two layers against each other -- because a per-layer constant is exactly how the drift came back.
