import { moneyDecimalsForCurrency, sumMoney } from '@/lib/format';

/**
 * The INVESTED part of a portfolio value point, for the surfaces that draw it.
 *
 * Cash held in an investment account is not an investment, so "Portfolio value
 * over time", the dashboard's portfolio widget and the Portfolio Value report
 * plot the securities alone: a deposit that has not been invested must not draw
 * as a rise in the portfolio's value, and the chart's headline figures read the
 * invested part's P&L and time-weighted return so the chart and the
 * "Portfolio performance" card cannot disagree on one page
 * (INV-PORTRESULT-002, `docs/specs/portfolio-period-result.md` section 10.7).
 *
 * The net worth chart is net worth and keeps reading `value`; so do the daily
 * movement notification and the calendar's day layer, which measure the
 * account rather than the investments.
 *
 * `securitiesValue` is absent from a response an older backend produced
 * mid-deploy, and absent is NO INFORMATION rather than zero: such a point falls
 * back to the whole value, which is exactly what it drew before. Drawing zero
 * would claim the portfolio held nothing.
 */
export function investedValue(point: {
  value: number;
  securitiesValue?: number | null;
}): number {
  return point.securitiesValue ?? point.value;
}

/**
 * The key of the cash band in an investment-breakdown response, or `null` when
 * the response carries none. The band is identified by its `type`, never by a
 * hardcoded key string, so the sentinel the server chose stays the server's.
 */
export function breakdownCashKey(
  series: ReadonlyArray<{ key: string; type: 'security' | 'cash' | 'other' }>,
): string | null {
  return series.find((s) => s.type === 'cash')?.key ?? null;
}

/**
 * The INVESTED value of one breakdown point: its `total` less the cash band.
 *
 * The breakdown response's `total` folds the scope's cash into it, but the
 * Portfolio Value report's one measure is the securities alone -- the same
 * INVESTED value the sum line plots (`investedValue` above). Reading `total`
 * for the KPIs, the table's total column and the CSV made the "By security"
 * view draw securities+cash while the "Total" view drew securities, so
 * switching views silently changed the high, the low and the exported figure
 * (INV-PORTRESULT-002). Deriving here, rather than adding a per-point backend
 * field, keeps the cash band available to draw as its own labelled band.
 *
 * The server rounds `total` and the securities subtotal once each at the
 * currency's places and makes the cash band their difference, so `total` less
 * the cash band is the securities' own rounding, the figure the daily series
 * reports for the day. Both are decimals rather than whole units (150.01 less
 * 50.00 is 100.00999999999999 in floats), so the difference is taken in
 * `currencyCode`'s money units (`sumMoney`), which is exact.
 */
export function breakdownInvestedValue(
  point: { total: number; values: Record<string, number> },
  cashKey: string | null,
  currencyCode: string,
): number {
  if (cashKey === null) return point.total;
  return sumMoney(
    [point.total, -(point.values[cashKey] ?? 0)],
    moneyDecimalsForCurrency(currencyCode),
  );
}
