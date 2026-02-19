'use client';

import { useRouter } from 'next/navigation';
import { differenceInDays, isToday, isTomorrow, startOfDay } from 'date-fns';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';

interface UpcomingBillsProps {
  scheduledTransactions: ScheduledTransaction[];
  isLoading: boolean;
}

export function UpcomingBills({ scheduledTransactions, isLoading }: UpcomingBillsProps) {
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const { formatCurrency: formatCurrencyBase } = useNumberFormat();
  const { convertToDefault } = useExchangeRates();

  // Filter to active bills, deposits, and transfers in the next 7 days
  const today = startOfDay(new Date());
  const upcomingItems = scheduledTransactions
    .filter((st) => {
      if (!st.isActive) return false;
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

  const getEffectiveAmount = (item: ScheduledTransaction): number => {
    return item.nextOverride?.amount ?? item.amount;
  };

  const getItemType = (item: ScheduledTransaction): 'bill' | 'deposit' | 'transfer' => {
    if (item.isTransfer) return 'transfer';
    return getEffectiveAmount(item) < 0 ? 'bill' : 'deposit';
  };

  const getTypeBadge = (type: 'bill' | 'deposit' | 'transfer') => {
    switch (type) {
      case 'bill':
        return <span className="px-1.5 py-0.5 bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 text-xs rounded font-medium">Bill</span>;
      case 'deposit':
        return <span className="px-1.5 py-0.5 bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400 text-xs rounded font-medium">Deposit</span>;
      case 'transfer':
        return <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 text-xs rounded font-medium">Transfer</span>;
    }
  };

  const getAmountDisplay = (item: ScheduledTransaction) => {
    const amount = getEffectiveAmount(item);
    const type = getItemType(item);
    switch (type) {
      case 'bill':
        return {
          text: `-${formatCurrency(amount, item.currencyCode)}`,
          className: 'text-red-600 dark:text-red-400',
        };
      case 'deposit':
        return {
          text: `+${formatCurrency(amount, item.currencyCode)}`,
          className: 'text-green-600 dark:text-green-400',
        };
      case 'transfer':
        return {
          text: formatCurrency(amount, item.currencyCode),
          className: 'text-blue-600 dark:text-blue-400',
        };
    }
  };

  const sectionTitle = 'Upcoming Bills & Deposits';

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <button
          onClick={() => router.push('/bills')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          {sectionTitle}
        </button>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (upcomingItems.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <button
          onClick={() => router.push('/bills')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          {sectionTitle}
        </button>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No bills, deposits, or transfers due in the next 7 days.
        </p>
      </div>
    );
  }

  const totalDue = upcomingItems
    .filter((item) => !item.isTransfer && getEffectiveAmount(item) < 0)
    .reduce((sum, item) => sum + Math.abs(convertToDefault(getEffectiveAmount(item), item.currencyCode)), 0);
  const totalIncoming = upcomingItems
    .filter((item) => !item.isTransfer && getEffectiveAmount(item) > 0)
    .reduce((sum, item) => sum + convertToDefault(getEffectiveAmount(item), item.currencyCode), 0);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => router.push('/bills')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {sectionTitle}
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400">Next 7 days</span>
      </div>
      <div className="space-y-2 sm:space-y-3">
        {upcomingItems.map((item) => {
          const amountDisplay = getAmountDisplay(item);
          const type = getItemType(item);
          return (
            <div
              key={item.id}
              className="flex items-center justify-between p-2 sm:p-3 rounded-lg border border-gray-200 dark:border-gray-700"
            >
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <span
                  className={`px-2 py-1 text-xs font-medium rounded ${getDueDateColour(
                    item.nextDueDate
                  )}`}
                >
                  {getDueDateLabel(item.nextDueDate)}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
                      {item.name}
                    </span>
                    {getTypeBadge(type)}
                    {!item.autoPost && (
                      <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 text-xs rounded" title="Requires manual posting">
                        Manual
                      </span>
                    )}
                  </div>
                  {(item.payeeName || item.payee?.name) && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {item.payeeName || item.payee?.name}
                    </div>
                  )}
                </div>
              </div>
              <div className={`font-semibold ${amountDisplay.className} whitespace-nowrap ml-2`}>
                {amountDisplay.text}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-1">
        {totalDue > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600 dark:text-gray-400">Total due</span>
            <span className="font-semibold text-red-600 dark:text-red-400">
              -{formatCurrencyBase(totalDue)}
            </span>
          </div>
        )}
        {totalIncoming > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600 dark:text-gray-400">Total incoming</span>
            <span className="font-semibold text-green-600 dark:text-green-400">
              +{formatCurrencyBase(totalIncoming)}
            </span>
          </div>
        )}
      </div>
      <button
        onClick={() => router.push('/bills')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        View all bills & deposits
      </button>
    </div>
  );
}
