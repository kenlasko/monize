import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTimePeriod, TIME_PERIOD_OPTIONS, TimePeriod } from './time-periods';

describe('time-periods', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('TIME_PERIOD_OPTIONS', () => {
    it('has the correct number of options', () => {
      expect(TIME_PERIOD_OPTIONS).toHaveLength(10);
    });

    it('starts with placeholder option', () => {
      expect(TIME_PERIOD_OPTIONS[0]).toEqual({ value: '', label: 'Select period...' });
    });

    it('includes all expected periods', () => {
      const values = TIME_PERIOD_OPTIONS.map(o => o.value);
      expect(values).toContain('today');
      expect(values).toContain('yesterday');
      expect(values).toContain('this_week');
      expect(values).toContain('last_week');
      expect(values).toContain('month_to_date');
      expect(values).toContain('last_month');
      expect(values).toContain('year_to_date');
      expect(values).toContain('last_year');
      expect(values).toContain('custom');
    });
  });

  describe('resolveTimePeriod', () => {
    it('returns today for "today"', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 15)); // June 15, 2025
      const result = resolveTimePeriod('today');
      expect(result).toEqual({ startDate: '2025-06-15', endDate: '2025-06-15' });
    });

    it('returns yesterday for "yesterday"', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 15));
      const result = resolveTimePeriod('yesterday');
      expect(result).toEqual({ startDate: '2025-06-14', endDate: '2025-06-14' });
    });

    it('returns correct this_week range with Monday start (default)', () => {
      vi.useFakeTimers();
      // Wednesday June 18, 2025
      vi.setSystemTime(new Date(2025, 5, 18));
      const result = resolveTimePeriod('this_week', 1);
      expect(result).toEqual({ startDate: '2025-06-16', endDate: '2025-06-18' });
    });

    it('returns correct this_week range with Sunday start', () => {
      vi.useFakeTimers();
      // Wednesday June 18, 2025
      vi.setSystemTime(new Date(2025, 5, 18));
      const result = resolveTimePeriod('this_week', 0);
      expect(result).toEqual({ startDate: '2025-06-15', endDate: '2025-06-18' });
    });

    it('returns correct last_week range with Monday start', () => {
      vi.useFakeTimers();
      // Wednesday June 18, 2025
      vi.setSystemTime(new Date(2025, 5, 18));
      const result = resolveTimePeriod('last_week', 1);
      // Last week: Mon Jun 9 - Sun Jun 15
      expect(result).toEqual({ startDate: '2025-06-09', endDate: '2025-06-15' });
    });

    it('returns correct last_week range with Sunday start', () => {
      vi.useFakeTimers();
      // Wednesday June 18, 2025
      vi.setSystemTime(new Date(2025, 5, 18));
      const result = resolveTimePeriod('last_week', 0);
      // Last week: Sun Jun 8 - Sat Jun 14
      expect(result).toEqual({ startDate: '2025-06-08', endDate: '2025-06-14' });
    });

    it('returns correct month_to_date range', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 18));
      const result = resolveTimePeriod('month_to_date');
      expect(result).toEqual({ startDate: '2025-06-01', endDate: '2025-06-18' });
    });

    it('returns correct last_month range', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 18)); // June 18
      const result = resolveTimePeriod('last_month');
      expect(result).toEqual({ startDate: '2025-05-01', endDate: '2025-05-31' });
    });

    it('returns correct year_to_date range', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 18));
      const result = resolveTimePeriod('year_to_date');
      expect(result).toEqual({ startDate: '2025-01-01', endDate: '2025-06-18' });
    });

    it('returns correct last_year range', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 18));
      const result = resolveTimePeriod('last_year');
      expect(result).toEqual({ startDate: '2024-01-01', endDate: '2024-12-31' });
    });

    it('returns empty strings for "custom"', () => {
      const result = resolveTimePeriod('custom');
      expect(result).toEqual({ startDate: '', endDate: '' });
    });

    it('defaults weekStartsOn to Monday (1)', () => {
      vi.useFakeTimers();
      // Wednesday June 18, 2025
      vi.setSystemTime(new Date(2025, 5, 18));
      const result = resolveTimePeriod('this_week');
      // Default should be Monday start: Jun 16
      expect(result.startDate).toBe('2025-06-16');
    });

    it('handles edge case at year boundary for last_month', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 0, 15)); // January 15
      const result = resolveTimePeriod('last_month');
      expect(result).toEqual({ startDate: '2024-12-01', endDate: '2024-12-31' });
    });

    it('handles edge case at year boundary for last_year', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 0, 1)); // January 1
      const result = resolveTimePeriod('last_year');
      expect(result).toEqual({ startDate: '2024-01-01', endDate: '2024-12-31' });
    });

    it('returns empty strings for unknown period', () => {
      const result = resolveTimePeriod('unknown' as TimePeriod);
      expect(result).toEqual({ startDate: '', endDate: '' });
    });
  });
});
