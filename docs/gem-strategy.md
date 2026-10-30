# GEM strategy (Global Equities Momentum)

Rule-based allocation report: one signal per period, one instrument held at a
time. The report page lives at `/reports/gem-strategy`
(`frontend/src/components/strategies/`), the evaluation in
`backend/src/strategies/`.

## Rules

Standard dual momentum, evaluated in two steps against a lookback window
(12 months by default, `gem_strategies.lookback_months`):

1. **Absolute momentum** -- compare the US equity leg's trailing return with the
   risk-free leg's. Equities winning outright is `RISK_ON`; equal or worse is
   `RISK_OFF`.
2. **Relative momentum** -- while `RISK_ON`, hold the equity market with the
   strongest trailing return. While `RISK_OFF` the ranking is still computed and
   shown, but it does not drive the allocation: the safe asset is held.

The target weight is always 100% in a single instrument. Ties in the ranking
break on the canonical role order, so the same inputs always produce the same
winner.

A period whose absolute test cannot be run -- no momentum for the US equity leg
or the safe asset, e.g. missing prices -- produces **no signal**. Nothing is
guessed from half the inputs, and the period is evaluated later once its prices
exist.

Roles: `US_EQUITY`, `EX_US_EQUITY`, `EM_EQUITY`, `SAFE` and `RISK_FREE`. The
last is the yardstick the absolute test measures equities against; it is
optional, and with no instrument assigned the safe asset stands in for it, which
is how a strategy configured before the two were split keeps evaluating exactly
as it did. A required role with no security assigned is reported as unmapped
(`UNMAPPED_ROLE`) rather than substituted.

The rules themselves are not configurable. What is: the instruments, the
cadence, the lookback window, the strategy accounts, and the tax/commission
assumptions behind the transfer estimates.

## Calendar

A monthly strategy re-allocates on the 1st of each month, decided on the last
day of the previous month (`evaluated_on`); a quarterly one on the 1st of
January, April, July and October. `effective_from` is the first day the
allocation applies. "Next evaluation" is the price date the following period will
be decided on.

## Data model

| Table | Holds |
|-------|-------|
| `gem_strategies` | One row per saved scenario, many per user: cadence, lookback, tax rate, commission, rules-source link. The report's switcher moves between them, and each carries its own signals |
| `gem_strategy_accounts` | The brokerage accounts the strategy is run in (many per strategy); their holdings are summed |
| `gem_strategy_assets` | The security filling each role (`security_id` nullable = unmapped) |
| `gem_strategy_signals` | One row per evaluated period: state, target, momentum snapshot, spread, lead, previous role, execution flag |

Migrations `database/migrations/124_gem_strategies.sql` and
`125_gem_strategy_accounts.sql` (mirrored in `database/schema.sql`, including
the Group A RLS policies). 125 moves the single `gem_strategies.account_id` to
the join table, backfilling the existing link.

Signals are **materialized**, not derived on each read: the momentum figures a
decision was taken on must survive later price revisions, and the user's
"executed" flag needs a stable row. Materialization runs on the report read
(bounded to the last `GEM_HISTORY_PERIODS` = 24 periods) rather than only in a
scheduled job, so a strategy that was just configured -- or whose prices arrived
late -- produces its history immediately. Each period is inserted once per
algorithm version; the unique index on
`(strategy_id, evaluated_on, algorithm_version)` (widened by migration 131 from
the original `(strategy_id, evaluated_on)`) arbitrates concurrent readers. Any
read written against the old two-column key selects more than one row now.

A stored period is only *answered*, though, if it was calculated under the
configuration in force now. `config_fingerprint` (migration 129) hashes the
cadence, the lookback and the role-to-security mapping -- everything that
changes what a signal says, and nothing that only affects presentation or the
cost estimates. `GEM_SIGNAL_ALGORITHM_VERSION` is deliberately **not** in the
hash; it is a column of its own, for the reason set out below.

