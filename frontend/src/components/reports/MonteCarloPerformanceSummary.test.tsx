import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import {
  PerformanceSummaryTable,
  buildPerformanceSummaryRows,
  formatSummaryValue,
  PERFORMANCE_SUMMARY_HEADERS,
} from './MonteCarloPerformanceSummary';

const band = (p: number) => ({ p10: p, p25: p, p50: p, p75: p, p90: p });

const summary: any = {
  twrNominal: band(0.05),
  twrReal: band(0.03),
  endBalanceNominal: band(100000),
  endBalanceReal: band(80000),
  meanReturnNominal: band(0.06),
  annualizedVolatility: band(0.15),
  maxDrawdown: band(-0.2),
  maxDrawdownExcludingCashflows: band(-0.18),
  safeWithdrawalRate: band(0.04),
  perpetualWithdrawalRate: band(0.035),
};

const fmt = (v: number) => `$${v.toFixed(0)}`;

describe('formatSummaryValue', () => {
  it('returns em dash for non-finite values', () => {
    expect(formatSummaryValue(Infinity, 'percent', fmt)).toBe('—');
    expect(formatSummaryValue(NaN, 'currency', fmt)).toBe('—');
  });
  it('formats currency', () => {
    expect(formatSummaryValue(1234, 'currency', fmt)).toBe('$1234');
  });
  it('formats percent', () => {
    expect(formatSummaryValue(0.1234, 'percent', fmt)).toBe('12.34%');
  });
  it('formats ratio', () => {
    expect(formatSummaryValue(1.235, 'ratio', fmt)).toBe('1.24');
  });
});

describe('buildPerformanceSummaryRows', () => {
  it('returns 10 rows with expected fields', () => {
    const rows = buildPerformanceSummaryRows(summary);
    expect(rows.length).toBe(10);
    expect(rows[0].label).toMatch(/Time Weighted Rate of Return/);
    expect(PERFORMANCE_SUMMARY_HEADERS[0]).toBe('Summary Statistics');
  });
});

describe('PerformanceSummaryTable', () => {
  it('renders all rows including currency, percent, and ratio formats', () => {
    render(<PerformanceSummaryTable summary={summary} formatCurrency={fmt} />);
    expect(screen.getByText('50th Percentile')).toBeInTheDocument();
    expect(screen.getAllByText('5.00%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$100000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Maximum Drawdown').length).toBeGreaterThan(0);
  });
});
