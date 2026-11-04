# Spec: the Investment Performance report measured over its window

Status: **accepted.** Scope from kenlasko/monize#2011; the approach (per-security
P&L by the portfolio's own invested measure, time-weighted return, period
summary cards, closed positions as rows, close-to-close price change, the
Investments page's ten ranges) was agreed on the issue.

Owner: net-worth (the measure), reports (the surface). Related:
`docs/specs/portfolio-period-result.md` section 10 (the invested part's P&L and
TWR this splits by security), `docs/financial-calculation-contract.md` (missing
data, a subtotal is not a total), INV-PORTRESULT-001, INV-PORTRESULT-002,
INV-PORTCHART-001.

---

## 1. The defect this exists to remove

The Investment Performance report has a range selector, but only its chart
read it. The summary cards' Total Gain/Loss and Return and the Holdings Detail
table's Gain/Loss and Return were the portfolio summary's all-time figures --
today's value less the cost basis of the shares held today -- whatever window
was selected. A reader who picked 1M saw a month of price lines over a table
that described every year the portfolio had existed. The report's windows also
came from `resolveRangePreset`, so its 1M did not open on the day the
Investments page's 1M opens, and its range set was a subset of the page's.

## 2. The measure

The report measures each window with the measure the Investments page's
"Portfolio performance" card prints: the invested part's P&L and time-weighted
return (`docs/specs/portfolio-period-result.md` section 10), over the same
window, the same series, the same flows and the same rate index.

**The window.** The ten ranges the Investments page's value chart offers: 1D,
1W, MTD, 1M, 3M, YTD, 1Y, 2Y, 5Y, All. A range with a server preset is sent as
`period` and the server draws its window from `portfolio-period-presets.util.ts`
(the batch route's arithmetic); MTD has no preset and is sent as
`startDate` = the 1st with `baselineDate` = the last day of the previous month,
exactly as `usePortfolioPeriodResult` sends it for the Investments chart. `b` is
the close the period is measured from, `e` the close it is measured to.

**The summary cards.** Gain/Loss is `investmentPnl` and Return is
`investmentReturnPercent` of `GET /net-worth/investments-period-result` for the
window, the request `usePortfolioPeriodResult` makes for the Investments chart.
They are the Investments page's figures, not a second computation of them.
Total Value and Cost Basis are point-in-time and stay the portfolio summary's.

**One security's row.** For each security `s`, over the same `b` and `e`:

```
IV_s(t)        = the position's value at day t's close, in the reporting
                 currency: the component of IV(t) that s contributed
                 (`DailyPositions.closeValues`), 0 on a day s was not held
K_s, I_s       = the capital and income rows of `loadInvestedCapitalFlowRows`
                 whose security_id is s, folded by `foldInvestedFlows`
P&L_s          = IV_s(e) - IV_s(b) - K_s + I_s
Return_s       = the daily TWR chain of `investedPeriodResult` over IV_s, K_s, I_s
PriceChange_s  = close_s(e) / close_s(b) - 1, in s's own currency, from the
                 accepted close on or before each day (`positionCloseAsOf`)
```

Every row is `investedPeriodResult` run over one security's slice of the very
series and flows the portfolio figure is run over. Nothing is a second policy.

**Rows.** Every security held on any day of `[b, e]` or carrying a capital or
income row in `(b, e]`. A position closed inside the window is a row: its
quantity at `e` is 0 and its P&L is what it earned until it was sold. Without
it the rows would not add up to the card.

**Not tied to a security.** An investment row that names no security (interest
posted to the brokerage without one) is income of the invested part with no row
to sit in. Its `-K + I` is returned as `unattributedPnl` and the report prints
it as its own line, so the rows still add up.

## 3. Invariants

1. **The rows reconcile with the card.** Where every row's P&L and
   `unattributedPnl` are known, `sum(P&L_s) + unattributedPnl` equals the
   window's `investmentPnl` to rounding (one ten-thousandth per security: each
   `IV_s` is rounded to 4dp where the portfolio rounds their sum once). The
   test pins it over the worked cases.
2. **One window per range.** The summary cards, the rows and the Investments
   page answer the same `b` and `e` for the same range, because all three name
   it the same way to the same window resolver
   (`PortfolioPeriodResultService.measuredFrom`).
3. **A row is withheld only for its own cause.** A security with no close on a
   day it was held withholds its own row (`incompletePrices`) and leaves the
   others reported. The card is withheld too, because the portfolio's day is a
   subtotal; that is the card's own policy.
4. **Price change is not return.** `PriceChange_s` is the quoted close's move.
   It ignores distributions, the reader's trades and the currency; `Return_s`
   holds all three. They are separate columns under separate captions.
5. **A split withholds the price change.** A SPLIT row for `s` in `(b, e]`
   makes the quoted closes on either side of it two different units, so
   `PriceChange_s` is `null` with `splitInWindow`, never the ratio.

## 4. Truth table

