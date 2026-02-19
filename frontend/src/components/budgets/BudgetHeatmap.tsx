'use client';

import { useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
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

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function getHeatColor(amount: number, maxAmount: number): string {
  if (amount === 0 || maxAmount === 0) return 'bg-gray-100 dark:bg-gray-700';
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
  const { days, maxAmount, spendingMap, monthLabel } = useMemo(() => {
    const start = new Date(periodStart + 'T00:00:00');
    const end = new Date(periodEnd + 'T00:00:00');
    const allDays = eachDayOfInterval({ start, end });

    const map = new Map<string, number>();
    for (const entry of dailySpending) {
      map.set(entry.date, entry.amount);
    }

    let max = 0;
    for (const amount of map.values()) {
      if (amount > max) max = amount;
    }

    return {
      days: allDays,
      maxAmount: max,
      spendingMap: map,
      monthLabel: format(start, 'MMMM yyyy'),
    };
  }, [dailySpending, periodStart, periodEnd]);

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

  const router = useRouter();
  const today = new Date();

  const handleDateClick = useCallback((date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    // Set active accounts filter before navigating
    localStorage.setItem('transactions.filter.accountStatus', JSON.stringify('active'));
    router.push(`/transactions?startDate=${dateStr}&endDate=${dateStr}`);
  }, [router]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Spending Heatmap - {monthLabel}
      </h2>
      <div className="overflow-x-auto">
        <table className="mx-auto" role="grid" aria-label="Spending heatmap">
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
                  const dateLabel = format(day.date, 'MMM d');

                  return (
                    <td key={dayIdx} className="p-0.5">
                      <div
                        className={`w-8 h-8 rounded-sm flex items-center justify-center text-xs cursor-pointer hover:ring-2 hover:ring-blue-400 transition-shadow ${color} ${
                          isToday ? 'ring-2 ring-blue-500' : ''
                        }`}
                        title={`${dateLabel}: ${formatCurrency(day.amount)}`}
                        data-testid={`heatmap-cell-${format(day.date, 'yyyy-MM-dd')}`}
                        onClick={() => handleDateClick(day.date)}
                        role="link"
                      >
                        {format(day.date, 'd')}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-center gap-2 mt-3 text-xs text-gray-500 dark:text-gray-400">
        <span>Less</span>
        <div className="w-4 h-4 rounded-sm bg-gray-100 dark:bg-gray-700" />
        <div className="w-4 h-4 rounded-sm bg-green-200 dark:bg-green-600" />
        <div className="w-4 h-4 rounded-sm bg-yellow-300 dark:bg-yellow-400" />
        <div className="w-4 h-4 rounded-sm bg-orange-300 dark:bg-orange-400" />
        <div className="w-4 h-4 rounded-sm bg-red-400 dark:bg-red-500" />
        <span>More</span>
      </div>
    </div>
  );
}
