import { FxAggregate } from "../common/fx-aggregate";
import { roundMoney } from "../common/round.util";
import { MetricType } from "./entities/custom-report.entity";
import type {
  AggregatedDataPoint,
  ReportSummary,
} from "./dto/execute-report.dto";

/**
 * A custom report's row with the unrounded sum its money figure was read from.
 *
 * The figure on `point` is rounded once, for the row. Everything built from
 * the rows -- the headline, the average, a share, a budget variance -- folds
 * `sum`, never the rounded `point.value`: summing rounded group values made the
 * headline depend on the grouping, so two 100.01 EUR receipts at 1.2474 read
 * 249.5049 grouped by category and 249.5050 grouped by payee
 * (`docs/specs/report-rounding-and-aggregation.md` rules 2 and 4).
 */
export interface ReportRow {
  point: AggregatedDataPoint;
  /**
   * The row's money before rounding: its value under a total, the numerator of
   * its mean under an average, actual less budget under a variance. `null` on
   * a listed line with no rate, which is in no sum.
   */
  sum: FxAggregate | null;
}

/** An aggregate holding one converted value, or `null` for no value. */
export function sumOf(value: number | null): FxAggregate | null {
  if (value === null) return null;
  const sum = new FxAggregate();
  sum.addConverted(value);
  return sum;
}

/** The aggregates of `rows` folded into one; rows with no value add nothing. */
export function mergedSum(rows: readonly ReportRow[]): FxAggregate {
  const total = new FxAggregate();
  for (const row of rows) {
    if (row.sum !== null && row.point.value !== null) total.merge(row.sum);
  }
  return total;
}

/**
 * A group's figure for `metric`, rounded once from its unrounded `sum`: a
 * mean divides first and rounds after, so it is not the mean of a rounded sum.
 */
export function metricValue(
  sum: FxAggregate,
  count: number,
  metric: MetricType,
): number {
  switch (metric) {
    case MetricType.COUNT:
      return count;
    case MetricType.AVERAGE:
      return count > 0 ? roundMoney(sum.unroundedSubtotal / count) : 0;
    default:
      return sum.knownSubtotal;
  }
}

/**
 * `part`'s share of `whole` in percent, from the unrounded values; 0 unless the
 * whole is positive. A share is not additive, so it is divided before anything
 * is rounded (rule 8).
 */
export function shareOf(part: FxAggregate, whole: FxAggregate): number {
  return whole.sign > 0
    ? (part.unroundedSubtotal / whole.unroundedSubtotal) * 100
    : 0;
}

/**
 * The headline figures. A money total is withheld (`null`) while any row was
 * left out for want of a rate or by the row limit, and `knownTotal` carries
 * the part that did convert. The count metric sums counts, which need no
 * rate, but a truncated read counts only what it read. The average metric's
 * headline is the mean over every row (the groups' sums over their counts),
 * never the sum of the groups' means. Every money figure here is the single
 * rounding of the rows' folded sums.
 */
export function summarizeRows(
  rows: readonly ReportRow[],
  metric: MetricType,
  complete: boolean,
): ReportSummary {
  const count = rows.reduce((acc, row) => acc + (row.point.count ?? 1), 0);
  let knownTotal: number;
  let mean: number;
  if (metric === MetricType.COUNT) {
    knownTotal = rows.reduce((acc, row) => acc + (row.point.value ?? 0), 0);
    mean = count > 0 ? roundMoney(knownTotal / count) : 0;
  } else {
    const sum = mergedSum(rows);
    mean = count > 0 ? roundMoney(sum.unroundedSubtotal / count) : 0;
    knownTotal = metric === MetricType.AVERAGE ? mean : sum.knownSubtotal;
  }
  return {
    total: complete ? knownTotal : null,
    knownTotal,
    count,
    average: complete ? mean : null,
  };
}