| Situation | P&L_s | Return_s | PriceChange_s |
|---|---|---|---|
| Held throughout, priced, no flows | `IV_s(e) - IV_s(b)` | the chain | close ratio |
| Bought inside the window | known | the chain from the buy day | close ratio, or `noStartClose` |
| Sold out inside the window (row kept, quantity 0) | known | the chain until the sale | close ratio |
| Distribution only, never held | `I_s` | `null` (`zeroStart`) | close ratio or `null` |
| A day it was held with no close | `null` (`incompletePrices`) | `null` | `null` when a boundary close is missing |
| A capital or income row with no rate | `null` (`missingRatePairs`) | `null` | close ratio (own currency) |
| A split in `(b, e]` | known | known | `null` (`splitInWindow`) |
| No close on or before `b` | per the rules above | per the rules above | `null` (`noStartClose`) |
| No close on or before `e` | per the rules above | per the rules above | `null` (`noEndClose`) |
| A start close of 0 or less | per the rules above | per the rules above | `null` (`noStartClose`) |

## 5. Numerical examples

Reporting currency = security currency, window `b` = day 0 to `e` = day 2. The
cases are `security-period-result.util.spec.ts`.

| Case | Ledger | IV_s(b) | IV_s(e) | K_s | I_s | P&L_s | Return_s | PriceChange_s |
|---|---|---|---|---|---|---|---|---|
| A | 10 shares, closes 100, 105, 110 | 1,000 | 1,100 | 0 | 0 | 100 | 10% | 10% |
| B | bought 10 for 1,000 on day 1, closes 90, 100, 120 | 0 | 1,200 | 1,000 | 0 | 200 | 20% | 33.3333% |
| C | 10 shares, sold all for 600 on day 1, closes 50, 60, 70 | 500 | 0 | -600 | 0 | 100 | 20% | 40% |
| D | 10 shares, dividend 30 on day 1, closes 100 throughout | 1,000 | 1,000 | 0 | 30 | 30 | 3% | 0% |
| F | 10 shares, 2:1 split on day 1, closes 100, 50, 50 | 1,000 | 1,000 | 0 | 0 | 0 | 0% | `null` |
| G | interest of 5 with no security on day 1 | | | | 5 | `unattributedPnl` 5 | | |

A, B, C, D and G in one scope: `investmentPnl` of the portfolio is 435, and the
rows add up to `100 + 200 + 100 + 30 + 5 = 435`.

## 6. Missing-data policy

- A row's P&L and Return follow `investedPeriodResult` exactly
  (`docs/specs/portfolio-period-result.md` section 10.6), with the day's
  completeness drawn from that security alone: a held day with no close is
  `pricesComplete: false`, a priced day whose value did not convert is
  `fxComplete: false` with the pair named.
- `unattributedPnl` is `null` when one of its rows did not convert.
- The report prints an unknown as "N/A" and states the cause once under the
  table, from the same reason catalogue the Investments page uses
  (`withheldPeriodCause`), never as 0.
- A request that failed or has not answered leaves the period columns unknown;
  the point-in-time columns (shares, average cost, price, market value) are the
  portfolio summary's and are unaffected.
- The per-account breakdown rows under a security held in two accounts keep the
  point-in-time columns and leave the period columns empty: the measure is per
  security, and an all-time figure under a period caption is the defect this
  removes.

## 7. Where it is computed

- `backend/src/net-worth/security-period-result.util.ts`: the pure split of
  positions and flows by security and the price change; the policy stays in
  `investedPeriodResult`.
- `backend/src/net-worth/security-period-results.service.ts`: loads the
  positions (`NetWorthService.getDailyInvestmentPositions`), the flow rows and
  the closes for the window `PortfolioPeriodResultService.measuredFrom` draws,
  through the same rate index and read-path rate fill.
- `GET /net-worth/investments-period-result/securities`: the same query
  parameters as `investments-period-result`.
- `frontend/src/components/reports/InvestmentPerformanceReport.tsx`: the window
  from `usePortfolioRangeWindow`, the cards from `usePortfolioPeriodResult`, the
  rows from the new route.

The custom investment report's period columns
(`docs/specs/investment-report-period-returns.md`) remain Modified Dietz over
price dates; this report's rows are the Investments page's measure, which is the
figure they are compared against.

## 8. Test matrix

| Test | Where |
|---|---|
| Cases A to G, the reconciliation with `investedPeriodResult` over the summed series | `backend/src/net-worth/security-period-result.util.spec.ts` |
| Unpriced and unconverted days withhold only their own row | same |
| Price change: missing start, missing end, non-positive start, split | same |
| The service resolves the window through `measuredFrom` and folds flows per security | `backend/src/net-worth/security-period-results.service.spec.ts` |
| The route validates `period`, dates, account ids and currency like its sibling | `backend/src/net-worth/net-worth.controller.spec.ts` |
| The report's cards read the period result, rows read the new route, a closed position is a row, the sub-rows leave the period columns empty, the ranges are the ten | `frontend/src/components/reports/InvestmentPerformanceReport.test.tsx` |
