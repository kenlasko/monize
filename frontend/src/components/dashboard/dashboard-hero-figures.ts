import type { MonthlyNetWorth } from '@/types/net-worth';
import type { ConvertedTotal } from '@/lib/currency-total';
import { netWorthIsPartial, partialTotalFor } from '@/lib/net-worth-completeness';
import { roundMoney } from '@/lib/format';

/**
 * The dashboard hero's figures, read from the monthly net worth series the
 * Net Worth widget and report share. The newest month is the current one.
 */

export interface HeroSnapshot {
  netWorth: ConvertedTotal;
  assets: ConvertedTotal;
  liabilities: ConvertedTotal;
}

/**
 * The newest month's net worth, assets and liabilities, each marked as a
 * subtotal by its own completeness flag (a side's own flag first, the month's
 * otherwise). `null` when the series is empty: there is no figure to show,
 * which is not a net worth of zero.
 */
export function heroSnapshot(series: readonly MonthlyNetWorth[]): HeroSnapshot | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  return {
    netWorth: partialTotalFor(last.netWorth, netWorthIsPartial(last) ? false : undefined, last.missingRatePairs),
    assets: partialTotalFor(last.assets, last.assetsFxComplete ?? last.fxComplete, last.missingRatePairs),
    liabilities: partialTotalFor(
      last.liabilities,
      last.liabilitiesFxComplete ?? last.fxComplete,
      last.missingRatePairs,
    ),
  };
}

export interface HeroMonthChange {
  /** False when either month is a subtotal: a change measured from or to one is not a change. */
  known: boolean;
  /** Net worth now less net worth at the end of last month. */
  amount: number;
  /** `amount` over last month's magnitude; `null` when last month was exactly zero. */
  percent: number | null;
}

/**
 * Net worth's change this month: the newest month against the one before it,
 * rounded at the reporting currency's money precision (`moneyDecimalsForCurrency`)
 * only to shed float error -- never to whole units or to cents.
 * `null` with fewer than two months, where there is nothing to compare.
 */
export function heroMonthChange(
  series: readonly MonthlyNetWorth[],
  moneyDecimals: number,
): HeroMonthChange | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const previous = series[series.length - 2];
  const amount = roundMoney(last.netWorth - previous.netWorth, moneyDecimals);
  return {
    known: !netWorthIsPartial(last) && !netWorthIsPartial(previous),
    amount,
    percent: previous.netWorth === 0 ? null : (amount / Math.abs(previous.netWorth)) * 100,
  };
}
