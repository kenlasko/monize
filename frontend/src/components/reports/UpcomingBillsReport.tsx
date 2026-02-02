'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isToday,
  addMonths,
  subMonths,
  getDay,
  isSameDay,
  parseISO,
  addWeeks,
  addDays,
  addYears,
} from 'date-fns';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { ScheduledTransaction, FrequencyType } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  bills: ScheduledTransaction[];
}

interface UpcomingBill {
  scheduledTransaction: ScheduledTransaction;
  dueDate: Date;
  amount: number;
  isOverdue: boolean;
}

export function UpcomingBillsReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [viewType, setViewType] = useState<'calendar' | 'list'>('calendar');

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const data = await scheduledTransactionsApi.getAll();
        // Filter to active, non-transfer transactions
        setScheduledTransactions(
          data.filter((st) => st.isActive && !st.isTransfer)
        );
      } catch (error) {
        console.error('Failed to load scheduled transactions:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  // Generate upcoming occurrences for each scheduled transaction
  const getNextOccurrences = (st: ScheduledTransaction, monthsAhead: number = 3): Date[] => {
    const occurrences: Date[] = [];
    const startDate = new Date();
    const endDate = addMonths(startDate, monthsAhead);
    let nextDate = parseLocalDate(st.nextDueDate);

    const maxOccurrences = 100;
    let count = 0;

    while (nextDate <= endDate && count < maxOccurrences) {
      if (nextDate >= startDate || isSameDay(nextDate, startDate) || nextDate < startDate) {
        // Include past due dates too
        occurrences.push(new Date(nextDate));
      }

      // Calculate next occurrence based on frequency
      switch (st.frequency) {
        case 'ONCE':
          return occurrences;
        case 'DAILY':
          nextDate = addDays(nextDate, 1);
          break;
        case 'WEEKLY':
          nextDate = addWeeks(nextDate, 1);
          break;
        case 'BIWEEKLY':
          nextDate = addWeeks(nextDate, 2);
          break;
        case 'MONTHLY':
          nextDate = addMonths(nextDate, 1);
          break;
        case 'QUARTERLY':
          nextDate = addMonths(nextDate, 3);
          break;
        case 'YEARLY':
          nextDate = addYears(nextDate, 1);
          break;
      }
      count++;
    }

    return occurrences;
  };

  const calendarDays = useMemo((): CalendarDay[] => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);

    // Get the start of the calendar (may include days from prev month)
    const calendarStart = new Date(monthStart);
    calendarStart.setDate(calendarStart.getDate() - getDay(monthStart));

    // Get end of calendar (may include days from next month)
    const calendarEnd = new Date(monthEnd);
    const daysToAdd = 6 - getDay(monthEnd);
    calendarEnd.setDate(calendarEnd.getDate() + daysToAdd);

    const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

    // Build a map of bills by date
    const billsByDate = new Map<string, ScheduledTransaction[]>();

    scheduledTransactions.forEach((st) => {
      const occurrences = getNextOccurrences(st, 3);
      occurrences.forEach((date) => {
        const key = format(date, 'yyyy-MM-dd');
        const existing = billsByDate.get(key) || [];
        existing.push(st);
        billsByDate.set(key, existing);
      });
    });

    return days.map((date) => ({
      date,
      isCurrentMonth: isSameMonth(date, currentMonth),
      isToday: isToday(date),
      bills: billsByDate.get(format(date, 'yyyy-MM-dd')) || [],
    }));
  }, [currentMonth, scheduledTransactions]);

  const upcomingBills = useMemo((): UpcomingBill[] => {
    const bills: UpcomingBill[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    scheduledTransactions.forEach((st) => {
      const occurrences = getNextOccurrences(st, 3);
      occurrences.forEach((dueDate) => {
        bills.push({
          scheduledTransaction: st,
          dueDate,
          amount: st.amount,
          isOverdue: dueDate < today,
        });
      });
    });

    return bills.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  }, [scheduledTransactions]);

  const summary = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthEnd = endOfMonth(currentMonth);

    const overdue = upcomingBills.filter((b) => b.isOverdue);
    const thisMonth = upcomingBills.filter(
      (b) => !b.isOverdue && b.dueDate <= monthEnd && isSameMonth(b.dueDate, currentMonth)
    );

    return {
      overdueCount: overdue.length,
      overdueTotal: overdue.reduce((sum, b) => sum + Math.abs(b.amount), 0),
      thisMonthCount: thisMonth.length,
      thisMonthTotal: thisMonth.reduce((sum, b) => sum + Math.abs(b.amount), 0),
    };
  }, [upcomingBills, currentMonth]);

  const handleBillClick = (st: ScheduledTransaction) => {
    router.push(`/scheduled-transactions?id=${st.id}`);
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Active Bills</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {scheduledTransactions.length}
          </div>
        </div>
        {summary.overdueCount > 0 && (
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            <div className="text-sm text-red-600 dark:text-red-400">Overdue</div>
            <div className="text-xl font-bold text-red-700 dark:text-red-300">
              {summary.overdueCount}
            </div>
            <div className="text-sm text-red-600 dark:text-red-400">
              {formatCurrency(summary.overdueTotal)}
            </div>
          </div>
        )}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">This Month</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {summary.thisMonthCount}
          </div>
          <div className="text-sm text-blue-600 dark:text-blue-400">
            {formatCurrency(summary.thisMonthTotal)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 min-w-[160px] text-center">
              {format(currentMonth, 'MMMM yyyy')}
            </h3>
            <button
              onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              onClick={() => setCurrentMonth(new Date())}
              className="ml-2 px-3 py-1 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md"
            >
              Today
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('calendar')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'calendar'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Calendar
            </button>
            <button
              onClick={() => setViewType('list')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'list'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              List
            </button>
          </div>
        </div>
      </div>

      {scheduledTransactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No scheduled bills found. Add scheduled transactions to see them in this calendar.
          </p>
        </div>
      ) : viewType === 'calendar' ? (
        /* Calendar View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="grid grid-cols-7">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <div
                key={day}
                className="px-2 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700"
              >
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {calendarDays.map((day, index) => (
              <div
                key={index}
                className={`min-h-[100px] p-1 border-b border-r border-gray-200 dark:border-gray-700 ${
                  !day.isCurrentMonth
                    ? 'bg-gray-50 dark:bg-gray-900/50'
                    : 'bg-white dark:bg-gray-800'
                }`}
              >
                <div
                  className={`text-sm font-medium mb-1 w-7 h-7 flex items-center justify-center rounded-full ${
                    day.isToday
                      ? 'bg-blue-600 text-white'
                      : day.isCurrentMonth
                      ? 'text-gray-900 dark:text-gray-100'
                      : 'text-gray-400 dark:text-gray-600'
                  }`}
                >
                  {format(day.date, 'd')}
                </div>
                <div className="space-y-0.5">
                  {day.bills.slice(0, 3).map((bill, billIndex) => {
                    const isExpense = bill.amount < 0;
                    return (
                      <div
                        key={billIndex}
                        onClick={() => handleBillClick(bill)}
                        className={`px-1 py-0.5 text-xs rounded truncate cursor-pointer ${
                          isExpense
                            ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        } hover:opacity-80`}
                      >
                        {bill.name}
                      </div>
                    );
                  })}
                  {day.bills.length > 3 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
                      +{day.bills.length - 3} more
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* List View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {upcomingBills.slice(0, 50).map((bill, index) => (
              <div
                key={`${bill.scheduledTransaction.id}-${index}`}
                onClick={() => handleBillClick(bill.scheduledTransaction)}
                className={`px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                  bill.isOverdue ? 'bg-red-50 dark:bg-red-900/10' : ''
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${
                      bill.isOverdue
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-900 dark:text-gray-100'
                    }`}>
                      {bill.scheduledTransaction.name}
                    </span>
                    {bill.isOverdue && (
                      <span className="px-1.5 py-0.5 bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400 text-xs rounded">
                        Overdue
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {bill.scheduledTransaction.payee?.name || bill.scheduledTransaction.payeeName || 'No payee'}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-medium ${
                    bill.amount < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-green-600 dark:text-green-400'
                  }`}>
                    {formatCurrency(Math.abs(bill.amount))}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {format(bill.dueDate, 'MMM d, yyyy')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
