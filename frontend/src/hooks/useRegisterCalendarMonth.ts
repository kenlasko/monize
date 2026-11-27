'use client';

import { useCallback, useMemo, useState } from 'react';
import { monthDateRange, monthForDateRange } from '@/lib/calendar-month';

interface RegisterCalendarMonth {
  /** The month the calendar shows. */
  month: string;
  /** The reader turned the calendar to `month`. */
  setMonth: (month: string) => void;
  /**
   * The reader is switching back to the table: the date range the register
   * takes from the calendar, or `null` when the calendar was not turned away
   * from the month the register's range opened it on, so the range stays.
   */
  leaveCalendar: () => { startDate: string; endDate: string } | null;
}

/**
 * The Transactions calendar's month, kept in step with the register's date
 * range in both directions.
 *
 * The calendar opens on the month the range points at (`monthForDateRange`),
 * and a month the reader turns to becomes the range when they go back to the
 * table, so switching back and forth stays on one period. While the reader has
 * not turned the calendar, it follows the range: a range that changes under it
 * (a month bar clicked in the chart, Clear filters) moves it, and so does the
 * range arriving from the URL or storage after the first render.
 */
export function useRegisterCalendarMonth(
  startDate: string,
  endDate: string,
  today: string,
): RegisterCalendarMonth {
  const openingMonth = useMemo(
    () => monthForDateRange(startDate, endDate, today),
    [startDate, endDate, today],
  );
  const [turnedTo, setTurnedTo] = useState<string | null>(null);

  // A new range is a new place to open on: the month turned to under the old
  // one is dropped rather than left to overwrite the range the reader just set.
  const rangeKey = `${startDate}|${endDate}`;
  const [seenRangeKey, setSeenRangeKey] = useState(rangeKey);
  if (seenRangeKey !== rangeKey) {
    setSeenRangeKey(rangeKey);
    setTurnedTo(null);
  }

  const leaveCalendar = useCallback(() => {
    setTurnedTo(null);
    return turnedTo !== null && turnedTo !== openingMonth ? monthDateRange(turnedTo) : null;
  }, [turnedTo, openingMonth]);

  return { month: turnedTo ?? openingMonth, setMonth: setTurnedTo, leaveCalendar };
}
