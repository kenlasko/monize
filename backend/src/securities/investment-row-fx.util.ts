/**
 * The rate that takes one investment row's amount into a target currency, by
 * the rule INV-FX-002 sets: the row's OWN rate first, the one its cash leg
 * settled at, carried onward at the market rate on the row's date when its
 * settlement currency is not the target; the market rate on the row's date for
 * the whole pair otherwise (INV-FX-001). Never today's rate for a past row
 * (issue #2106), never 1 for a pair with no rate.
 *
 * `rateOn` answers the market rate for a pair on a date, or `null`.
 */

/**
 * Which rate a row is converted at, as a value the response can carry.
 *
 * `transaction` -- the row's own stored rate did the conversion (possibly
 * carried onward from its settlement currency at the market rate). `market` --
 * the row carries no usable rate of its own, so the rate that stood on its
 * trade date was used. `null` -- the row was not converted at all: it is
 * already in the target currency, or no rate could be found.
 */
export type InvestmentConversionBasis = "transaction" | "market" | null;

/**
 * The row's own rate, or `null` when it cannot be used.
 *
 * A stored `1` across two different currencies is the column's default rather
 * than a rate anybody struck ("rate 1 means same currency, never no rate
 * found"), so such a row is converted at the market rate instead.
 */
export function usableRowRate(
  storedRate: string | number | null,
  amountCurrency: string,
  settlementCurrency: string | null,
): number | null {
  if (storedRate === null || storedRate === undefined) return null;
  const rate = Number(storedRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (rate === 1 && amountCurrency !== settlementCurrency) return null;
  return rate;
}

/** What one row's conversion needs to know about the row. */
export interface InvestmentRowFxSource {
  /** The currency the row's amount is in: the security's, else the account's. */
  amountCurrency: string | null;
  /** Where its cash leg settled: the funding account, the linked cash, the account. */
  settlementCurrency: string | null;
  /** The row's own rate, amount currency -> settlement currency. */
  exchangeRate: string | number | null;
  /** `YYYY-MM-DD` of the trade. */
  date: string;
}

export type InvestmentRowMarketRate = (
  from: string,
  to: string,
  date: string,
) => Promise<number | null> | number | null;

export interface InvestmentRowRate {
  /** The factor taking the row's amount into the target; null when none applies. */
  rate: number | null;
  basis: InvestmentConversionBasis;
  /** The row's own rate carried onward at the market's. */
  onward: boolean;
}

export async function investmentRowRateInto(
  target: string,
  row: InvestmentRowFxSource,
  rateOn: InvestmentRowMarketRate,
): Promise<InvestmentRowRate> {
  const from = row.amountCurrency;
  if (from === null) return { rate: null, basis: null, onward: false };
  if (from === target) return { rate: 1, basis: null, onward: false };
  const settlement = row.settlementCurrency;
  const rowRate = usableRowRate(row.exchangeRate, from, settlement);
  if (rowRate !== null && settlement !== null) {
    if (settlement === target) {
      return { rate: rowRate, basis: "transaction", onward: false };
    }
    const onward = await rateOn(settlement, target, row.date);
    if (onward !== null) {
      return { rate: rowRate * onward, basis: "transaction", onward: true };
    }
    // No onward rate: the market rate for the whole pair can still answer.
  }
  const rate = await rateOn(from, target, row.date);
  return { rate, basis: rate === null ? null : "market", onward: false };
}
