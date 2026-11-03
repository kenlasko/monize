import { describe, it, expect } from 'vitest';
import { DirectionFilter, MetricType } from '@/types/custom-report';
import { customReportMeasure, isSignedTransactionList } from './custom-report-measure';

const config = (metric: MetricType, direction: DirectionFilter, includeTransfers = false) => ({
  metric,
  direction,
  includeTransfers,
});

describe('customReportMeasure', () => {
  it('names a both-direction list a net amount, or net cash movement with transfers', () => {
    expect(customReportMeasure(config(MetricType.NONE, DirectionFilter.BOTH))).toBe('netAmount');
    expect(customReportMeasure(config(MetricType.NONE, DirectionFilter.BOTH, true))).toBe('netCashMovement');
  });

  it('names a both-direction aggregate as unsigned category amounts', () => {
    expect(customReportMeasure(config(MetricType.TOTAL_AMOUNT, DirectionFilter.BOTH))).toBe('unsignedTotal');
    expect(customReportMeasure(config(MetricType.AVERAGE, DirectionFilter.BOTH))).toBe('unsignedAverage');
  });

  it('leaves one direction, a count and a budget variance unnamed', () => {
    expect(customReportMeasure(config(MetricType.NONE, DirectionFilter.EXPENSES_ONLY))).toBeNull();
    expect(customReportMeasure(config(MetricType.TOTAL_AMOUNT, DirectionFilter.INCOME_ONLY))).toBeNull();
    expect(customReportMeasure(config(MetricType.COUNT, DirectionFilter.BOTH))).toBeNull();
    expect(customReportMeasure(config(MetricType.BUDGET_VARIANCE, DirectionFilter.BOTH))).toBeNull();
  });
});

describe('isSignedTransactionList', () => {
  it('is only a list of transactions in both directions', () => {
    expect(isSignedTransactionList(config(MetricType.NONE, DirectionFilter.BOTH))).toBe(true);
    expect(isSignedTransactionList(config(MetricType.NONE, DirectionFilter.INCOME_ONLY))).toBe(false);
    expect(isSignedTransactionList(config(MetricType.TOTAL_AMOUNT, DirectionFilter.BOTH))).toBe(false);
  });
});
