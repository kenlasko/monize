/**
 * Shared recurring-charge detection used by the AI insights and forecast
 * aggregators. The actual query lives on `TransactionAnalyticsService` so both
 * surfaces return the same shape; this file holds the reusable type and the
 * frequency classifier.
 */

export interface RecurringCharge {
  payeeName: string;
  // Id of the linked payee record, or null for free-text payee names (e.g.
  // imported rows). Lets AI surfaces deep-link a recurring charge back to its
  // payee; a null id is rendered as plain text instead of a link.
  payeeId: string | null;
  /**
   * The currency every figure below is in: a charge is detected per currency,
   * so a payee billed in two currencies is two charges, never one series of
   * amounts in mixed units (issue #2155).
   */
  currencyCode: string;
  amounts: number[];
  dates: string[];
  frequency: string;
  currentAmount: number;
  previousAmount: number;
  categoryName: string | null;
  categoryId: string | null;
  /**
   * Present only when the caller named a reporting currency: the latest and
   * the previous occurrence converted into it, each at its own settled rate
   * where that reaches the currency (INV-FX-002), else the market rate on its
   * own date (INV-FX-001). `null` when that occurrence has no admissible rate,
   * never the native amount.
   */
  converted?: RecurringChargeConversion;
}

export interface RecurringChargeConversion {
  currency: string;
  currentAmount: number | null;
  previousAmount: number | null;
}

/**
 * Classify the cadence of a series of charge dates (ascending) by looking at
 * the average gap between consecutive dates and its variability. Returns
 * "irregular" when there are too few data points or the gaps are too noisy.
 */
export function detectFrequency(dates: string[]): string {
  if (dates.length < 3) return "irregular";

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const d1 = new Date(dates[i - 1]);
    const d2 = new Date(dates[i]);
    gaps.push(
      Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)),
    );
  }

  const avgGap = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
  const variance =
    gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length;
  const stdDev = Math.sqrt(variance);

  // Allow some variation in gap timing
  if (stdDev > avgGap * 0.4) return "irregular";

  if (avgGap >= 5 && avgGap <= 10) return "weekly";
  if (avgGap >= 12 && avgGap <= 18) return "biweekly";
  if (avgGap >= 25 && avgGap <= 35) return "monthly";
  if (avgGap >= 80 && avgGap <= 100) return "quarterly";
  if (avgGap >= 350 && avgGap <= 380) return "yearly";

  return "irregular";
}
