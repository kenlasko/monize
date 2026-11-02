import { DirectionFilter, MetricType, type ReportConfig } from '@/types/custom-report';

/**
 * What a custom report's headline measures, when a plain "Total" would not say
 * (discussion #1978). The server decides the figures; this only names them.
 *
 * - `netAmount` / `netCashMovement`: a list of transactions in both directions
 *   keeps each row's sign, so its total is the signed net of the listed rows.
 *   With transfers included, a transfer leg is in that sum, so it is cash
 *   movement rather than income less expenses (INV-REPORT-003).
 * - `unsignedTotal` / `unsignedAverage`: an aggregate in both directions adds
 *   the magnitude of each category's net (INV-REPORT-004), so income and
 *   spending add up instead of cancelling.
 * - `null`: one direction, a count or a budget variance, where "Total" is
 *   already accurate.
 */
export type CustomReportMeasure =
  | 'netAmount'
  | 'netCashMovement'
  | 'unsignedTotal'
  | 'unsignedAverage';

type MeasureConfig = Pick<ReportConfig, 'metric' | 'direction' | 'includeTransfers'>;

/** A list of transactions in both directions, whose rows keep their signs. */
export function isSignedTransactionList(config: MeasureConfig): boolean {
  return config.metric === MetricType.NONE && config.direction === DirectionFilter.BOTH;
}

export function customReportMeasure(config: MeasureConfig): CustomReportMeasure | null {
  if (config.direction !== DirectionFilter.BOTH) return null;
  switch (config.metric) {
    case MetricType.NONE:
      return config.includeTransfers ? 'netCashMovement' : 'netAmount';
    case MetricType.TOTAL_AMOUNT:
      return 'unsignedTotal';
    case MetricType.AVERAGE:
      return 'unsignedAverage';
    default:
      return null;
  }
}
