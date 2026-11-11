import {
  eachDayOfInterval,
  endOfMonth,
  format,
  getDay,
  isSameMonth,
  isToday as checkIsToday,
  startOfMonth,
  addMonths,
  subMonths,
} from 'date-fns';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import { advanceSchedule, isOneTime } from '@/lib/frequency';

/**
 * Laying scheduled occurrences out on a month grid.
 *
 * One implementation for the Bills & Deposits calendar and the Upcoming Bills
 * widget, so the two cannot disagree about which day a schedule falls on or
 * which occurrences a month contains.
 */

/** A single cell of the month grid. */
export interface ScheduledCalendarDay {
  date: Date;
  /** False for the leading/trailing days borrowed from the adjacent months. */
  isCurrentMonth: boolean;
  isToday: boolean;
  /** Every schedule occurring on this day, in the order they were handed in. */
  bills: ScheduledTransaction[];
}

/** Guards against a frequency that never advances; no month holds this many. */
const MAX_OCCURRENCES_PER_SCHEDULE = 100;

/**
 * Every date this schedule falls on between `start` and `end`, inclusive.
 *
 * Occurrence dates are the schedule's own sequence with its overrides applied:
 * a moved occurrence appears on the day it was moved to and not on the day it
 * was generated for. A one-time schedule stops after its single date.
 */
export function occurrencesInWindow(
  st: ScheduledTransaction,
  start: Date,
  end: Date,
): Date[] {
  if (!st.nextDueDate) return [];
  const occurrences: Date[] = [];
  let nextDate = parseLocalDate(st.nextDueDate);

  // originalDate -> overrideDate, so a moved occurrence lands on its new day.
  const overrideMap = new Map<string, string>();
  for (const o of st.futureOverrides ?? []) {
    overrideMap.set(o.originalDate.split('T')[0], o.overrideDate.split('T')[0]);
  }
  // Fall back to nextOverride when futureOverrides is not populated.
  if (st.nextOverride?.overrideDate && !overrideMap.has(st.nextDueDate)) {
    overrideMap.set(st.nextDueDate, st.nextOverride.overrideDate);
  }

  let count = 0;
  while (nextDate <= end && count < MAX_OCCURRENCES_PER_SCHEDULE) {
    const dateKey = format(nextDate, 'yyyy-MM-dd');
    const overrideDateStr = overrideMap.get(dateKey);
    const effectiveDate =
      overrideDateStr && overrideDateStr !== dateKey
        ? parseLocalDate(overrideDateStr)
        : nextDate;

    if (effectiveDate >= start && effectiveDate <= end) {
      occurrences.push(new Date(effectiveDate));
    }
    if (isOneTime(st.frequency)) return occurrences;
    nextDate = advanceSchedule(nextDate, st);
    count++;
  }
  return occurrences;
}

/**
 * The month grid for `calendarMonth`: whole weeks, Sunday to Saturday, with the
 * occurrences of every active schedule placed on their days.
 *
 * Every active schedule is on the calendar whatever its kind: transfers and
 * zero-amount reminders have due dates like anything else, and leaving them off
 * makes a schedule the list shows simply vanish (issue #1124).
 */
export function buildScheduledCalendarDays(
  scheduledTransactions: ScheduledTransaction[],
  calendarMonth: Date,
): ScheduledCalendarDay[] {
  const monthStart = startOfMonth(calendarMonth);
  const monthEnd = endOfMonth(calendarMonth);
  const calStart = new Date(monthStart);
  calStart.setDate(calStart.getDate() - getDay(monthStart));
  const calEnd = new Date(monthEnd);
  calEnd.setDate(calEnd.getDate() + (6 - getDay(monthEnd)));

  // A month of context on each side, so an occurrence generated just outside the
  // grid but moved into it by an override is still found.
  const scanStart = subMonths(monthStart, 1);
  const scanEnd = addMonths(monthEnd, 1);

  const billsByDate = new Map<string, ScheduledTransaction[]>();
  for (const st of scheduledTransactions) {
    if (!st.isActive) continue;
    for (const date of occurrencesInWindow(st, scanStart, scanEnd)) {
      const key = format(date, 'yyyy-MM-dd');
      const existing = billsByDate.get(key);
      if (existing) existing.push(st);
      else billsByDate.set(key, [st]);
    }
  }

  return eachDayOfInterval({ start: calStart, end: calEnd }).map((date) => ({
    date,
    isCurrentMonth: isSameMonth(date, calendarMonth),
    isToday: checkIsToday(date),
    bills: billsByDate.get(format(date, 'yyyy-MM-dd')) ?? [],
  }));
}
