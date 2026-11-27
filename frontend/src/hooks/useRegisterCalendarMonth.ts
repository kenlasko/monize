'use client';

import { useCallback, useMemo, useState } from 'react';
import { earliestMonthOf, monthForDateRange } from '@/lib/calendar-month';
import { rowDate } from '@/lib/calendar-rows';

/** What the hook reads of a register row: which one it is and its day (a date or a timestamp). */
export interface RegisterPageRow {
  id: string;
  transactionDate: string;
}

interface RegisterCalendarMonth {
  /** The month the calendar shows. */
  month: string;
  /** The reader turned the calendar to `month`. */
  setMonth: (month: string) => void;
  /**
   * The reader is switching back to the table: the month whose page the
   * register should turn to, or `null` when the calendar was not turned away
   * from the month it opened on, so the register stays on its page.
   */
  leaveCalendar: () => string | null;
  /**
   * The register was sent to the page holding `transactionId`, the first row
   * of `month`: while that row is on the page, the calendar reopens on `month`
   * rather than on an older month the same page also reaches into.
   */
  landedOn: (month: string, transactionId: string) => void;
}

/**
 * The Transactions calendar's month, kept in step with the register's page in
 * both directions (issue #2475).
 *
 * The calendar opens on the earliest month any row on the register's page
 * falls in (`earliestMonthOf`), or, for a page with no rows, on the month the
 * date range points at (`monthForDateRange`). A month the reader turns to is
 * handed back on the way to the table, where the page finds the page holding
 * that month's first row; no date filter is written. While the reader has not
 * turned the calendar it follows the page, and a date range that changes under
 * it (a month bar clicked in the chart, Clear filters) drops the month it had
 * been turned to.
 */
export function useRegisterCalendarMonth(
  pageRows: readonly RegisterPageRow[],
  startDate: string,
  endDate: string,
  today: string,
): RegisterCalendarMonth {
  const [landing, setLanding] = useState<{ month: string; transactionId: string } | null>(null);

  const openingMonth = useMemo(() => {
    if (landing !== null && pageRows.some((row) => row.id === landing.transactionId)) {
      return landing.month;
    }
    return (
      earliestMonthOf(pageRows.map((row) => rowDate(row.transactionDate))) ??
      monthForDateRange(startDate, endDate, today)
    );
  }, [landing, pageRows, startDate, endDate, today]);
  const [turnedTo, setTurnedTo] = useState<string | null>(null);

  // A new range is a new place to open on: the month turned to under the old
  // one is dropped rather than left to move the register off the range the
  // reader just set.
  const rangeKey = `${startDate}|${endDate}`;
  const [seenRangeKey, setSeenRangeKey] = useState(rangeKey);
  if (seenRangeKey !== rangeKey) {
    setSeenRangeKey(rangeKey);
    setTurnedTo(null);
  }

  const leaveCalendar = useCallback(() => {
    setTurnedTo(null);
    return turnedTo !== null && turnedTo !== openingMonth ? turnedTo : null;
  }, [turnedTo, openingMonth]);

  const landedOn = useCallback((month: string, transactionId: string) => {
    setLanding({ month, transactionId });
  }, []);

  return { month: turnedTo ?? openingMonth, setMonth: setTurnedTo, leaveCalendar, landedOn };
}
