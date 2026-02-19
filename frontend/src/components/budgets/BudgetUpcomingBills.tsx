'use client';

import { useMemo } from 'react';
import { differenceInDays, startOfDay, parseISO } from 'date-fns';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

interface BudgetUpcomingBillsProps {
  scheduledTransactions: ScheduledTransaction[];
  currentSpent: number;
  totalBudgeted: number;
  periodEnd: string;
  formatCurrency: (amount: number) => string;
}

export function BudgetUpcomingBills({
  scheduledTransactions,
  currentSpent,
  totalBudgeted,
  periodEnd,
  formatCurrency,
}: BudgetUpcomingBillsProps) {
  const today = startOfDay(new Date());
  const endDate = parseISO(periodEnd);

  const upcomingBills = useMemo(() => {
    return scheduledTransactions
      .filter((st) => {
        if (!st.isActive) return false;
        if (st.amount >= 0) return false; // only bills (negative amounts)
        const dueDate = parseISO(st.nextDueDate);
        const daysUntil = differenceInDays(dueDate, today);
        const daysUntilEnd = differenceInDays(endDate, dueDate);
        return daysUntil >= 0 && daysUntilEnd >= 0;
      })
      .sort(
        (a, b) =>
          parseISO(a.nextDueDate).getTime() - parseISO(b.nextDueDate).getTime(),
      );
  }, [scheduledTransactions, today, endDate]);

  const totalUpcoming = useMemo(
    () => upcomingBills.reduce((sum, bill) => sum + Math.abs(bill.amount), 0),
    [upcomingBills],
  );

  const trulyAvailable = totalBudgeted - currentSpent - totalUpcoming;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Upcoming Bills
      </h2>
      {upcomingBills.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No bills due this period.
        </p>
      ) : (
        <div className="space-y-2">
          {upcomingBills.slice(0, 5).map((bill) => (
            <div
              key={bill.id}
              className="flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-gray-900 dark:text-gray-100 truncate">
                  {bill.name}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  {bill.nextDueDate}
                </span>
              </div>
              <span className="font-medium text-red-600 dark:text-red-400 ml-2 whitespace-nowrap">
                {formatCurrency(Math.abs(bill.amount))}
              </span>
            </div>
          ))}
          {upcomingBills.length > 5 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              +{upcomingBills.length - 5} more bills
            </p>
          )}
        </div>
      )}
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">Total upcoming</span>
          <span className="font-semibold text-red-600 dark:text-red-400">
            {formatCurrency(totalUpcoming)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">Truly available</span>
          <span
            className={`font-semibold ${
              trulyAvailable >= 0
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {formatCurrency(Math.abs(trulyAvailable))}
            {trulyAvailable < 0 && ' over'}
          </span>
        </div>
      </div>
    </div>
  );
}
