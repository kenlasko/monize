import { describe, it, expect } from 'vitest';
import { DirectionFilter, GroupByType, MetricType } from '@/types/custom-report';
import { customReportMeasure, isSignedTransactionList } from './custom-report-measure';

const report = (
  metric: MetricType,
  direction: DirectionFilter,
  includeTransfers = false,
  groupBy = GroupByType.NONE,
) => ({
  groupBy,
  config: { metric, direction, includeTransfers },
});

describe('customReportMeasure', () => {
  it('names a both-direction list a net amount, or net cash movement with transfers', () => {
    expect(customReportMeasure(report(MetricType.NONE, DirectionFilter.BOTH))).toBe('netAmount');
    expect(customReportMeasure(report(MetricType.NONE, DirectionFilter.BOTH, true))).toBe('netCashMovement');
  });

  it('names a both-direction aggregate as unsigned category amounts', () => {
    expect(customReportMeasure(report(MetricType.TOTAL_AMOUNT, DirectionFilter.BOTH))).toBe('unsignedTotal');
    expect(customReportMeasure(report(MetricType.AVERAGE, DirectionFilter.BOTH))).toBe('unsignedAverage');
  });

  // A grouped No Aggregation report sums each group's unsigned cells on the
  // server; only the ungrouped list signs its rows.
  it('names a grouped both-direction No Aggregation report an unsigned total, never a net', () => {
    for (const groupBy of [GroupByType.CATEGORY, GroupByType.MONTH, GroupByType.PAYEE, GroupByType.TAG]) {
      expect(customReportMeasure(report(MetricType.NONE, DirectionFilter.BOTH, false, groupBy))).toBe('unsignedTotal');
      expect(customReportMeasure(report(MetricType.NONE, DirectionFilter.BOTH, true, groupBy))).toBe('unsignedTotal');
    }
  });

  it('leaves one direction, a count and a budget variance unnamed', () => {
    expect(customReportMeasure(report(MetricType.NONE, DirectionFilter.EXPENSES_ONLY))).toBeNull();
    expect(customReportMeasure(report(MetricType.TOTAL_AMOUNT, DirectionFilter.INCOME_ONLY))).toBeNull();
    expect(customReportMeasure(report(MetricType.COUNT, DirectionFilter.BOTH))).toBeNull();
    expect(customReportMeasure(report(MetricType.BUDGET_VARIANCE, DirectionFilter.BOTH))).toBeNull();
  });
});

describe('isSignedTransactionList', () => {
  it('is only an ungrouped list of transactions in both directions', () => {
    expect(isSignedTransactionList(report(MetricType.NONE, DirectionFilter.BOTH))).toBe(true);
    expect(isSignedTransactionList(report(MetricType.NONE, DirectionFilter.INCOME_ONLY))).toBe(false);
    expect(isSignedTransactionList(report(MetricType.TOTAL_AMOUNT, DirectionFilter.BOTH))).toBe(false);
    expect(
      isSignedTransactionList(report(MetricType.NONE, DirectionFilter.BOTH, false, GroupByType.CATEGORY)),
    ).toBe(false);
  });
});
