import { FxAggregate } from "../common/fx-aggregate";
import { reportFigure } from "../common/report-figure";

/**
 * The foreign-transaction fee one transaction carries, positive, in its
 * account's currency: the bank folds the fee into `amount` (amount =
 * round(originalAmount x exchangeRate) + fee, with fee <= 0), so the fee is the
 * converted base re-derived at the account currency's precision
 * (`:feeDecimals`) less the amount. Written once, for the per-account summary
 * and the report's totals.
 */
export const FX_FEE_AMOUNT_SQL =
  "CASE WHEN transaction.originalAmount IS NULL THEN 0 " +
  "ELSE ROUND(transaction.originalAmount * transaction.exchangeRate, CAST(:feeDecimals AS int)) - transaction.amount " +
  "END";

/** The column width of the fee chart. */
export type FxFeeGranularity = "month" | "quarter" | "year";

export const FX_FEE_GRANULARITIES: readonly FxFeeGranularity[] = [
  "month",
  "quarter",
  "year",
];

/** One column of the fee chart: its fees read once, and how many transactions. */
export interface FxFeeBucket {
  /** `YYYY-MM`, `YYYY-Qn` or `YYYY`, the key the chart buckets by. */
  key: string;
  /** First day of the period, `YYYY-MM-DD`. */
  periodStart: string;
  total: number;
  count: number;
}

/** The chart's figures at one granularity. */
export interface FxFeeGranularityTotals {
  buckets: FxFeeBucket[];
  /**
   * The window's fees over the periods from the first populated one to the
   * last, the empty ones between included, divided before it is read.
   */
  periodAverage: number;
}

/** One month's fees, folded across accounts and paid currencies. */
export interface FxFeeMonthPart {
  sum: FxAggregate;
  count: number;
}

function periodOf(
  month: string,
  granularity: FxFeeGranularity,
): { key: string; periodStart: string; index: number } {
  const [year, monthNumber] = month.split("-").map(Number);
  if (granularity === "year") {
    return { key: `${year}`, periodStart: `${year}-01-01`, index: year };
  }
  if (granularity === "quarter") {
    const quarter = Math.floor((monthNumber - 1) / 3);
    const startMonth = String(quarter * 3 + 1).padStart(2, "0");
    return {
      key: `${year}-Q${quarter + 1}`,
      periodStart: `${year}-${startMonth}-01`,
      index: year * 4 + quarter,
    };
  }
  return {
    key: month,
    periodStart: `${month}-01`,
    index: year * 12 + monthNumber - 1,
  };
}

/**
 * The fee chart's columns and averages at every granularity, from each
 * month's folded fees: a quarter or a year is its months' aggregates merged
 * and read once, never the sum of the months' readings, and the grand total
 * and each average come from the window's one aggregate
 * (docs/specs/report-rounding-and-aggregation.md rules 2 and 8). Three fees of
 * 2.50496 read 7.51 together, where three readings of 2.50 add to 7.50.
 */
export function foldFxFeeTotals(
  months: ReadonlyMap<string, FxFeeMonthPart>,
  places: number,
): {
  total: number;
  count: number;
  byGranularity: Record<FxFeeGranularity, FxFeeGranularityTotals>;
} {
  const whole = FxAggregate.sum([...months.values()].map((part) => part.sum));
  let count = 0;
  for (const part of months.values()) count += part.count;
  const sorted = [...months.keys()].sort();

  const at = (granularity: FxFeeGranularity): FxFeeGranularityTotals => {
    const columns = new Map<
      string,
      { periodStart: string; index: number; sum: FxAggregate; count: number }
    >();
    for (const month of sorted) {
      const part = months.get(month)!;
      const { key, periodStart, index } = periodOf(month, granularity);
      const column = columns.get(key) ?? {
        periodStart,
        index,
        sum: new FxAggregate(),
        count: 0,
      };
      column.sum.merge(part.sum);
      column.count += part.count;
      columns.set(key, column);
    }
    const indexes = [...columns.values()].map((column) => column.index);
    const periods =
      indexes.length === 0
        ? 0
        : Math.max(...indexes) - Math.min(...indexes) + 1;
    return {
      buckets: [...columns].map(([key, column]) => ({
        key,
        periodStart: column.periodStart,
        total: column.sum.knownSubtotalAt(places),
        count: column.count,
      })),
      periodAverage:
        periods > 0
          ? reportFigure(whole.unroundedSubtotal / periods, places)
          : 0,
    };
  };

  return {
    total: whole.knownSubtotalAt(places),
    count,
    byGranularity: {
      month: at("month"),
      quarter: at("quarter"),
      year: at("year"),
    },
  };
}
