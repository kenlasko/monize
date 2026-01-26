'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { subDays, format } from 'date-fns';
import { useAuthStore } from '@/store/authStore';
import { AppHeader } from '@/components/layout/AppHeader';
import { FavouriteAccounts } from '@/components/dashboard/FavouriteAccounts';
import { UpcomingBills } from '@/components/dashboard/UpcomingBills';
import { ExpensesPieChart } from '@/components/dashboard/ExpensesPieChart';
import { IncomeExpensesBarChart } from '@/components/dashboard/IncomeExpensesBarChart';
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { ScheduledTransaction } from '@/types/scheduled-transaction';

export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuthStore();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadDashboardData = useCallback(async () => {
    setIsLoading(true);
    try {
      const thirtyDaysAgo = format(subDays(new Date(), 30), 'yyyy-MM-dd');
      const today = format(new Date(), 'yyyy-MM-dd');

      const [accountsData, transactionsData, categoriesData, scheduledData] = await Promise.all([
        accountsApi.getAll(),
        transactionsApi.getAll({
          startDate: thirtyDaysAgo,
          endDate: today,
          limit: 1000, // Get enough transactions for reports
        }),
        categoriesApi.getAll(),
        scheduledTransactionsApi.getAll(),
      ]);

      setAccounts(accountsData);
      setTransactions(transactionsData.data);
      setCategories(categoriesData);
      setScheduledTransactions(scheduledData);
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      <main className="px-4 sm:px-6 lg:px-12 py-6">
        <div className="px-4 sm:px-0">
          {/* Welcome section */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Welcome{user?.firstName ? `, ${user.firstName}` : ''}!
            </h1>
            <p className="text-gray-500 dark:text-gray-400">
              Here&apos;s your financial overview
            </p>
          </div>

          {/* Reports Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <FavouriteAccounts accounts={accounts} isLoading={isLoading} />
            <UpcomingBills
              scheduledTransactions={scheduledTransactions}
              isLoading={isLoading}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <ExpensesPieChart
              transactions={transactions}
              categories={categories}
              isLoading={isLoading}
            />
            <IncomeExpensesBarChart transactions={transactions} isLoading={isLoading} />
          </div>

          {/* Quick Actions */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Quick Actions
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
              <button
                onClick={() => router.push('/transactions')}
                className="flex flex-col items-center justify-center p-4 bg-gray-50 dark:bg-gray-700/50 border-2 border-transparent rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
              >
                <svg
                  className="h-6 w-6 text-blue-600 dark:text-blue-400 mb-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  Transactions
                </span>
              </button>

              <button
                onClick={() => router.push('/accounts')}
                className="flex flex-col items-center justify-center p-4 bg-gray-50 dark:bg-gray-700/50 border-2 border-transparent rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
              >
                <svg
                  className="h-6 w-6 text-green-600 dark:text-green-400 mb-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                  />
                </svg>
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  Accounts
                </span>
              </button>

              <button
                onClick={() => router.push('/budgets')}
                className="flex flex-col items-center justify-center p-4 bg-gray-50 dark:bg-gray-700/50 border-2 border-transparent rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
              >
                <svg
                  className="h-6 w-6 text-purple-600 dark:text-purple-400 mb-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                  />
                </svg>
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  Budgets
                </span>
              </button>

              <button
                onClick={() => router.push('/payees')}
                className="flex flex-col items-center justify-center p-4 bg-gray-50 dark:bg-gray-700/50 border-2 border-transparent rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
              >
                <svg
                  className="h-6 w-6 text-orange-600 dark:text-orange-400 mb-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  Payees
                </span>
              </button>

              <button
                onClick={() => router.push('/categories')}
                className="flex flex-col items-center justify-center p-4 bg-gray-50 dark:bg-gray-700/50 border-2 border-transparent rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
              >
                <svg
                  className="h-6 w-6 text-indigo-600 dark:text-indigo-400 mb-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                  />
                </svg>
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  Categories
                </span>
              </button>

              <button
                onClick={() => router.push('/bills')}
                className="flex flex-col items-center justify-center p-4 bg-gray-50 dark:bg-gray-700/50 border-2 border-transparent rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
              >
                <svg
                  className="h-6 w-6 text-teal-600 dark:text-teal-400 mb-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  Bills
                </span>
              </button>

              <button
                onClick={() => router.push('/reports')}
                className="flex flex-col items-center justify-center p-4 bg-gray-50 dark:bg-gray-700/50 border-2 border-transparent rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
              >
                <svg
                  className="h-6 w-6 text-red-600 dark:text-red-400 mb-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  Reports
                </span>
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
