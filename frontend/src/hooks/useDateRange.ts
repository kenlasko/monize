import { useState, useCallback, useMemo, useEffect } from 'react';
import { resolveRangePreset } from '@/lib/date-range';
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
    (range: string): { start: string; end: string } =>
      resolveRangePreset(range, { alignment, startDate, endDate }),
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
