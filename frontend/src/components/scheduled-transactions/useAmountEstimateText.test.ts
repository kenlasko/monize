import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@/test/render';
import { useAmountEstimateText } from './useAmountEstimateText';
import type { ScheduleAmountEstimate } from '@/types/scheduled-transaction';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => numberFormatMockDefaults() };
});

const subject = { payeeName: 'Gas Co', categoryName: 'Utilities' };

const estimate = (fields: Partial<ScheduleAmountEstimate>): ScheduleAmountEstimate => ({
  status: 'estimated',
  currencyCode: 'CAD',
  months: {},
  paymentCount: 20,
  latestPaymentDate: '2026-10-26',
  growthRate: null,
  historyMonths: 24,
  missingPair: null,
  ...fields,
});

const textFor = (fields: Partial<ScheduleAmountEstimate>) => {
  const { result } = renderHook(() => useAmountEstimateText());
  return result.current(estimate(fields), subject);
};

// The figure is set by the latest year's payments or by the newest three, not
// by every payment in the 24-month history, and the text says which.
describe('useAmountEstimateText', () => {
  it("names the latest year's payments when they set the figure", () => {
    expect(textFor({ levelRule: 'year', levelPaymentCount: 12, seasonal: false })).toBe(
      'Average of 12 payments in the last 12 months, the latest on 2026-10-26.',
    );
  });

  it('names the newest payments when they set the figure', () => {
    expect(textFor({ levelRule: 'recent', levelPaymentCount: 3, seasonal: false })).toBe(
      'Average of the latest 3 payments, the latest on 2026-10-26.',
    );
  });

  it('says a trend grows the newest payments', () => {
    expect(
      textFor({ levelRule: 'recent', levelPaymentCount: 3, seasonal: false, growthRate: 0.05 }),
    ).toMatch(/^Average of the latest 3 payments, the latest on 2026-10-26, with a .+ change year over year\.$/);
  });

  it('says a season shapes the newest payments', () => {
    expect(textFor({ levelRule: 'recent', levelPaymentCount: 3, seasonal: true })).toBe(
      "Average of the latest 3 payments, adjusted for each month's season, the latest on 2026-10-26.",
    );
    expect(
      textFor({ levelRule: 'recent', levelPaymentCount: 3, seasonal: true, growthRate: 0.1 }),
    ).toMatch(/adjusted for each month's season, the latest on 2026-10-26, with a .+ change year over year\.$/);
  });

  it('names only the payment count for an older server that sends no rule', () => {
    expect(textFor({})).toBe('Estimated from 20 payments, the latest on 2026-10-26.');
  });

  it('withholds the counts from a delegate', () => {
    expect(
      textFor({ paymentCount: null, levelPaymentCount: null, latestPaymentDate: null, levelRule: 'year' }),
    ).toBe("Estimated from the payee and category's payment history.");
  });
});
