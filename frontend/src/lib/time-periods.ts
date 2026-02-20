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
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'month_to_date'
  | 'last_month'
  | 'year_to_date'
  | 'last_year'
  | 'custom';

export const TIME_PERIOD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Select period...' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This Week' },
  { value: 'last_week', label: 'Last Week' },
  { value: 'month_to_date', label: 'Month to Date' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'year_to_date', label: 'Year to Date' },
  { value: 'last_year', label: 'Last Year' },
  { value: 'custom', label: 'Custom' },
];

export function resolveTimePeriod(
  period: TimePeriod,
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 1
): { startDate: string; endDate: string } {
  const today = new Date();
  const fmt = (d: Date) => format(d, 'yyyy-MM-dd');

  switch (period) {
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
