import { DirectionFilter, GroupByType, MetricType, type CustomReport } from '@/types/custom-report';

/**
 * What a custom report's headline measures, when a plain "Total" would not say
 * (discussion #1978). The server decides the figures; this only names them.
 *
 * Signed totals and individual posting lists keep the sign of each movement.
 * With transfers included, their net measures cash movement (INV-REPORT-003).
 * A signed average divides the net by the unit count of the grouping.
 */
export type CustomReportMeasure =
  | 'netAmount'
  | 'netCashMovement'
  | 'unsignedTotal'
  | 'average'
  | 'unsignedAverage';

type MeasureReport = Pick<CustomReport, 'groupBy'> & {
  config: Pick<CustomReport['config'], 'metric' | 'direction' | 'includeTransfers'>;
};

/**
 * Only ungrouped No Aggregation lists individual signed transactions.
 */
export function isSignedTransactionList({ groupBy, config }: MeasureReport): boolean {
  return (
    groupBy === GroupByType.NONE &&
    config.metric === MetricType.NONE &&
    config.direction !== DirectionFilter.EXPENSES_ONLY &&
    config.direction !== DirectionFilter.INCOME_ONLY
  );
}

export function customReportMeasure(report: MeasureReport, signedTotal = false): CustomReportMeasure | null {
  const { config } = report;
  if (config.direction === DirectionFilter.EXPENSES_ONLY || config.direction === DirectionFilter.INCOME_ONLY) return null;
  const sum = config.metric === MetricType.TOTAL_AMOUNT || config.metric === MetricType.NONE;
  if (isSignedTransactionList(report) || (signedTotal && sum)) {
    return config.includeTransfers ? 'netCashMovement' : 'netAmount';
  }
  switch (config.metric) {
    case MetricType.NONE:
    case MetricType.TOTAL_AMOUNT:
      // Grouped No Aggregation and Total Amount from older servers are unsigned.
      return 'unsignedTotal';
    case MetricType.AVERAGE:
      return signedTotal ? 'average' : 'unsignedAverage';
    default:
      return null;
  }
}
