'use client';

import { useRouter } from 'next/navigation';
import { differenceInDays, isToday, isTomorrow, startOfDay } from 'date-fns';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface UpcomingBillsProps {
  scheduledTransactions: ScheduledTransaction[];
  isLoading: boolean;
}

export function UpcomingBills({ scheduledTransactions, isLoading }: UpcomingBillsProps) {
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const { formatCurrency: formatCurrencyBase } = useNumberFormat();

  // Filter to only bills (negative amounts) in the next 7 days
  const today = startOfDay(new Date());
  const upcomingBills = scheduledTransactions
    .filter((st) => {
      if (!st.isActive || st.amount >= 0) return false;
      const dueDate = parseLocalDate(st.nextDueDate);
      const daysUntil = differenceInDays(dueDate, today);
      return daysUntil >= 0 && daysUntil <= 7;
    })
    .sort((a, b) => parseLocalDate(a.nextDueDate).getTime() - parseLocalDate(b.nextDueDate).getTime());

  const formatCurrency = (amount: number, currency: string) => {
    return formatCurrencyBase(Math.abs(amount), currency);
  };

  const getDueDateLabel = (dateStr: string) => {
    const date = parseLocalDate(dateStr);
    if (isToday(date)) return 'Today';
    if (isTomorrow(date)) return 'Tomorrow';
    const days = differenceInDays(date, today);
    if (days <= 7) return `${days} days`;
    return formatDate(dateStr);
  };

  const getDueDateColour = (dateStr: string) => {
    const date = parseLocalDate(dateStr);
    const days = differenceInDays(date, today);
    if (days <= 0) return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30';
    if (days <= 2) return 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30';
    return 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30';
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <button
          onClick={() => router.push('/bills')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          Upcoming Bills
        </button>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (upcomingBills.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <button
          onClick={() => router.push('/bills')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          Upcoming Bills
        </button>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No bills due in the next 7 days.
        </p>
      </div>
    );
  }

  const totalDue = upcomingBills.reduce((sum, bill) => sum + Math.abs(bill.amount), 0);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => router.push('/bills')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          Upcoming Bills
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400">Next 7 days</span>
      </div>
      <div className="space-y-3">
        {upcomingBills.map((bill) => (
          <div
            key={bill.id}
            className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <div className="flex items-center gap-3">
              <span
                className={`px-2 py-1 text-xs font-medium rounded ${getDueDateColour(
                  bill.nextDueDate
                )}`}
              >
                {getDueDateLabel(bill.nextDueDate)}
              </span>
              <div>
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {bill.name}
                </div>
                {(bill.payeeName || bill.payee?.name) && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {bill.payeeName || bill.payee?.name}
                  </div>
                )}
              </div>
            </div>
            <div className="font-semibold text-red-600 dark:text-red-400">
              -{formatCurrency(bill.amount, bill.currencyCode)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <span className="text-sm text-gray-600 dark:text-gray-400">Total due</span>
        <span className="font-semibold text-red-600 dark:text-red-400">
          -${totalDue.toLocaleString('en-CA', { minimumFractionDigits: 2 })}
        </span>
      </div>
      <button
        onClick={() => router.push('/bills')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        View all bills
      </button>
    </div>
  );
}
