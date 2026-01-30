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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ExpensesPieChart
              transactions={transactions}
              categories={categories}
              isLoading={isLoading}
            />
            <IncomeExpensesBarChart transactions={transactions} isLoading={isLoading} />
          </div>
        </div>
      </main>
    </div>
  );
}
