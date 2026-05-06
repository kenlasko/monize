import { useState, useCallback, useMemo } from 'react';
import { format, subMonths, subDays, subYears, subWeeks, startOfMonth, endOfMonth } from 'date-fns';

interface UseDateRangeOptions {
  /** Which preset is selected by default. */
  defaultRange: string;
  /** Whether date boundaries snap to start/end of month. Default: 'day'. */
  alignment?: 'day' | 'month';
}

interface UseDateRangeReturn {
  /** Currently selected preset (including 'custom'). */
  dateRange: string;
  /** Set the active preset. */
  setDateRange: (range: string) => void;
  /** Custom start date (YYYY-MM-DD). Only relevant when dateRange === 'custom'. */
  startDate: string;
  /** Set custom start date. */
  setStartDate: (date: string) => void;
  /** Custom end date (YYYY-MM-DD). Only relevant when dateRange === 'custom'. */
  endDate: string;
  /** Set custom end date. */
  setEndDate: (date: string) => void;
  /** Resolved {start, end} for the current selection. Memoized. */
  resolvedRange: { start: string; end: string };
  /** Whether the current selection is usable (custom requires both dates). */
  isValid: boolean;
}

export function useDateRange(options: UseDateRangeOptions): UseDateRangeReturn {
  const { defaultRange, alignment = 'day' } = options;
  const [dateRange, setDateRange] = useState<string>(defaultRange);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const resolveRange = useCallback(
    (range: string): { start: string; end: string } => {
      if (range === 'custom') {
        return { start: startDate, end: endDate };
      }

      const now = new Date();
      const isMonth = alignment === 'month';
      // Short-range presets always use today as end date (day-level precision).
      // Long-range presets with month alignment snap to end of month.
      const useDayLevel = ['1d', '1w', '1m', '3m', 'ytd', '1y'].includes(range);
      const end = isMonth && !useDayLevel
        ? format(endOfMonth(now), 'yyyy-MM-dd')
        : format(now, 'yyyy-MM-dd');

      let start: string;

      switch (range) {
        case '1d':
          // '1d' is an intraday-only preset; resolvedRange is consumed only
          // when the chart falls back to the daily-snapshot endpoint. A
          // single day's snapshot is just one point, so widen to a week so
          // the fallback chart is still readable.
          start = format(subWeeks(now, 1), 'yyyy-MM-dd');
          break;
        case '1w':
          start = format(subWeeks(now, 1), 'yyyy-MM-dd');
          break;
        case '1m':
          start = format(subDays(now, 30), 'yyyy-MM-dd');
          break;
        case '3m':
          start = format(subDays(now, 90), 'yyyy-MM-dd');
          break;
        case '6m':
          start = isMonth
            ? format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd')
            : format(subMonths(now, 6), 'yyyy-MM-dd');
          break;
        case '1y':
          start = format(subYears(now, 1), 'yyyy-MM-dd');
          break;
        case '2y':
          start = isMonth
            ? format(startOfMonth(subMonths(now, 23)), 'yyyy-MM-dd')
            : format(subYears(now, 2), 'yyyy-MM-dd');
          break;
        case '5y':
          start = isMonth
            ? format(startOfMonth(subMonths(now, 59)), 'yyyy-MM-dd')
            : format(subYears(now, 5), 'yyyy-MM-dd');
          break;
        case 'ytd':
          start = `${now.getFullYear()}-01-01`;
          break;
        case 'all':
          start = '';
          break;
        default:
          start = format(subMonths(now, 3), 'yyyy-MM-dd');
      }

      return { start, end };
    },
    [alignment, startDate, endDate]
  );

  const resolvedRange = useMemo(
    () => resolveRange(dateRange),
    [dateRange, resolveRange]
  );

  const isValid = dateRange !== 'custom' || (startDate !== '' && endDate !== '');

  return {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  };
}
