import { DirectionFilter, GroupByType, MetricType, type CustomReport } from '@/types/custom-report';

/**
 * What a custom report's headline measures, when a plain "Total" would not say
 * (discussion #1978). The server decides the figures; this only names them.
 *
 * - A server that returns `signedTotal` nets postings for Both / Total Amount.
 *   An ungrouped transaction list also keeps signs. With transfers included, the net
 *   measures cash movement (INV-REPORT-003).
 * - Both / Average and grouped No Aggregation use unsigned category amounts.
 * - One direction, a count or a budget variance keeps the default caption.
 */
export type CustomReportMeasure =
  | 'netAmount'
  | 'netCashMovement'
  | 'unsignedTotal'
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
    config.direction === DirectionFilter.BOTH
  );
}

export function customReportMeasure(report: MeasureReport, signedTotal = false): CustomReportMeasure | null {
  const { config } = report;
  if (config.direction !== DirectionFilter.BOTH) return null;
  if ((config.metric === MetricType.TOTAL_AMOUNT && signedTotal) || isSignedTransactionList(report)) {
    return config.includeTransfers ? 'netCashMovement' : 'netAmount';
  }
  switch (config.metric) {
    case MetricType.NONE:
    case MetricType.TOTAL_AMOUNT:
      // Grouped No Aggregation and Total Amount from older servers are unsigned.
      return 'unsignedTotal';
    case MetricType.AVERAGE:
      return 'unsignedAverage';
    default:
      return null;
  }
}
