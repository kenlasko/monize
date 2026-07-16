import {
  format,
  startOfWeek,
  endOfWeek,
  subWeeks,
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfYear,
  endOfYear,
  subYears,
  subDays,
} from 'date-fns';

export type TimePeriod =
  | 'all_dates'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'last_30_days'
  | 'month_to_date'
  | 'last_month'
  | 'last_365_days'
  | 'year_to_date'
  | 'last_year'
  | 'custom';

export const TIME_PERIOD_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: '', labelKey: 'filter.periods.select' },
  { value: 'all_dates', labelKey: 'filter.periods.allDates' },
  { value: 'today', labelKey: 'filter.periods.today' },
  { value: 'yesterday', labelKey: 'filter.periods.yesterday' },
  { value: 'this_week', labelKey: 'filter.periods.thisWeek' },
  { value: 'last_week', labelKey: 'filter.periods.lastWeek' },
  { value: 'last_30_days', labelKey: 'filter.periods.last30Days' },
  { value: 'month_to_date', labelKey: 'filter.periods.monthToDate' },
  { value: 'last_month', labelKey: 'filter.periods.lastMonth' },
  { value: 'last_365_days', labelKey: 'filter.periods.last365Days' },
  { value: 'year_to_date', labelKey: 'filter.periods.yearToDate' },
  { value: 'last_year', labelKey: 'filter.periods.lastYear' },
  { value: 'custom', labelKey: 'filter.periods.custom' },
];

export function resolveTimePeriod(
  period: TimePeriod,
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 1
): { startDate: string; endDate: string } {
  const today = new Date();
  const fmt = (d: Date) => format(d, 'yyyy-MM-dd');

  switch (period) {
    case 'all_dates':
      // Removes the date constraint entirely -- empty bounds mean the
      // transaction query applies no start/end date filter.
      return { startDate: '', endDate: '' };

    case 'today':
      return { startDate: fmt(today), endDate: fmt(today) };

    case 'yesterday': {
      const yesterday = subDays(today, 1);
      return { startDate: fmt(yesterday), endDate: fmt(yesterday) };
    }

    case 'this_week':
      return {
        startDate: fmt(startOfWeek(today, { weekStartsOn })),
        endDate: fmt(today),
      };

    case 'last_week': {
      const lastWeekDate = subWeeks(today, 1);
      return {
        startDate: fmt(startOfWeek(lastWeekDate, { weekStartsOn })),
        endDate: fmt(endOfWeek(lastWeekDate, { weekStartsOn })),
      };
    }

    case 'last_30_days':
      // Rolling window: the 30 days up to and including today.
      return { startDate: fmt(subDays(today, 30)), endDate: fmt(today) };

    case 'month_to_date':
      return {
        startDate: fmt(startOfMonth(today)),
        endDate: fmt(today),
      };

    case 'last_month': {
      const lastMonthDate = subMonths(today, 1);
      return {
        startDate: fmt(startOfMonth(lastMonthDate)),
        endDate: fmt(endOfMonth(lastMonthDate)),
      };
    }

    case 'last_365_days':
      // Rolling window: the 365 days up to and including today.
      return { startDate: fmt(subDays(today, 365)), endDate: fmt(today) };

    case 'year_to_date':
      return {
        startDate: fmt(startOfYear(today)),
        endDate: fmt(today),
      };

    case 'last_year': {
      const lastYearDate = subYears(today, 1);
      return {
        startDate: fmt(startOfYear(lastYearDate)),
        endDate: fmt(endOfYear(lastYearDate)),
      };
    }

    case 'custom':
      return { startDate: '', endDate: '' };

    default:
      return { startDate: '', endDate: '' };
  }
}
