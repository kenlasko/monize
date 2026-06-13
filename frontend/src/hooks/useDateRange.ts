import { useState, useCallback, useMemo, useEffect } from 'react';
import { format, subMonths, subDays, subYears, subWeeks, startOfMonth } from 'date-fns';
import { createLogger } from '@/lib/logger';

const logger = createLogger('useDateRange');

interface UseDateRangeOptions {
  /** Which preset is selected by default. */
  defaultRange: string;
  /** Whether date boundaries snap to start/end of month. Default: 'day'. */
  alignment?: 'day' | 'month';
  /**
   * When provided, the selected preset plus custom start/end dates are
   * persisted to localStorage under this key and restored on mount, so the
   * selection survives leaving and returning to the screen.
   */
  storageKey?: string;
}

interface PersistedRange {
  dateRange?: string;
  startDate?: string;
  endDate?: string;
}

function readPersistedRange(storageKey?: string): PersistedRange | null {
  if (!storageKey || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as PersistedRange) : null;
  } catch (error) {
    logger.warn(`Error reading localStorage key "${storageKey}":`, error);
    return null;
  }
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
  const { defaultRange, alignment = 'day', storageKey } = options;
  const [dateRange, setDateRange] = useState<string>(
    () => readPersistedRange(storageKey)?.dateRange ?? defaultRange,
  );
  const [startDate, setStartDate] = useState(
    () => readPersistedRange(storageKey)?.startDate ?? '',
  );
  const [endDate, setEndDate] = useState(
    () => readPersistedRange(storageKey)?.endDate ?? '',
  );

  // Persist the selection whenever it changes (no-op without a storageKey).
  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ dateRange, startDate, endDate }),
      );
    } catch (error) {
      logger.warn(`Error setting localStorage key "${storageKey}":`, error);
    }
  }, [storageKey, dateRange, startDate, endDate]);

  const resolveRange = useCallback(
    (range: string): { start: string; end: string } => {
      if (range === 'custom') {
        return { start: startDate, end: endDate };
      }

      const now = new Date();
      const isMonth = alignment === 'month';
      // End date is always today: data only exists up to today, so snapping
      // the end to end-of-month (the previous behaviour for long-range
      // month-aligned presets like 2y/5y) just produced a flat-line tail
      // from today through the rest of the month. Month alignment now
      // affects the start date only.
      const end = format(now, 'yyyy-MM-dd');

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
        case 'mtd':
          start = format(startOfMonth(now), 'yyyy-MM-dd');
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
          // Rolling 2 years = last 730 days. Same shape regardless of
          // alignment: month alignment on the start was producing partial
          // history at the leading edge (e.g. mid-month -> chart only
          // showed 23.5 months back).
          start = format(subDays(now, 730), 'yyyy-MM-dd');
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
          start = '1970-01-01';
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
