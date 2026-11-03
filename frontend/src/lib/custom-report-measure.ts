import { DirectionFilter, GroupByType, MetricType, type CustomReport } from '@/types/custom-report';

/**
 * What a custom report's headline measures, when a plain "Total" would not say
 * (discussion #1978). The server decides the figures; this only names them.
 *
 * - `netAmount` / `netCashMovement`: an ungrouped list of transactions in both
 *   directions keeps each row's sign, so its total is the signed net of the
 *   listed rows. With transfers included, a transfer leg is in that sum, so it
 *   is cash movement rather than income less expenses (INV-REPORT-003).
 * - `unsignedTotal` / `unsignedAverage`: an aggregate in both directions adds
 *   the magnitude of each category's net (INV-REPORT-004), so income and
 *   spending add up instead of cancelling. A grouped No Aggregation report is
 *   one of these: the server sums each group's cells, it lists no rows.
 * - `null`: one direction, a count or a budget variance, where "Total" is
 *   already accurate.
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
 * A list of transactions in both directions, whose rows keep their signs. Only
 * the ungrouped No Aggregation report lists rows; grouped, the same metric
 * returns one unsigned cell per group (`aggregateNoGrouping` in
 * backend/src/reports/reports.service.ts is the only path that signs).
 */
export function isSignedTransactionList({ groupBy, config }: MeasureReport): boolean {
  return (
    groupBy === GroupByType.NONE &&
    config.metric === MetricType.NONE &&
    config.direction === DirectionFilter.BOTH
  );
}

export function customReportMeasure(report: MeasureReport): CustomReportMeasure | null {
  const { config } = report;
  if (config.direction !== DirectionFilter.BOTH) return null;
  switch (config.metric) {
    case MetricType.NONE:
      if (!isSignedTransactionList(report)) return 'unsignedTotal';
      return config.includeTransfers ? 'netCashMovement' : 'netAmount';
    case MetricType.TOTAL_AMOUNT:
      return 'unsignedTotal';
    case MetricType.AVERAGE:
      return 'unsignedAverage';
    default:
      return null;
  }
}
