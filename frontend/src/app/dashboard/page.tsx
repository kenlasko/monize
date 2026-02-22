'use client';

import { useState, useEffect, useCallback } from 'react';
import { subDays, subMonths, format } from 'date-fns';
import dynamic from 'next/dynamic';
import { useAuthStore } from '@/store/authStore';
import { FavouriteAccounts } from '@/components/dashboard/FavouriteAccounts';
import { UpcomingBills } from '@/components/dashboard/UpcomingBills';
import { GettingStarted } from '@/components/dashboard/GettingStarted';
import { TopMovers } from '@/components/dashboard/TopMovers';
import { InsightsWidget } from '@/components/dashboard/InsightsWidget';
import { BudgetStatusWidget } from '@/components/dashboard/BudgetStatusWidget';

const ExpensesPieChart = dynamic(() => import('@/components/dashboard/ExpensesPieChart').then(m => m.ExpensesPieChart), { ssr: false });
const IncomeExpensesBarChart = dynamic(() => import('@/components/dashboard/IncomeExpensesBarChart').then(m => m.IncomeExpensesBarChart), { ssr: false });
const NetWorthChart = dynamic(() => import('@/components/dashboard/NetWorthChart').then(m => m.NetWorthChart), { ssr: false });
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { netWorthApi } from '@/lib/net-worth';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { TopMover } from '@/types/investment';
import { MonthlyNetWorth } from '@/types/net-worth';
import { PageLayout } from '@/components/layout/PageLayout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Dashboard');

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}

function DashboardContent() {
  const { user } = useAuthStore();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [topMovers, setTopMovers] = useState<TopMover[]>([]);
  const [hasInvestments, setHasInvestments] = useState(false);
  const [netWorthData, setNetWorthData] = useState<MonthlyNetWorth[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const reloadTopMovers = useCallback(async () => {
    if (!hasInvestments) return;
    try {
      const moversData = await investmentsApi.getTopMovers();
      setTopMovers(moversData);
    } catch {
      // Silently fail
    }
  }, [hasInvestments]);

  const { isRefreshing, triggerManualRefresh, triggerAutoRefresh } = usePriceRefresh({
    onRefreshComplete: reloadTopMovers,
  });

  const loadDashboardData = useCallback(async () => {
    setIsLoading(true);
    try {
      const thirtyDaysAgo = format(subDays(new Date(), 30), 'yyyy-MM-dd');
      const today = format(new Date(), 'yyyy-MM-dd');

      const twelveMonthsAgo = format(subMonths(new Date(), 12), 'yyyy-MM-dd');

      const [accountsData, transactionsData, categoriesData, scheduledData, netWorth] = await Promise.all([
        accountsApi.getAll(),
        transactionsApi.getAll({
          startDate: thirtyDaysAgo,
          endDate: today,
          limit: 200,
        }),
        categoriesApi.getAll(),
        scheduledTransactionsApi.getAll(),
        netWorthApi.getMonthly({ startDate: twelveMonthsAgo, endDate: today }).catch(() => [] as MonthlyNetWorth[]),
      ]);

      setAccounts(accountsData);
      setTransactions(transactionsData.data);
      setCategories(categoriesData);
      setScheduledTransactions(scheduledData);
      setNetWorthData(netWorth);

      const investmentAccounts = accountsData.filter(
        (a: Account) => a.accountType === 'INVESTMENT' && !a.isClosed,
      );
      const hasInvestmentAccounts = investmentAccounts.length > 0;
      setHasInvestments(hasInvestmentAccounts);

      // Load top movers directly so they appear even when price refresh is
      // skipped (outside market hours, cooldown active, etc.)
      if (hasInvestmentAccounts) {
        investmentsApi.getTopMovers().then(setTopMovers).catch(() => {});
      }
    } catch (error) {
      logger.error('Failed to load dashboard data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  useEffect(() => {
    if (hasInvestments && !isLoading) {
      triggerAutoRefresh();
    }
  }, [hasInvestments, isLoading, triggerAutoRefresh]);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="sm:px-0">
          {/* Welcome section */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Welcome{user?.firstName ? `, ${user.firstName}` : ''}!
            </h1>
            <p className="text-gray-500 dark:text-gray-400">
              Here&apos;s your financial overview
            </p>
          </div>

          <GettingStarted />

          {/* Reports Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <FavouriteAccounts accounts={accounts} isLoading={isLoading} />
            <UpcomingBills
              scheduledTransactions={scheduledTransactions}
              isLoading={isLoading}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <NetWorthChart data={netWorthData} isLoading={isLoading} />
            <TopMovers movers={topMovers} isLoading={isLoading} hasInvestmentAccounts={hasInvestments} onRefresh={triggerManualRefresh} isRefreshing={isRefreshing} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <ExpensesPieChart
              transactions={transactions}
              categories={categories}
              isLoading={isLoading}
            />
            <IncomeExpensesBarChart transactions={transactions} isLoading={isLoading} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <BudgetStatusWidget isLoading={isLoading} />
            <InsightsWidget isLoading={isLoading} />
          </div>
        </div>
      </main>
    </PageLayout>
  );
}
