# Spec: FX history is filled over the span the currency is used

Status: approved, implemented alongside this document.

Related: `docs/specs/exchange-rate-canonical-orientation.md` (INV-FX-003),
`docs/financial-calculation-contract.md`, `docs/time-series-contract.md`
section 2.2, `docs/backend/securities-and-providers.md`.

## 1. What this changes, and why

A currency pair's stored history normally begins the day the nightly refresh
first ran. The cron writes today's spot rate only, and
`ExchangeRateService.backfillHistoricalRates` skips a pair the moment it holds
any row in either direction. Every report dated before that reports a missing
rate, correctly and permanently.

The user-facing door for this was `POST /currencies/exchange-rates/extend-history`,
which fetched the calendar year immediately before the earliest stored rate.
Walking back twenty years meant pressing a button twenty times, and it could
only extend the lower bound: a hole in the middle of the stored span, which is
what a partial on-demand fill leaves behind, was unreachable from any screen.

This replaces it with a fill that takes its span from the user's own data and
targets the holes:

- `GET /currencies/exchange-rates/stored?code=EUR` lists what is stored, so the
  holes are visible rather than inferred from an observation count.
- `POST /currencies/exchange-rates/fill-gaps` fetches the windows that are
  missing between the first date the currency is used and today.

An import and a backup restore run the same fill themselves, in the
background, for each foreign currency the imported or restored accounts use, so
a reader who imports or restores years of history does not have to press
anything (issues #2186 and #2226). It repeats the bounded fill while windows
remain and the last round got an answer, up to
`RATE_HISTORY_CATCH_UP_MAX_ROUNDS` rounds per currency
(`backend/src/currencies/rate-history-catch-up.service.ts`).

## 2. Definitions

**Reporting currency.** The caller's `user_preferences.default_currency`,
resolved server-side by `resolveUserDefaultCurrency`. A request names a
currency code, never a pair.

**The pair.** `code -> reportingCurrency`. The same-currency case is a 400: 1 is
not a stored observation.

**Display direction.** Units of the reporting currency per 1 unit of `code`.
A row stored in the other orientation is shown as `roundFxRate(1 / rate)` and
flagged `inverted`.

**Unresolvable date.** A date for which `resolveFxRate` in `historical` mode
can find no admissible observation: no stored observation for the pair, in
either stored direction, dated within `FX_MAX_RATE_AGE_DAYS` (45) before it.
Never a date merely lacking a row of its own. This is what a reader is *told*
about, and it is deliberately not what is *fetched*.

**Sparse date.** A date with no stored observation for the pair within
`MAX_OBSERVATION_GAP_DAYS` (10) before it. Ten days clears every ordinary
market closure -- a weekend is three, Easter's Thursday-to-Tuesday five,
Christmas Eve to the 2nd of January nine -- and does not clear a month.

**Why two bounds.** A history holding one observation per month is resolvable
on every date and wrong on 29 days in 30, each priced at a rate struck weeks
earlier. Planning on the 45-day bound reports such a pair as complete and
fetches nothing, which is exactly what a history assembled by earlier
decade-wide requests looks like: Yahoo answers those with monthly bars, and
`persistRateSeries` stores them as daily observations. The density bound
decides what to fetch; the carry-forward bound decides what to report.

**Gap.** A maximal run of consecutive sparse dates.

**Span.** `[spanStart, today]`, where `spanStart` is the latest of `firstUse`
(the earliest date the currency appears in the caller's data, section 4), the
pair's `earliest_available_date`, and its `first_gap_date`.

**Window.** One provider request: a contiguous date range of at most
`GAP_WINDOW_MAX_DAYS` (365). Gaps close enough to share one are packed into
one: a request covering a year costs what a request covering a fortnight costs
and overwrites every date it spans, so covering two nearby holes and the rows
between them in one call is strictly cheaper than two calls that skip those
rows. Month-end-only history is what makes this necessary rather than tidy --
its holes recur monthly, and one window each would turn a decade into 120
requests at eight a press.

**Provider floor.** `exchange_rate_coverage.earliest_available_date`: the
earliest date the provider is known to carry a rate for the pair. Nothing
before it is asked for again.

**Resume pointer.** `exchange_rate_coverage.first_gap_date`: the earliest date
whose gap has not yet been put to the provider. It only ever moves forward, and
a window that was asked for is behind it whether the provider filled it densely
or gave all it had -- otherwise a stretch the provider can only answer sparsely
is re-fetched every press and the ground past it is never reached. Gaps *after*
it are still planned, because the span always runs to today.

**Probe mark.** `exchange_rate_coverage.probed_from`: the earliest date any
fill has planned over for this pair, moving backwards only. It is what makes
the resume pointer safe rather than merely fast. A reader who imports older
transactions moves `firstUse` behind everything probed so far; the pointer
would then sit in front of years nothing has ever examined and hide them for
good. When `firstUse` reaches back further than the probe mark, the pointer is
stood down for one press and the newly reachable years are planned. The
provider floor is unaffected -- older data of the reader's says nothing about
where the provider's history starts.

**Why a table and not two columns on `currencies`.** Both facts belong to a
pair: Yahoo's history for USD/CAD and for USD/PLN begins on different days. A
column on `currencies` can hold one pair per currency, so a deployment whose
readers report in different currencies has them overwrite each other.
`exchange_rate_coverage` holds one row per pair, in the canonical orientation
only (`from_currency < to_currency`), held by a CHECK constraint rather than by
a convention in the writer -- a rate window answers a pair, not a direction.
The row is also scoped to the provider chain that wrote it: `providers` holds
the ordered source slugs, a row under any other value (or `NULL`) reads as all
three dates unestablished, and the next write replaces them rather than
applying `GREATEST`/`LEAST`, because a floor one set of providers established
says nothing about another.

## 3. Invariants

This spec introduces no new invariant ID. It is bound by three existing ones.

### INV-FX-001 -- an unavailable rate is not 1:1

The fill never invents a rate. A window the provider has no data for leaves
those dates unresolvable, and every surface continues to withhold the figure
with its cause. `stored: 0` is reported as "the provider carries nothing that
far back", never as success and never as a reason to substitute 1.

### INV-FX-003 -- a pair is stored in one orientation

The fill adds no writer: it reaches the provider through
`ExchangeRateService.fillRateWindow`, whose `persistRateSeries` already orients
every row through `canonicalRateRow`. The listing is a read, which the
orientation guard deliberately does not police.

The contract half of INV-FX-003 has not shipped, so a date written before that
change may still be held in both orientations. The listing shows such a date
**once**, keeping the canonical row, which is the same row the pending contract
migration keeps when the two disagree. The listing therefore needs no change
when that migration lands.

### The report-facing rule this exists to serve

A figure withheld for a missing rate names what is missing and where to get it
(`docs/financial-calculation-contract.md` section 1.3). This is the "where to
get it": the screen that reports the gap and the button that closes it.

## 4. The span

`firstUse` is the earliest of:

- the earliest `transactions.transaction_date` and non-VOID
  `investment_transactions.transaction_date` in any account whose
  `currency_code` is the requested code, and
- the earliest non-VOID `investment_transactions.transaction_date` for any
  security whose `currency_code` is the requested code and which is held in one
  of the caller's accounts.

This is the shape `backfillHistoricalRates` already uses, with one deliberate
difference: **closed accounts, inactive securities and zero-quantity holdings
count.** That backfill primes rates for current positions, so it filters them
out; a history fill must not, because "net worth over time" and "portfolio
value over time" cover the years a since-closed account was open.

An account or security with no postings falls back to its own creation date
rather than dropping out of the answer: an account holding an opening balance
and nothing else is still reported by "net worth over time", and telling its
owner that nothing of theirs uses the currency would leave them no way to fetch
the rates their own balances need. That is the fallback
`resolveInvestmentInception` already uses for an account with neither ledger.

`firstUse` of `null` therefore means no account and no security of the caller's
is denominated in the currency at all. There is then no report that needs the
rate, so the response says so and no provider call is made.

A non-positive stored rate is not an observation. `resolveFxRate` discards it,
so the gap planner must discard it too: counting it would leave the 45 days
after it looking answerable while every report over them still refuses to
convert.

### `exchange_rate_coverage` bounds the span from below

Two facts about a pair, both of which the fill would otherwise re-derive on
every press and keep neither.

**The provider's floor** (`earliest_available_date`). A provider's history
starts where it starts and nothing the reader does moves it: Yahoo carries no
`USDCAD=X` before December 2003, against a ledger that may open in 1996. Those
seven years are not a gap anybody can fill, so the span opens there rather than
at `firstUse`. Established when the leading run of planned windows comes back
empty; recorded as the day after that run ends.

**The resume pointer** (`first_gap_date`). The earliest date whose gap has not
yet been put to the provider. A window is behind the pointer once the provider
has *answered* it, whether it came back dense or came back as sparse as it
started -- that answer is the provider's best, and asking a third time only
spends the next press's budget on it. A window the provider did not answer at
all stays in front of the pointer: the fetch proved nothing about its dates.

**The probe mark** (`probed_from`). The earliest date any fill has planned
over, moving backwards only. Without it the pointer is unsafe: a reader who
imports older transactions moves `firstUse` behind everything probed, and the
pointer would hide those years permanently. When `firstUse` is earlier than the
probe mark the pointer is stood down for one press, and the probe mark follows
the span back so the press after that resumes normally.

The first two only ever move forward and the third only ever moves back, and
the database enforces that rather than the caller: the upsert is
`GREATEST(existing, proposed)` and `LEAST(existing, proposed)`, both of which
ignore nulls in PostgreSQL, so an unset column takes the new date, a set one
keeps the better of the two, and a concurrent fill cannot rewind any of them. A
pointer that moved backwards would re-plan the years the press before it had
just answered.

Both are **properties of the pair, not of a currency**: Yahoo's history for
USD/CAD and for USD/PLN begins on different days. One row per pair, in the
canonical orientation only, with a CHECK constraint holding it. The earlier
shape -- two columns on `currencies` naming a counter-currency -- could hold
only one pair per currency, so a deployment whose readers report in different
currencies had them overwrite each other.

The query runs under the caller's identity through `withScopedDb`: accounts,
transactions, securities and investment transactions are per-user tables, while
`exchange_rates` is RLS-exempt shared reference data read in the same scope.

## 5. Truth tables

### `planRateGapWindows(storedDates, spanStart, spanEnd)`

| Stored observations in the span | Windows planned |
|---|---|
| none | one gap covering the whole span, chunked |
| daily, no stretch of 11+ days unobserved | none |
| daily except a 9-day hole | none; inside the density bound |
| daily except a 21-day hole | one window over the hole, padded back |
| one observation per month, one year | one window; `unresolvableDays` is 0 |
| one observation per month, ten years | about ten windows, one per year |
| two holes less than a year apart | one window covering both and what is between |
| two holes more than a year apart | two windows; the bound refuses to join them |
| one hole spanning 900 days | three windows of at most 365 days |

### One window's provider outcome

| `fillRateWindow` returns | Meaning | Response |
|---|---|---|
| `stored > 0, answered: true` | rates written | counted in `stored` |
| `stored: 0, answered: true` | the provider has nothing there | window remembered empty; on the oldest window, reported as `providerHasNothingBefore` |
| `stored: 0, answered: false` | no answer (transport, or the breaker refused) | 503 when nothing at all was stored; otherwise reported as windows left over |

### The request as a whole

| Condition | Result |
|---|---|
| `code` is the reporting currency | 400 |
| currency not used by any of the caller's data | 200, `usedFrom: null`, no fetch |
| no gap in the span | 200, `windowsPlanned: 0`, no fetch |
| more windows than the cap or the budget allows | 200, `windowsRemaining > 0`; pressing again continues |
| some windows unanswered, others stored rates | 200, the unanswered ones counted in `windowsRemaining` |
| first window got no answer, nothing stored | 503 |

## 6. Missing-data policy

A rate that cannot be fetched stays absent. Nothing in this path writes a
substituted, interpolated or carried-forward row: carry-forward is a read-time
rule in `resolveFxRate` with a 45-day bound, and writing it into the table
would turn a bounded inference into a stored fact.

Where the provider's history simply starts later than the user's data, the
response names the earliest date it carries so the reader learns the figure is
unobtainable rather than unfetched.

## 7. Numerical examples

Reporting currency PLN, code EUR, so the pair is `EUR->PLN` and the canonical
orientation is `EUR->PLN` (`E` < `P`).

1. **Inversion.** Reporting currency USD, code PLN. Canonical orientation is
   `PLN->USD` (`P` < `U`), so a stored `PLN->USD` row of `0.25` is the display
   direction already: 1 PLN buys 0.25 USD. For code USD with reporting currency
   PLN the same row is shown inverted: `roundFxRate(1 / 0.25) = 4`.
2. **Inversion precision.** A stored `0.7325` inverts to `1.3651877133`, not
   `1.3652`: the reciprocal is struck at the rate column's ten decimals
   (`roundFxRate`), never at money's four.
3. **A weekend is not a gap.** Observations on Friday the 4th and Monday the
   7th leave the 5th and 6th without rows, but both resolve to the 4th's
   observation, 1 and 2 days old, well inside 45.
4. **A 46-day hole is a gap.** Last observation 1 March, next 20 April. 16
   April is 46 days after 1 March, so 16 to 19 April are unresolvable and form
   a gap; 2 March to 15 April resolve by carry-forward.
5. **Window padding.** A gap of 16 to 19 April is fetched as 2 to 19 April:
   `BOUNDARY_LAG_DAYS` (14) of lead, so the gap's first day has an observation
   to carry forward from even if the provider's first bar lands late.
6. **Chunking.** A gap from 2010-01-01 to 2012-06-30 (911 days) becomes three
   windows of at most 365 days, because one deep request comes back as monthly
   bars.

## 8. Concurrency and idempotency

The write is the existing idempotent upsert on the natural key
`(from_currency, to_currency, rate_date)`, mechanism 4 of
`docs/concurrency-and-idempotency.md`, so two concurrent fills of the same pair
converge rather than duplicate.

`ExchangeRateHistoryService.inFlight` coalesces a double-clicked button into one
fetch. It is a coalescer, not a guard: it gates no row, coordinates nothing
across replicas, and losing it costs a round trip. It is keyed by **caller and
pair**, not by pair alone, because the summary describes the caller's own data:
two people sharing a reporting currency would otherwise both be handed the
first one's span and a window count computed for somebody else.

`EmptyWindowMemory` remembers a window the provider answered nothing for, for
thirty minutes. Also a cache, not a guard, in the category
`docs/cron-jobs.md` allows process-local state to sit in: a replica that has not
seen the miss simply makes the call again.

Windows are fetched **sequentially**, for two reasons that are both recorded
defects elsewhere. A burst of windows from inside one HTTP request is what
rate-limits everybody (`series-rate-fill.ts`). And only one concurrent call can
hold the circuit breaker's half-open probe, so parallel windows get refused and
read as empty years (`market-index.service.ts`).

Rate limiting needs nothing else: `YahooFinanceService.throttledFetch` caps
concurrency at five, leaves a 100 ms inter-request gap, retries 429 and 503
honouring `Retry-After`, and sits behind `ProviderHealthService`'s breaker. The
route keeps the 6-per-minute throttle its predecessor had.

## 9. Bounds, and what they cost

| Bound | Value | Why |
|---|---|---|
| `GAP_WINDOW_MAX_DAYS` | 365 | a wider request returns monthly bars, and `persistRateSeries` has no daily-spacing guard |
| `MAX_GAP_WINDOWS` | 8 | one press is a bounded number of provider calls |
| | | applied **after** dropping windows already known empty, never by the planner |
| `GAP_FILL_BUDGET_MS` | 20000 | a person is waiting on the request |
| `STORED_RATE_ROW_CAP` | 2000 | the listing is a scrollable dialog, not an export |

What a bound leaves out is reported (`windowsRemaining`, `truncated`), never
silently dropped. Pressing the button again continues from where the last press
stopped, because the plan is recomputed from what is stored.

**A window the provider has already answered with nothing must not consume the
budget.** It cannot be filled by asking again, so counting it against the cap
lets a pair whose history starts long after the reader's data does spend every
press skipping the same dead years, fetching nothing and never reaching the
windows that would answer. The planner therefore plans the whole span and the
service drops the known-empty windows before taking its `MAX_GAP_WINDOWS`.

A twenty-six-year gap is therefore roughly twenty-six windows, or four presses.
That is the accepted cost of daily bars.

## 10. What gets overwritten

`persistRateSeries` upserts with
`ON CONFLICT ... DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source`,
so every stored row inside a fetched window is replaced by the provider's value,
including a rate imported from Money.

This is why the fill targets gap windows rather than re-fetching the span. It
is also the cost of packing nearby gaps into one request: the rows between two
packed holes are re-fetched and overwritten with the provider's own value for
those dates. That is accepted because the alternative does not work -- a
month-end-only decade has a hole every month, and planning one window each
makes a decade 120 requests at eight a press, which no reader will sit through.
`GAP_WINDOW_MAX_DAYS` bounds the damage: two holes more than a year apart
cannot share a window, so a dense stretch between distant holes is never swept
up.

## 11. Test matrix

| Claim | Where | Kind |
|---|---|---|
| a weekend is not a gap; a 21-day hole is | `rate-gap-plan.spec.ts` | unit |
| a market's longest ordinary closure is not a gap | `rate-gap-plan.spec.ts` | unit |
| a month-end-only history plans windows with `unresolvableDays` at 0 | `rate-gap-plan.spec.ts` | unit |
| the two bounds are separate, and a caller cannot conflate them | `rate-gap-plan.spec.ts` | unit |
| a year of monthly holes packs into one request, a decade into about ten | `rate-gap-plan.spec.ts` | unit |
| holes more than a window apart stay separate requests | `rate-gap-plan.spec.ts` | unit |
| a window is padded by the boundary lead | `rate-gap-plan.spec.ts` | unit |
| a multi-year gap splits into 365-day chunks | `rate-gap-plan.spec.ts` | unit |
| the cap keeps the oldest windows and reports the remainder | `rate-gap-plan.spec.ts` | unit |
| first use spans accounts and securities, closed ones included | `exchange-rate-history.service.spec.ts` | unit |
| an account with no postings still dates a use, from its creation date | `exchange-rate-history.service.spec.ts` | unit |
| an unanswered window is reported as still to do | `exchange-rate-history.service.spec.ts` | unit |
| two callers sharing a reporting currency get their own summaries | `exchange-rate-history.service.spec.ts` | unit |
| a known-empty window costs no place in the budget, so the next press reaches new ones | `exchange-rate-history.service.spec.ts` | unit |
| the floor names the day after the dead run ends, not after its first window | `exchange-rate-history.service.spec.ts` | unit |
| the span opens at a recorded floor rather than at first use | `exchange-rate-history.service.spec.ts` | unit |
| the span resumes at `first_gap_date` rather than re-asking for what is behind it | `exchange-rate-history.service.spec.ts` | unit |
| coverage is read and written as one row per pair, canonically oriented | `exchange-rate-history.service.spec.ts` | unit |
| neither pointer ever moves backwards | `exchange-rate-history.service.spec.ts` | unit |
| the resume pointer does not advance over a window the provider never answered | `exchange-rate-history.service.spec.ts` | unit |
| the pointer stands down when the reader's data reaches back behind the probe mark | `exchange-rate-history.service.spec.ts` | unit |
| the provider floor still holds while the pointer stands down | `exchange-rate-history.service.spec.ts` | unit |
| a month-end-only history still plans and fetches work | `exchange-rate-history.service.spec.ts` | unit |
| an unused currency makes no provider call | `exchange-rate-history.service.spec.ts` | unit |
| the same-currency case refuses before any query | `exchange-rate-history.service.spec.ts` | unit |
| no answer and nothing stored is a 503 | `exchange-rate-history.service.spec.ts` | unit |
| an empty window is remembered and skipped | `exchange-rate-history.service.spec.ts` | unit |
| windows are fetched oldest first, sequentially | `exchange-rate-history.service.spec.ts` | unit |
| a reverse-orientation row lists inverted at rate precision | `exchange-rate-history.service.spec.ts` | unit |
| a non-positive legacy rate lists as unknown | `exchange-rate-history.service.spec.ts` | unit |
| a date held in both orientations lists once, canonical row winning | `fx-rate-coverage.integration.spec.ts` | integration |
| a reverse-only pair lists inverted against real rows | `fx-rate-coverage.integration.spec.ts` | integration |
| dates come back as `YYYY-MM-DD` in any process time zone | `fx-rate-coverage.integration.spec.ts` | integration |
| a failed list read is not rendered as an empty history | `RateHistoryCoverage.test.tsx` | unit |
| a response for a previous currency never renders | `RateHistoryCoverage.test.tsx` | unit |
| each fill outcome reaches the reader as its own message | `RateHistoryCoverage.test.tsx` | unit |

## 12. Decisions

| # | Question | Answer |
|---|---|---|
| 1 | Does the button still mean "one more year"? | No. It fills the gaps over the span the currency is used. |
| 2 | What defines a gap? | A stretch of 11+ days with no observation (the density bound), not "a day with no row" and not the 45-day carry-forward bound, which calls a month-end-only history complete. |
| 3 | Do closed accounts count towards first use? | Yes. Historical reports cover the years they were open. |
| 4 | How deep may one provider request go? | 365 days, or the bars stop being daily. |
| 5 | Is the whole span filled in one press? | No. A bounded number of windows, with the remainder reported. |
| 6 | Where does the list render? | The dedicated rate history dialog only, not the currency edit form. |
| 7 | Which row wins when a date is held in both orientations? | The canonical one, matching the pending contract migration. |
| 8 | Where is the provider's floor remembered? | `exchange_rate_coverage`, one row per pair, beside the resume pointer. Process memory alone lost it on every restart; two columns on `currencies` could hold only one pair per currency. |
| 9 | Does a known-empty window count against the budget? | No. It cannot be filled, so it would starve the windows that can. |
| 10 | Why does a fetched-but-still-sparse window not get re-planned? | The provider answered it; that answer is its best. Re-asking spends the next press's budget on ground already covered and never reaches what is past it. |
| 11 | May packing re-fetch rows that are already stored? | Yes, within one window. One call covers a year at the price of a fortnight, and the alternative -- a window per monthly hole -- cannot finish a decade. |
| 12 | What stops the resume pointer hiding newly imported older years? | `probed_from`. When the reader's first use of the currency reaches back behind it, the pointer stands down for one press. |
