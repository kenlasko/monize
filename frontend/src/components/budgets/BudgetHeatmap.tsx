'use client';

import { useMemo, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import {
  eachDayOfInterval,
  getDay,
  format,
  isSameDay,
} from 'date-fns';

interface DailySpending {
  date: string;
  amount: number;
}

interface BudgetHeatmapProps {
  dailySpending: DailySpending[];
  periodStart: string;
  periodEnd: string;
  formatCurrency: (amount: number) => string;
}

function getHeatColor(amount: number, maxAmount: number): string {
  // A refund day is negative: it is not heat.
  if (amount <= 0 || maxAmount <= 0) return 'bg-gray-100 dark:bg-gray-700';
  const intensity = amount / maxAmount;
  if (intensity > 0.75) return 'bg-red-400 dark:bg-red-500';
  if (intensity > 0.5) return 'bg-orange-300 dark:bg-orange-400';
  if (intensity > 0.25) return 'bg-yellow-300 dark:bg-yellow-400';
  return 'bg-green-200 dark:bg-green-600';
}

export function BudgetHeatmap({
  dailySpending,
  periodStart,
  periodEnd,
  formatCurrency,
}: BudgetHeatmapProps) {
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  const formatChartDate = useChartDateFormat();
  // Grid is Monday-first (see getDay conversion below); the catalog array is
  // Sunday-first, so rotate Sunday to the end.
  const narrowDays = tc.raw('weekdaysNarrow') as string[];
  const WEEKDAY_LABELS = [...narrowDays.slice(1), narrowDays[0]];

  const { days, maxAmount, spendingMap, peakDate, monthLabel } = useMemo(() => {
    const start = new Date(periodStart + 'T00:00:00');
    const end = new Date(periodEnd + 'T00:00:00');
    const allDays = eachDayOfInterval({ start, end });

    const map = new Map<string, number>();
    for (const entry of dailySpending) {
      map.set(entry.date, entry.amount);
    }

    let max = 0;
    let peak: string | null = null;
    for (const [date, amount] of map.entries()) {
      if (amount > max) {
        max = amount;
        peak = date;
      }
    }

    return {
      days: allDays,
      maxAmount: max,
      spendingMap: map,
      peakDate: peak,
      // The month heading in the reader's language, never a fixed pattern.
      monthLabel: formatChartDate(periodStart, 'MMMM yyyy'),
    };
  }, [dailySpending, periodStart, periodEnd, formatChartDate]);

  // Build weekly grid: rows = weeks, cols = days of week (Monday=0)
  const weeks = useMemo(() => {
    const result: Array<Array<{ date: Date; amount: number } | null>> = [];
    let currentWeek: Array<{ date: Date; amount: number } | null> = new Array(
      7,
    ).fill(null);

    for (const day of days) {
      // getDay: 0=Sunday, 1=Monday, etc. Convert to Monday=0
      const dayOfWeek = (getDay(day) + 6) % 7;

      if (dayOfWeek === 0 && currentWeek.some((d) => d !== null)) {
        result.push(currentWeek);
        currentWeek = new Array(7).fill(null);
      }

      const dateStr = format(day, 'yyyy-MM-dd');
      currentWeek[dayOfWeek] = {
        date: day,
        amount: spendingMap.get(dateStr) || 0,
      };
    }

    if (currentWeek.some((d) => d !== null)) {
      result.push(currentWeek);
    }

    return result;
  }, [days, spendingMap]);

  const t = useTranslations('budgets');
  const router = useRouter();
  const today = new Date();

  // The day whose figure the readout under the grid names. A day's amount
  // used to live only in a hover-only `title`, which a phone and a keyboard
  // never reach; pointing at or focusing a day names it here, and until one
  // is chosen the readout shows the period's busiest day.
  const [chosenDate, setChosenDate] = useState<string | null>(null);
  const dayKeys = useMemo(() => new Set(days.map((d) => format(d, 'yyyy-MM-dd'))), [days]);
  const readoutDate = chosenDate !== null && dayKeys.has(chosenDate) ? chosenDate : peakDate;
  const dayReadout = (date: string) =>
    t('heatmap.readout', {
      date: formatDate(date),
      amount: formatCurrency(spendingMap.get(date) ?? 0),
    });

  const handleDateClick = useCallback((date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    // Set active accounts filter before navigating
    localStorage.setItem('transactions.filter.accountStatus', JSON.stringify('active'));
    router.push(`/transactions?startDate=${dateStr}&endDate=${dateStr}`);
  }, [router]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('heatmap.title', { monthLabel })}
      </h2>
      <div className="overflow-x-auto">
        <table className="mx-auto" role="grid" aria-label={t('heatmap.ariaLabel')}>
          <thead>
            <tr>
              {WEEKDAY_LABELS.map((label, i) => (
                <th
                  key={i}
                  className="text-xs text-gray-500 dark:text-gray-400 font-normal px-1 pb-1 w-9 text-center"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIdx) => (
              <tr key={weekIdx}>
                {week.map((day, dayIdx) => {
                  if (!day) {
                    return (
                      <td key={dayIdx} className="p-0.5">
                        <div className="w-8 h-8" />
                      </td>
                    );
                  }

                  const isToday = isSameDay(day.date, today);
                  const color = getHeatColor(day.amount, maxAmount);
                  const dateKey = format(day.date, 'yyyy-MM-dd');

                  return (
                    <td key={dayIdx} className="p-0.5">
                      {/* A button, so the keyboard reaches the day; its figure
                          is the readout below and its accessible name. */}
                      <button
                        type="button"
                        className={`w-8 h-8 rounded-sm flex items-center justify-center text-xs cursor-pointer hover:ring-2 hover:ring-blue-400 transition-shadow motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${color} ${
                          isToday ? 'ring-2 ring-blue-500' : ''
                        }`}
                        aria-label={dayReadout(dateKey)}
                        data-testid={`heatmap-cell-${dateKey}`}
                        onClick={() => handleDateClick(day.date)}
                        onFocus={() => setChosenDate(dateKey)}
                        onMouseEnter={() => setChosenDate(dateKey)}
                      >
                        {format(day.date, 'd')}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {readoutDate !== null && (
        <p
          aria-live="polite"
          data-testid="heatmap-readout"
          className="mt-3 text-center text-sm text-gray-700 dark:text-gray-300"
        >
          {dayReadout(readoutDate)}
        </p>
      )}
      <div className="flex items-center justify-center gap-2 mt-3 text-xs text-gray-500 dark:text-gray-400">
        <span>{t('heatmap.less')}</span>
        <div className="w-4 h-4 rounded-sm bg-gray-100 dark:bg-gray-700" />
        <div className="w-4 h-4 rounded-sm bg-green-200 dark:bg-green-600" />
        <div className="w-4 h-4 rounded-sm bg-yellow-300 dark:bg-yellow-400" />
        <div className="w-4 h-4 rounded-sm bg-orange-300 dark:bg-orange-400" />
        <div className="w-4 h-4 rounded-sm bg-red-400 dark:bg-red-500" />
        <span>{t('heatmap.more')}</span>
      </div>
    </div>
  );
}