That version is the other half of what a signal means. The settings say what
question was asked; the code says how it was answered, and it changes too:
version 2 stopped accepting a boundary close struck more than
`BOUNDARY_LAG_DAYS` before the boundary, so a version 1 row can carry a momentum
computed from a months-old quote under settings identical to today's. Without
the version in the material that row is answered, never recomputed, and served
as the instruction to act on. **Bump the constant whenever a change can alter
momentum, the ranking, the risk state or the target** -- and not otherwise,
because every bump makes the current window's rows history-of-record and
evaluates the whole window again.

The version is a column, not part of the hash, and it is in the unique key
(`strategy_id, evaluated_on, algorithm_version`) rather than replacing the row.
Both facts follow from the same distinction. A settings change is the user
asking for a different answer, so the period is recomputed in place. A rules
change is not: that row records a decision the strategy really took and a trade
the user really made against it, and rewriting it with today's code over prices
revised since would file a counterfactual as history. So the old row stays,
untouched, and the current version writes its own row beside it -- which is also
what stops an upgrade from costing the user the signal governing today. Blocking
instead left a quarterly strategy waiting out the quarter for an instruction it
was owed immediately. The superseding row inherits `executed` when it asks for
the same instrument, because that trade was made.

Writes are serialized per strategy by a transaction-scoped advisory lock
(`lockGemStrategy`), taken both by materialization and by the settings save.
Materialization reloads the configuration under it, so what it writes answers
what the database holds; the save takes it too, so a commit cannot slip between
that reload and the first insert. When the reload finds a configuration other
than the one the caller was handed, `materialize` reports `configChanged` and
`getReport` builds the whole report again from scratch: the alternative is a
response whose metadata, position and costs describe one configuration while
its history describes another. Shorten the lookback or swap a fund and the affected periods are
recomputed in place on the next read: same row, because the unique index owns
the period, with `executed` kept when the recomputed instruction is the same
instrument and cleared when it is not. A period that cannot be recomputed (a
lookback stretched past an instrument's first close) keeps its row in the
table, but it is left out of what `materialize` returns.

That last part matters more than it sounds. **Everything the report shows comes
from one configuration or it is not shown at all**: the history, the predecessor
chain and the backtest all read the same array, and mixing fingerprints in it
produces a run that never happened. The history resolves "switched out of" from
the entry before it, so a stale row wedged between two fresh ones would be named
as the predecessor of a period computed against an earlier one, and the backtest
would replay a hybrid of counterfactual and historical signals. A recomputed
period likewise takes its `previousRole` only from another period this
configuration produced. When a concurrent insert loses the unique key to a row
carrying a *different* fingerprint, this materialization **stops**: it abandons
the remaining periods and re-reads. Replacing the winner in place was the
tempting alternative and is wrong -- the winner holds the configuration the
database now has, this request is working from the one it was handed, and
overwriting it would file this request's evaluation under the other request's
settings. Breaking leaves the chain short rather than wrong, and the re-read at
the end of the loop returns whatever is actually stored; the next read
materializes the rest under the configuration it reloads. The rows stay in the
table -- they are real decisions with real `executed` flags -- they are simply
not this configuration's history.
And the report says so: `materialize` returns how many periods it left out, and
`LEGACY_PERIODS` names the count, because a history that silently comes up short
is its own kind of lie. The warning clears itself as the 24-period window rolls
past those dates.

A **cadence change replaces the calendar** rather than editing it: on quarterly,
31 March is still an evaluation date and 30 April is not. Both the read and the
result are therefore filtered to the dates the current cadence evaluates on --
without that, the months in between stayed stored, were never revisited (the
loop only walks current periods), and the quarterly history showed monthly
decisions interleaved with its own. They are filtered, not deleted: they answer
a calendar this strategy is not on today, and switching the cadence back brings
them and their `executed` flags with it.

History renders the instrument each decision **actually named**, resolved from
the signal's own `target_security_id`. When that security has since been
deleted the row keeps its role and reports the instrument as no longer
available; the role's *current* assignment is never substituted, because dating
today's fund to a decision taken before it is a historical falsehood with
nothing on the page marking it as a guess. A switch's `from` takes its role and
its instrument from the same place or from neither, since this row's
`previousRole` and the predecessor row's target can disagree after a period is
materialized out of order.

Periods whose momentum window opens before the price history does are bounded
out with one cheap aggregate rather than re-read on every load; nothing is
remembered, so a backfill unlocks them with no state to reset. And a RISK-ON
period is only stored when every *assigned* equity market has a momentum:
`rankEquities` drops an unmeasurable role, which would quietly turn "emerging
markets could not be measured" into "emerging markets did not win" and then
recommend a concrete switch. A role left deliberately unassigned is a
configuration, not a gap, and still evaluates.

## API

All routes are JWT-guarded and derive the user from the token.

| Route | Purpose |
|-------|---------|
| `GET /strategies/gem/report?range=3M\|6M\|1Y\|3Y\|5Y\|MAX` | The whole report as one read model. `range` only affects the performance series |
| `PUT /strategies/gem` | Create or update the configuration (accounts, cadence, lookback, costs, role assignments). Sending `accountIds` replaces the whole set |
| `POST /strategies/gem` | Start a new scenario from a name; answers with that scenario's report |
| `DELETE /strategies/gem/:id` | Delete a scenario with its assignments and history; answers with a remaining scenario's report |
| `POST /strategies/gem/signals/:id/executed?range=…` | Record that the operation was carried out; returns the refreshed report |

Every route also accepts `strategyId` -- which scenario the request is about.
Omitting it means "whichever the server picks", the user's default and the only
one until they create a second. `DELETE` names its target in the path instead;
`POST /strategies/gem` has no target yet. Both `:id` parameters go through
`ParseUUIDPipe`.

The response shape is `backend/src/strategies/gem-report.types.ts`, mirrored in
`frontend/src/types/gem-strategy.ts`. `null` always means "not known" (unmapped
role, missing history, no account, unestimable value) and the client renders an
explicit unknown marker for it -- never a zero.

Warnings the report can carry: `UNMAPPED_ROLE`, `INCOMPLETE_HISTORY`,
`LEGACY_PERIODS`, `NO_ACCOUNT`, `NO_POSITION`, `FIRST_RUN`, `STALE_PRICES`,
`SHORT_HISTORY`, `CALCULATION_FAILED`. `SHORT_HISTORY` is the specific,
actionable form of a missing signal: when a required leg (the US equity leg,
the benchmark, or any assigned equity market while RISK-ON) has no close at or
before the current period's momentum-window start, it carries the `roles` and a
`requiredFrom` date so the report can name which instrument to extend and from
when. It is emitted in place of the generic `CALCULATION_FAILED`/`FIRST_RUN`
whenever the cause can be pinned to named instruments; the fix is to fetch more
price history for them (the security page's "add another year" control) or to
assign an instrument with a longer history.

### No AI-assistant or MCP tool, on purpose

GEM is reachable over HTTP only: there is no tool for it in
`ai/query/tool-executor.service.ts` and none in `mcp/tools/`. That is a decision,
not an omission. The project's shared-AI-tools rule forbids shipping a tool to
one of those two surfaces without the other, so the choice is both or neither,
and "neither" is where this lands for now -- the report is one read model built
from a materializing read, and an assistant asking for it would be asking the
server to write signal rows as a side effect of a question.

Adding it later means one PR that wires the same domain method into both layers
and returns the same shape from each. The method to share already exists:
`GemStrategyService.getReport`. What such a tool must not do is call
`materialize` -- give it a read that reports what is stored and says so when a
period is unanswered, or the assistant becomes a second writer racing the report.

`backtest` is `null` only when there is nothing honest to simulate: no stored
evaluation this configuration produced, no priced period, or a signal that
became effective today and so has no elapsed period behind it. One evaluation is
enough otherwise -- its period runs to `asOf`, not to the next signal, so a
strategy configured last month reports a month. What it does report, and what it
deliberately leaves gross, is described under "Backtest" below; the client's
Backtest tab shows its empty state for the null.

## Portfolio comparison

Compliance and the transfer estimates come from the holdings in the strategy
accounts, valued at the latest close (`backend/src/strategies/gem-position.util.ts`).

The comparison covers **everything** held in those accounts, not only the
instruments assigned to a role. GEM asks for the whole portfolio to sit in one
asset, so a holding the strategy never assigned is exactly what makes the
portfolio non-compliant and exactly what a switch has to sell. A strategy can
span several brokerage accounts: a security held in more than one is summed into
a single position, so the comparison sees one portfolio rather than one account
at a time, and each holding is converted into the user's default currency at a
stored rate no older than `BOUNDARY_LAG_DAYS` -- past that the holding's market
value is unknown, not converted at whatever rate happens to be newest.

Idle cash in those accounts is a position too (`isCash`): the linked
`INVESTMENT_CASH` balance of each brokerage account, and a standalone investment
account's own balance. GEM wants the whole strategy portfolio in one instrument,
so cash beside the target is exactly as off-target as the wrong fund -- an
account holding 5,000 of the target and 5,000 in cash is half invested, not
compliant. It is spent rather than sold, so it places no *sell* order and
realizes nothing -- but the account it sits in still buys, so it does add a
purchase to `estimatedTradeCount`. A negative balance is a margin debt, not an
asset the switch can move, and is ignored.

- `holdings` is every position in the accounts, largest first, each tagged with
  the role it fills (`role: null` for one that fills none);
- `exactTargetPercent` is the share of the priced non-cash securities held in
  the instrument the signal names -- **the strategy's actual instruction**, and
  what decides `changeRequired`, what is sold, and when the operation is done;
- `marketExposurePercent` is the estimated share of those securities exposed to
  the target's *markets*, however it got there -- informational only, null
  whenever any security cannot be placed, a **lower bound** whenever a
  breakdown describes only part of a fund (see "Exposure is a floor" below),
  and never mixed with the figure above: a world tracker a fifth in emerging
  markets gives a fifth of the exposure and none of the compliance;
- cash sits in neither denominator (see below), but it is off target, so it
  still makes a change required and still funds the purchase;
- `action.sellPositions` names every position the switch sells, largest first,
  and the transfer value is the **full** value of each;
- the realized result is that value minus its cost basis, and the tax estimate
  applies the configured rate to a gain only (a loss owes nothing).

Both percentages are measured against the priced **non-cash** securities. Cash
is out of the denominator because "how much of my equity allocation is in the
right fund" is not a question idle cash belongs at the bottom of: a portfolio
wholly in the target with a dividend just paid in would otherwise read as less
than fully invested in a fund it is entirely invested in.

**"Executed" is recorded against the signal; the operation is recomputed from
the accounts.** The two can therefore disagree, and the report says so instead
of collapsing them: when a change is required *and* the signal is marked
executed, the card reports both -- either the trades have not been recorded yet,
or money has arrived since. Showing only the tick hid a live instruction behind
it, so an account that received a deposit after a completed switch read as done
with nothing to do.

**Partial overlap is a diagnostic, never a fraction of a sale.** A fund 20% in
the target's markets counts 20% towards `marketExposurePercent`, nothing
towards `exactTargetPercent`, and is still sold whole:
selling four fifths of it sells four fifths of its on-target sleeve too, so a
pro-rated sale never reaches the 100% allocation the signal asks for.
`action.partialMatchCount` says how many of the sold holdings were in that
position, and the transfer card explains it rather than leaving a compliance
figure and a full-value transfer looking contradictory.

### "Today's portfolio", the dashed line on the asset chart

`GemPerformanceService.simulateCurrentComposition` replays what the strategy
accounts hold **now** across the selected window, so the instruments the user
actually owns can be read against the strategy's own five:

    w_i                = holding_i market value / total market value, struck once at t0
    securityIndex_i(t) = P_i(t) / P_i(t0)
    portfolioIndex(t)  = sum(w_i * securityIndex_i(t))
    returnPercent(t)   = (portfolioIndex(t) - 1) * 100

`t0` is the first date every held instrument can be priced on, never earlier
than the chart's own first point. Nothing rebalances afterwards: it is
buy-and-hold from `t0`, which is what makes it comparable with the
single-instrument lines beside it. Prices are the same adjusted closes those
lines use, each in its own listing currency. It is explicitly **not** a
performance record: no historical transactions, no cash flows, no cash, no FX.

It declines to answer rather than draw something misleading, and says which:
nothing held (`NO_HOLDINGS`), a holding with no current value so the weights
are unknown (`UNKNOWN_CURRENT_VALUE`), or no usable price history
(`MISSING_PRICE_HISTORY`). That last one also covers the two cases that used to
slip through as an *available* simulation with nothing in it: every point
unpriceable -- a feed that stops before the window opens is stale at every
plotted date -- and only the opening point priceable, which is 0% by
construction and reads as "your portfolio returned nothing" when it is really
one quote and no second one. **Fewer than two drawable points is an absence,
not a flat line.**

The practical cause of that state is a held instrument with no price *history*.
Refreshing a quote stores one row for today, and one row cannot be replayed.
`ensureHistory` runs on a configuration save over the instruments the strategy
*assigns*, because those are what the signal depends on -- a fund the user
merely holds was never in that list. So `getReport` now runs the same backfill
over the held instruments, but only when the simulation actually came back
`MISSING_PRICE_HISTORY`, and rebuilds the chart only when the backfill reports
that it fetched something. The provider cooldown and the coverage check inside
`ensureHistory` keep that from becoming a fetch per read.

**A line that ends early says where and why.** A point needs *every* holding
priced -- a portfolio simulated from the legs that happen to have data is a
different portfolio -- so the line ends with the first feed that does.
`endsOn` and `stoppedBy` carry that out: the last date drawn, and the
instruments whose prices ran out there, named under the chart because the
instrument is the thing the user can act on. The window return is `null` rather
than the figure from the day the feed stopped wearing today's date.

`scripts/gem-price-coverage.sql` answers the same question against a live
database: how many price rows each held instrument has in the window, how stale
the newest is, and whether they came from a provider or from transactions.

### Exposure is a floor, not a measurement -- and a floor is shown

**Product decision. Do not revert it in code review; a change here needs the
product owner, not a reviewer's judgement about statistical hygiene.**

Country and asset-class breakdowns in the wild name the top handful of markets
and stop, and the securities editor deliberately drops the "Other" bucket, so
most real funds are described in part. Requiring both sides of the comparison
to account for their whole fund before an exposure could be reported therefore
blanked the entire column: a portfolio of four world and thematic trackers, two
of them visibly holding the target's largest markets, showed "No data" against
every row and 0% overall. That reads as "Monize cannot see the overlap", which
is a worse falsehood than the imprecision it was avoiding.

So the overlap of the *described* parts is reported, and it is reported as a
lower bound. `matchIsFloor` (per holding) and `marketExposureIsFloor` (the
total) travel with the figure, and the UI renders them as "at least N%" with a
note saying why. Two rules survive unchanged:

- **A floor is never printed as a measurement.** Rendering a floor with the
  plain percentage formatter is the one presentation that is wrong.
- **No description, no estimate.** With no usable breakdown on one side there
  is still nothing to compare, and the row says so rather than showing a zero.
  A floor of zero derived from descriptions that share no names is a real
  floor; a zero invented because nobody described the fund is not.

The estimate remains informational: it never keeps a position, reduces a
transfer, or completes an operation. `backend/src/strategies/gem-composition.util.ts`
carries the same note beside the code.

### An instrument the user already holds is one the picker must offer

**Product decision, same standing as the one above.** `SecuritiesService.create`
allows one security per symbol per user, so the GEM picker decides "you already
hold this" on the **symbol** alone -- `symbolKey` in
`frontend/src/lib/gem-suggested-securities.ts`. Matching the exchange and the
trading currency as well is a truer model of the world and a false model of
this application: the second listing cannot exist, so the stricter match
offered a create the server was bound to refuse ("Security with symbol EXUS
already exists"), both from a role's suggestion list and from the one-click
"add the missing instruments". The suggestion regions still decide *what gets
created* when nothing holds the symbol; they do not decide whether anything
does. Deactivated instruments count as held -- they own their symbol -- and
assigning one through its suggestion makes it selectable again.

**`commissionAmount` is per order, and orders are counted per account.** A
sell is placed once per **(account, security)** pair, and a purchase once per
account that has something to put into the target -- a fund being sold, or cash
being spent. An account already wholly in the target places nothing, and a
portfolio that already complies places nothing at all, so zero orders and a
zero commission are real answers rather than a floor.

Two brokerage accounts each holding the same two funds is four sells and two
buys. Counting the summed holdings instead called that three orders and charged
for three, halving the figure the user reads to decide whether the switch is
worth making. A linked `INVESTMENT_CASH` sleeve is not a second account here:
its balance is attributed to the brokerage account that actually trades, or the
pair would be charged two purchases for one order.

**One unpriced holding makes the money figures unknown, not approximate.** That
covers the compliance share, `totalMarketValue` and `transferValue` alike: a sum
that skips what it could not value is a smaller number printed where the user
reads the total, and the backtest sizes its commission drag against it too. The
realized result and the tax follow the same rule over the *sold* positions --
one without a cost basis makes the estimate unknown, and cash never answers for
it, because its cost equals its value and would turn an unknowable gain into a
confident zero. A share of a total nobody knows is not a share, and the error
runs in the dangerous direction: an unpriced holding dropped from the
denominator while counting as zero in the numerator turned 10,000 in the target
plus one
unpriceable position into exactly 100% compliant, with `changeRequired` false --
the report saying there was nothing to do about a position it could not see.
Unknown says so, and holding an instrument other than the target still settles
that a change is needed: what to do does not depend on being able to value it.

**A cost basis is the position's only if the history reproduces the position,
per account and per row.** The basis is rebuilt from the transactions at the
rate each one recorded, commissions included, and the rebuilt units are
compared against the units actually held **in each account separately** -- a
surplus in one account cancels a shortfall in another if the totals are
compared, and both wrong bases then pass. A history containing an `ADD_SHARES`
or a `REMOVE_SHARES` leaves the basis unknown outright: those rows move units
and carry no price, so the rebuild carries them as quantity-only and the basis
it computes covers fewer shares than the position holds. A `SPLIT` is not in that class -- it
scales units and preserves total cost, which is what both paths do.

**An acquisition with no price is unknown, not free.** `price` is nullable, and
the API refuses a `BUY` or `REINVEST` without a positive one -- shares that
genuinely arrived without a cost are `ADD_SHARES`, which records that it does
not know. A row stored at zero could not be told from a real free purchase, and
the units still reconciled, so an incomplete import came out as a confident gain
and a confident tax bill.

**A basis is denominated where the money came from.** `exchangeRate` converts
the trade into the account that paid for it -- the funding account, or the
brokerage's linked cash account -- so a PLN brokerage funded from EUR carries a
EUR basis. The lot states its own currency and the report compares that against
the currency it is reporting in; the holding account's currency is a fact about
the account, not about what the shares cost. A mismatch is unknown rather than
converted, because today's rate answers a question about today.

**A transfer moves cost with the shares.** `TRANSFER_OUT` releases basis at the
running average and the paired `TRANSFER_IN` takes exactly that, in the source's
currency, with its share of the acquisition commission already inside. A partial
transfer splits the basis in the same proportion as the units, and the total
across the pair is unchanged: a transfer creates no gain, no tax and no new
acquisition. Where the source cannot price what it gave up -- or is not among
the accounts being read -- the destination's basis is unknown, never rebuilt
from the transfer row's own carried price and rate of 1.

**A missing exchange rate is missing data, not a rate of 1.** A holding priced
in a currency with no stored rate to the report currency -- in either direction
-- has an unknown market value and an unknown cost basis, and the totals above
go unknown with it. The same holds for a cash balance: it is kept in the
comparison as a position of unknown size rather than dropped, because dropping
it would let the securities alone be reported as the whole portfolio. Passing
the foreign amount through unconverted looked like graceful degradation and was
not: every figure here is a sum or a ratio over these values, so one
unconverted holding mis-states the total, the share held in the target, the
transfer value and the tax at once, and all four still read as confident
numbers.

Prices come from `security_prices` (whatever provider filled them). Every
*historical* series -- momentum, the performance chart, the backtest -- reads
adjusted closes, because all three measure a return over time: on raw closes a
4-for-1 split reads as a 75% crash and flips the absolute test, and
distributions vanish from the return of whichever leg pays the most.

The basis is chosen **per security over the window being read**, never per row.
`adjusted_close` is nullable and only the provider backfill writes it, so a
per-row `COALESCE(adjusted_close, close_price)` spliced raw rows -- a
transaction-derived price, an import, a seed -- into an adjusted history for
any instrument the user had ever traded, which around a split is a
several-hundred-percent return and a drawdown that never happened. Adjusted
rows only where any exist, raw throughout where none do, never both.

Valuing today's holdings is the other question and keeps the raw close, bounded
to `BOUNDARY_LAG_DAYS`: a security whose newest quote is older than that is
absent from the valuation rather than priced at it. The exchange rate used to
convert it is held to the same window, and the **cost** basis is not converted
at today's rate at all -- it is rebuilt from the transactions at the rate each
one recorded, and left unknown where the account's currency is not the
report's.

Staleness is judged **per role**: `pricesAsOf` is the oldest required
instrument's last close, not the newest, and the `STALE_PRICES` warning names
the roles behind it. Taking the maximum let a US quote refreshed this morning
speak for an ex-US instrument last priced three weeks ago. An assigned
instrument with no price at all makes the date unknown rather than letting the
others answer for it. The threshold is five days.

The **backtest simulates the most recent unbroken stretch of priced periods**,
not the whole history. Holding a gap flat looked like a simplification and was
not: flat means the switch out of that period realizes nothing, so no tax comes
off, and every later period compounds from a balance the simulation invented --
while the drawdown misses whatever happened inside the gap and "net of estimated
taxes and commissions" stops being true. A discontinuous equity path cannot be
summarised into one CAGR, so the run restarts after the last gap, `from`/`to`
report what was actually simulated, and `coveragePercent` -- simulated periods
over evaluated periods -- says how much of the evaluated history that was. The
periods before the last gap are *excluded* from the run, not held flat: they
contribute nothing to the return, the drawdown or the hit rate.

**A run that does not start where the strategy did is reported gross**,
whatever costs the configuration carries -- and that covers two cases, not one:
prices truncated the run, or the strategy had already evaluated something
before the oldest period in hand (`hasSignalsBefore`, asked of the table rather
than read off `previous_role`, which is null whenever the predecessor belonged
to another configuration or version). The second is the ordinary case for any strategy older than the
24 periods the history keeps, so it is not an edge case: the simulation would
otherwise charge a purchase commission for a trade that never happened and date
the tax basis to the edge of the visible window, taxing a later switch on the
gain since that arbitrary reset. Both cost flags are false and the panel says
so.

One evaluation is enough to simulate, because the last period is bounded by
`asOf` rather than by the next signal: entry price, exit price, the daily path
between them and the safe asset over the same interval. Only a signal effective
today, or one whose period cannot be priced, comes back with nothing.

The simulation charges the same per-account count. A switch is
`accountCount` sells plus `accountCount` buys, and the opening purchase is
`accountCount` orders -- modelling one synthetic account understated the drag
by a factor of the account count and compounded that over every period of the
run.

**Tax and commission are reported separately** (`taxApplied`,
`commissionApplied`). They fail independently: tax is a percentage and applies
to any capital, while an absolute commission only becomes a drag against a known
portfolio total -- which is null whenever a holding cannot be priced. One
`netOfCosts` boolean could not tell the four states apart and printed "net of
estimated taxes and commissions" over figures no commission had come off.

`hitRatePercent` is null unless *every* simulated period could be compared with
the safe asset. A ratio over the periods that happened to be checkable would
sit beside a longer run under a denominator the reader cannot see.

A boundary close counts only when it was struck within a fortnight of the
boundary -- `BOUNDARY_LAG_DAYS` in `gem-momentum.util`, and the same rule for
momentum as for the backtest. A security last quoted months ago would otherwise
answer both ends of a period with the same number: a flat period rather than an
unpriced one for the backtest, and for momentum a trailing return of exactly
zero, computed from one observation, that decides a signal the user is invited
to trade on.

The roles of one evaluation are priced at **one session** (A26-M27). The lag
window tolerates a market shut on the boundary, but it also tolerated a feed gap:
an ex-US series with no closes from the 19th to the 30th was priced off its 18th
while the US leg used the 30th, and the ranking compared two sessions.
`momentumSnapshot` takes the newest exit close any role holds on or before the
boundary as the boundary's session and leaves a role whose own exit trails it by
more than `BOUNDARY_HOLIDAY_DAYS` (four days, `price-boundary.util.ts`) unpriced,
so the period defers through `evaluate` as it does for any unpriced mapped role.
Algorithm version 3. Version 4 converts every close into the user's reporting
currency at that close's own date before returns are compared (`GemPriceService.loadSeries`);
a close with no admissible rate is dropped, so a span ending on it is unpriced. The backtest's per-role spans and the configuration save's
backfill check (`coversBoundaries`) still use the fortnight window alone; a gap
already materialized under version 2 is history-of-record.

The lag window has a second half: **a boundary is priceable only once the series
holds a close dated at or after it.** Inside the window alone, "the market was
shut on the 31st" and "the 31st's close has not been fetched yet" are the same
observation -- the newest close is a few days old either way. Open the report at
09:00 on 1 August before the quote job has stored 31 July's close and the July
period would be answered from the 30th's, materialized under the current
fingerprint and version, and then skipped forever, including where the true
month-end close flips the decision. So an unsettled boundary defers exactly as an
unelapsed period does (`spanCloses` returns `UNELAPSED`), and the next read picks
it up. An instrument that stops reporting altogether fails the fortnight test
within two weeks, so nothing can be held open indefinitely.

The one exception is the backtest's trailing period, whose far end is `asOf`
rather than a calendar boundary the strategy fixed -- "what is this worth now".
No close is ever dated at or after today until the market shuts, so requiring one
there would drop the newest period on every trading day, which for a strategy
with a single evaluation is the whole run. `spanCloses` takes that distinction as
an argument (`SpanEnd`: `BOUNDARY` or `AS_OF`) and defaults to the strict
reading, so a new call site is strict unless it argues otherwise. Nothing
persists an `AS_OF` span.
`PUT /strategies/gem` tops that history up first: any assigned security whose
prices do not reach back over the momentum window plus the 24 periods the
history table shows is backfilled from the quote provider before the signal is
evaluated. A provider failure is logged and leaves the incomplete-history
warning in place; it never fails the save.

## Getting a strategy running

The Settings tab of the report is the configuration form: it assigns the
strategy accounts and an instrument to each role, and sets the cadence, the
momentum window and the cost assumptions. Saving returns the refreshed report,
so a complete configuration produces its first signal immediately.

Prerequisites, since the strategy only reads what already exists in Monize:

1. A security per role. The Settings tab fills every unassigned role with the
   ETF GEM is usually run with in one click (`frontend/src/lib/gem-suggested-securities.ts`),
   creating only the ones the portfolio does not already hold, or any role can
   be pointed at an instrument of your own. Saving the configuration fetches
   the price history the strategy needs for the roles that are short of it
   (`backend/src/strategies/gem-backfill.service.ts`), so the first signal is
   evaluated by the same request rather than waiting on a background job. A
   role the provider has no data for is reported as unknown rather than
   guessed, and the fetch is retried at most once every six hours.
2. At least one investment (brokerage) account for the strategy to trade in --
   pick as many as the strategy spans and their holdings are summed. Compliance
   and the transfer estimates come from those holdings; without any the report
   still shows the signal and says no account is assigned.

`PUT /strategies/gem` is the same operation for scripted setup.
