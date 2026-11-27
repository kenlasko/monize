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

  it.each(Object.values(GroupByType))('names the signed Both / Total Amount for %s', (groupBy) => {
    expect(customReportMeasure(report(MetricType.TOTAL_AMOUNT, DirectionFilter.BOTH, false, groupBy), true)).toBe('netAmount');
    expect(customReportMeasure(report(MetricType.TOTAL_AMOUNT, DirectionFilter.BOTH, true, groupBy), true)).toBe('netCashMovement');
  });

  it.each([DirectionFilter.INCOMING, DirectionFilter.OUTGOING])('names signed and unsigned measures after filtering by %s', (direction) => {
    expect(customReportMeasure(report(MetricType.TOTAL_AMOUNT, direction), true)).toBe('netAmount');
    expect(customReportMeasure(report(MetricType.NONE, direction, true))).toBe('netCashMovement');
    expect(customReportMeasure(report(MetricType.NONE, direction, false, GroupByType.MONTH))).toBe('unsignedTotal');
    expect(customReportMeasure(report(MetricType.AVERAGE, direction))).toBe('unsignedAverage');
  });

  it('keeps a legacy Both / Total Amount unsigned when the response has no signed-total marker', () => {
    expect(customReportMeasure(report(MetricType.TOTAL_AMOUNT, DirectionFilter.BOTH))).toBe('unsignedTotal');
  });

  it('keeps the Both / Average measure unsigned', () => {
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
