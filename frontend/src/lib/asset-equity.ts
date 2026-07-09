import type { DailyBalancePoint } from '@/lib/balance-history';

export interface Appreciation {
  /** currentValue - purchaseValue. */
  total: number;
  /** total as a percentage of the purchase value (0 when unknown). */
  totalPercent: number;
  /** Compound annual growth since acquisition, or null when not computable. */
  annualizedPercent: number | null;
}

/**
 * Total and annualized appreciation of an asset since acquisition. The
 * annualized figure needs a positive purchase value and at least a month of
 * holding to be meaningful; otherwise it is null.
 */
export function computeAppreciation(
  currentValue: number,
  purchaseValue: number,
  dateAcquired: string | null,
  today: Date,
): Appreciation {
  const total = Math.round((currentValue - purchaseValue) * 100) / 100;
  const totalPercent = purchaseValue !== 0 ? (total / Math.abs(purchaseValue)) * 100 : 0;

  let annualizedPercent: number | null = null;
  if (dateAcquired && purchaseValue > 0 && currentValue > 0) {
    const [y, m, d] = dateAcquired.split('-').map(Number);
    const acquired = new Date(y, m - 1, d);
    const years = (today.getTime() - acquired.getTime()) / (365.25 * 86_400_000);
    if (years >= 1 / 12) {
      annualizedPercent = (Math.pow(currentValue / purchaseValue, 1 / years) - 1) * 100;
    }
  }

  return { total, totalPercent, annualizedPercent };
}

/**
 * Merge an asset's daily balances with its linked loan's balances into an
 * equity series (asset value minus the amount still owed). Balances are
 * forward-filled across the union of dates; the loan defaults to zero before
 * its first point (no debt yet), and dates before the asset's first point are
 * omitted (nothing to value).
 */
export function buildEquitySeries(
  assetPoints: DailyBalancePoint[],
  loanPoints: DailyBalancePoint[],
): DailyBalancePoint[] {
  const assetByDate = new Map(assetPoints.map((p) => [p.date, p.balance]));
  const loanByDate = new Map(loanPoints.map((p) => [p.date, p.balance]));
  const dates = Array.from(new Set([...assetByDate.keys(), ...loanByDate.keys()])).sort();

  const series: DailyBalancePoint[] = [];
  let lastAsset: number | undefined;
  let lastLoan = 0;
  for (const date of dates) {
    if (assetByDate.has(date)) lastAsset = assetByDate.get(date);
    if (loanByDate.has(date)) lastLoan = loanByDate.get(date)!;
    if (lastAsset === undefined) continue;
    series.push({ date, balance: Math.round((lastAsset - Math.abs(lastLoan)) * 100) / 100 });
  }
  return series;
}
