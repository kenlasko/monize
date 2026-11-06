import { FIAT_MONEY_DECIMALS, moneyDecimalsFor, roundToDecimals, sumMoney } from './format';

/**
 * A single day's balance in a Balance History series. `date` must be an ISO
 * `yyyy-MM-dd` string so points can be ordered by plain string comparison.
 */
export interface DailyBalancePoint {
  date: string;
  /**
   * The day's balance, or `null` when it could not be worked out -- a
   * multi-currency series with a missing rate for one of its accounts. A gap is
   * not a zero and not a smaller balance, so the chart breaks the line there and
   * the summary refuses to describe a series it cannot read.
   */
  balance: number | null;
}

export interface BalanceSummary {
  startBalance: number;
  /** Balance at the most recent data point on or before today. */
  currentBalance: number;
  endBalance: number;
  /** True when at least one post-today point differs from the current balance. */
  hasFutureData: boolean;
  minBalance: number;
  goesNegative: boolean;
}

/**
 * Summarises a daily balance series the way the Balance History chart's
 * footer does, so other surfaces (e.g. the Account Info widget) show the
 * exact same "Current" figure. Balances are rounded up front to
 * `decimalPlaces` to match the chart's plotted points: the series currency's
 * own places (`getDecimalPlacesForCurrency`, so a 0.00002500 BTC wallet stays
 * 0.00002500 rather than reading 0.00), the fiat money precision
 * (`FIAT_MONEY_DECIMALS`) when the currency is not known, or `null` to keep each value as given (a price series
 * quoted below money precision).
 */
export function computeBalanceSummary(
  data: ReadonlyArray<DailyBalancePoint>,
  decimalPlaces: number | null = FIAT_MONEY_DECIMALS,
): BalanceSummary | null {
  if (data.length === 0) return null;

  // A summary is a claim about the whole series: start, current, end, minimum,
  // "goes negative". Every one of those is unanswerable once a day is unknown,
  // and answering from the days that are known would report a minimum that may
  // not be the minimum. Refuse instead.
  if (data.some((d) => d.balance === null)) return null;

  const points = data.map((d) => ({
    date: d.date,
    balance:
      decimalPlaces === null
        ? (d.balance as number)
        : roundToDecimals(d.balance as number, decimalPlaces),
  }));

  const startBalance = points[0].balance;
  const endBalance = points[points.length - 1].balance;

  // Find balance as of today (last data point on or before today)
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let currentBalance = endBalance;
  let todayAnchorIdx = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].date <= todayStr) {
      currentBalance = points[i].balance;
      todayAnchorIdx = i;
      break;
    }
  }
  if (todayAnchorIdx === -1) {
    // All data points are in the future
    currentBalance = startBalance;
  }

  // The backend returns one data point per day in the filtered range, so
  // chart points strictly after today do NOT necessarily mean future
  // transactions exist — the balance simply carries forward on days with
  // no activity. Only consider the range as having future data when at
  // least one post-today point differs from the current balance.
  let hasFutureData = false;
  for (let i = todayAnchorIdx + 1; i < points.length; i++) {
    if (points[i].balance !== currentBalance) {
      hasFutureData = true;
      break;
    }
  }

  let minBalance = startBalance;
  for (const point of points) {
    if (point.balance < minBalance) minBalance = point.balance;
  }

  return {
    startBalance,
    currentBalance,
    endBalance,
    hasFutureData,
    minBalance,
    goesNegative: minBalance < 0,
  };
}

/**
 * The mean of a daily balance series, rounded to `decimalPlaces` (the
 * account currency's own places; the fiat money precision when it is not
 * known). Summed exactly at that currency's money precision
 * (`sumMoney(..., moneyDecimalsFor(decimalPlaces))`: four for fiat, a coin's
 * eight) so a long series does not drift, and divided once.
 *
 * `null` when the mean cannot be stated: an empty series, or one with a day
 * whose balance is unknown. The mean of the days that happen to be known is not
 * the mean of all of them, so the caller decides what to show instead.
 */
export function averageDailyBalance(
  data: ReadonlyArray<DailyBalancePoint>,
  decimalPlaces: number = FIAT_MONEY_DECIMALS,
): number | null {
  if (data.length === 0) return null;
  const balances: number[] = [];
  for (const point of data) {
    if (point.balance === null) return null;
    balances.push(point.balance);
  }
  return roundToDecimals(
    sumMoney(balances, moneyDecimalsFor(decimalPlaces)) / balances.length,
    decimalPlaces,
  );
}

/**
 * Opacity stops for a balance area's vertical gradient. The fill is densest
 * along the data line and fades to transparent at the zero axis, whether
 * balances are positive, negative, or cross zero. `zeroOffset` is the fraction
 * (measured from the top of the area's bounding box) at which the zero line
 * falls, clamped to [0, 1] so all-positive data keeps the original
 * top-to-bottom fade and all-negative data mirrors it (shading increasing
 * toward the bottom).
 */
export function computeBalanceGradient(values: number[]): {
  topOpacity: number;
  zeroOffset: number;
  bottomOpacity: number;
} {
  const SHADE = 0.3;
  if (values.length === 0) {
    return { topOpacity: SHADE, zeroOffset: 1, bottomOpacity: 0 };
  }
  let max = values[0];
  let min = values[0];
  for (const value of values) {
    if (value > max) max = value;
    if (value < min) min = value;
  }
  const span = max - min;
  const zeroOffset =
    span === 0 ? (max >= 0 ? 1 : 0) : Math.min(1, Math.max(0, max / span));
  return {
    topOpacity: max > 0 ? SHADE : 0,
    zeroOffset,
    bottomOpacity: min < 0 ? SHADE : 0,
  };
}
