# Spec: the portfolio's time-weighted return as a series

Status: **accepted.** Scope from kenlasko/monize Discussion #2117, option A,
approved by the maintainer ("Go ahead with option A").

Owner: investment-reports. Related: `docs/specs/portfolio-period-result.md`
(section 10, the measure this draws), `docs/time-series-contract.md` (series
sampling and missing data), `docs/financial-calculation-contract.md` (a subtotal
is not a total).

---

## 1. What this adds

The invested part's time-weighted return (`investmentReturnPercent`, method
`twr`) is today a single number per window. Every chart over time either plots
money, where each deposit and withdrawal is a step, or plots one line per
security. Nothing draws the return of the portfolio itself, independent of the
cash the reader moved, which is what the reader asks when they ask how the
portfolio is doing.

This section adds that line: the same chained factors, reported as a running
value on every day of the window instead of only on the last one.

Out of scope, each its own proposal: benchmark overlays on the portfolio line
(the comparison chart's indexes), a dividend-excluded price-only variant, and a
"Portfolio value over time" percent toggle (option B of the discussion).

## 2. The measure

Nothing new is measured. For a window `(b, e]` the series is

```
r(b)   = 0
r(d)   = (prod over days b < k <= d of f(k) - 1) * 100       d in (b, e]
f(k)   = ending(k) / base(k)  when base(k) > 0, else 1
```

with `base`, `ending` and the factor taken from `docs/specs/portfolio-period-result.md`
section 10.2 unchanged: `base(k) = IV(k-1) + capitalIn(k)`,
`ending(k) = IV(k) + capitalOut(k) + I(k)`, and a day with no capital at risk
contributes factor 1.

The factors are written once, in `backend/src/common/time-series/twr-chain.util.ts`
(`subPeriodFactor`, read through `investedDayFactors`, the one place a day's factor is chosen). The series reads the factors the period decision
chained (`investedTimeWeightedDecision`, `investedPeriodResult` without the
money-weighted solve), never a second implementation of the arithmetic.

### 2.1 Before the first invested day

A day with no capital at risk is factor 1, so `r(d)` is `0` from the window's
opening until the first day that has a base. A window in which NO day ever had
a base is the period result's own known case: where nothing was earned either,
the return is a known `0` and the series is a flat line at zero; where
something was earned over no capital at risk there is no ratio, and the series
is withheld with reason `zeroStart`, exactly as the period result is
(section 10.2 there). The series never decides this itself: it asks
`investedPeriodResult` and draws only where that reports a figure.

## 3. Invariants

- **INV-PORTTWR-001 (the line ends where the card ends).** For one scope,
  currency and window, the series' last point equals the period result's
  `investmentReturnPercent` to the stored precision, and the series is
  withheld exactly where that figure is. The two read the same series, the
  same flows and the same rates, and chain the same factors, so a reader who
  compares the line with the card never sees two answers under one caption.
- **A subtotal is not a point.** A day whose `IV` is a subtotal
  (`pricesComplete === false` or `fxComplete === false`), or whose capital or
  income could not be converted, makes the chain across it unknown. The series
  does not draw a return over a portfolio nobody owns: it is returned
  withheld, with the same reasons and `incompleteRanges` the period result
  names, never with a hole bridged by a restarted chain.
- **Cash is not an investment (INV-PORTRESULT-002).** Deposits, withdrawals and
  idle cash move no point of the series.
- **The scope decides the series.** A request names account ids; the series is
  the combined return of exactly those accounts (the scope widened to linked
  pairs, as every investment surface resolves it). A per-account request is one
  such series per account, each its own scope, not a slice of the combined one:
  the combined chain is not a weighted sum of the per-account chains.

## 4. Truth table

| Window / data | Series | Reasons |
| --- | --- | --- |
| Every day complete, capital at risk on some day | one point per day, first `0` | none |
| Every day complete, no day ever had capital at risk, nothing earned | flat at zero | none (the period result's known zero) |
| No day ever had capital at risk, something earned | withheld, no points | `zeroStart` |
| A day inside the window is a subtotal | withheld, no points | `incompletePrices` and/or `missingRatePairs` |
| A capital or income row did not convert | withheld, no points | `missingRatePairs` |
| Scope has no investment accounts | empty | `noValueSeries` |
| Window opens after the scope's first holding | opens at `0` on the window's first close | none |

## 5. Numerical examples

Securities only, reporting currency, day 0 is the baseline close.

1. **Deposits are not return.** `IV` 1,000 on day 0. Day 1: buy 500, `IV` 1,500.
   Day 2: `IV` 1,650. Factors: day 1 `1,500 / (1,000 + 500)` = 1;
   day 2 `1,650 / 1,500` = 1.10. Series: `0, 0, +10.00`. The value chart over
   the same days shows 1,000, 1,500, 1,650.
2. **Withdrawals are not loss.** `IV` 2,000 on day 0. Day 1: sell 1,000,
   `IV` 1,000. Day 2: `IV` 1,100. Day 1 factor `(1,000 + 1,000) / 2,000` = 1;
   day 2 `1,100 / 1,000` = 1.10. Series `0, 0, +10.00`.
3. **Dividends are return.** `IV` 1,000 on day 0; day 1 `IV` 1,000 and a 20
   dividend paid out. Factor `(1,000 + 20) / 1,000`. Series `0, +2.00`.
4. **Opens empty.** Nothing held on day 0; a 1,000 buy on day 2 with `IV` 1,000;
   `IV` 1,100 on day 3. Days 1 and 2 have no base or a base of the purchase
   itself (`ending / base` = 1). Series `0, 0, 0, +10.00`.

## 6. Missing-data policy

Withheld rather than partial, for the reason in section 3. The response carries
the reasons from the closed `PeriodResultReason` set and `incompleteRanges` in
the shape the period result uses, so the chart can say which security on which
days, and where to add it, with the same wording as the cards beside it.

## 7. Where it is computed, and by whom

- `backend/src/net-worth/invested-twr-series.util.ts`: a pure function over the
  same `InvestedDayValue` points and `InvestedFlowDay` map `investedPeriodResult`
  reads. No I/O.
- `PortfolioTwrSeriesService`: reads the invested part through the SAME loaders
  `getPeriodResult` uses (`PortfolioPeriodResultService.loadInvestedRows`,
  `loadShareLegClose`, `foldFlows`, and the daily investment series), so a
  change to what is read moves the card and the line together, and
  INV-PORTTWR-001 cannot drift. It calls the util and does not load the
  account-level cash flows, which the invested measure does not read.
- `GET /net-worth/investments-twr-series`: the window, scope and currency
  parameters of `investments-period-result` (`period` or `startDate` /
  `baselineDate`, `endDate`, `accountIds`, `displayCurrency`), validated by the
  same `periodWindowQuery`. `groupBy=account` requires `accountIds` (one to 25 ids)
  and returns one series per account id named; naming none is refused, because
  it would mean every account and an unbounded cost. Each is its own scope. Ids are lower-cased and de-duplicated before the
  count is checked, and the number of distinct accounts is bounded. An account
  an acting delegate cannot read is answered under its own id as an empty
  series (`noValueSeries`) and is never valued. A brokerage
  and its cash sibling resolve to one scope, so the client names the brokerage
  once and draws one line for the pair.
- The chart: a segmented control on Investment Performance > Performance
  (`Portfolio`, `By account`, `By security`). `By security` is the existing
  chart unchanged.

### 7.1 Cost

One series is one valuation: the load `getPeriodResult` already does for the
invested part, plus one pass over its days. `groupBy=account` is one such load
per account, in turn (a single transaction connection is not shared across
concurrent queries); the response is returned whole so the client makes one
request. Within each account the value series and the invested rows are read
together, as `getPeriodResult` reads them. The client's timeout for the request
is one valuation's per account (`twrSeriesByAccountTimeoutMs` in
`frontend/src/lib/net-worth.ts`), bounded by the server's own request timeout.

## 8. Test matrix

| Case | Kind |
| --- | --- |
| The four examples of section 5 | unit, util |
| Last point equals `investedPeriodResult(...).investmentReturnPercent` over random flow and value paths | unit, property over generated series |
| A subtotal day, an unconverted flow: withheld with the period result's reasons | unit, util |
| A window with no capital ever at risk: flat at zero where nothing was earned, withheld with `zeroStart` where something was | unit, util |
| Service returns what the util returns for the scope the period route resolves | unit, service |
| `groupBy=account` returns one series per requested account, each over its own scope | unit, service |
| Controller refuses a malformed account id, an unknown `groupBy`, more accounts than the bound | unit, controller |
| Route is read-only and delegate-readable under the `investments` section | unit, controller |
| The chart plots the series, shows the withheld reasons, and the control switches mode | frontend unit |
