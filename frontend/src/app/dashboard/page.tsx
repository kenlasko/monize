'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { subMonths, subWeeks, startOfWeek, format } from 'date-fns';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import dynamic from 'next/dynamic';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
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
import { TopMover, PortfolioSummary } from '@/types/investment';
import { MonthlyNetWorth } from '@/types/net-worth';
import { PageLayout } from '@/components/layout/PageLayout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
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
  const weekStartsOn = (usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [topMovers, setTopMovers] = useState<TopMover[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [hasInvestments, setHasInvestments] = useState(false);
  const [netWorthData, setNetWorthData] = useState<MonthlyNetWorth[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const brokerageMarketValues = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.totalMarketValue);
    }
    return map;
  }, [portfolioSummary]);

  const reloadTopMovers = useCallback(async () => {
    if (!hasInvestments) return;
    try {
      const [moversData, portfolio] = await Promise.all([
        investmentsApi.getTopMovers(),
        investmentsApi.getPortfolioSummary().catch(() => null),
      ]);
      setTopMovers(moversData);
      setPortfolioSummary(portfolio);
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
      const now = new Date();
      const currentWeekStart = startOfWeek(now, { weekStartsOn });
      const fiveWeeksAgoStart = subWeeks(currentWeekStart, 4);
      const chartStartDate = format(fiveWeeksAgoStart, 'yyyy-MM-dd');
      const today = format(now, 'yyyy-MM-dd');

      const twelveMonthsAgo = format(subMonths(new Date(), 12), 'yyyy-MM-dd');

      const fetchAllTransactions = async (startDate: string, endDate: string): Promise<Transaction[]> => {
        const allTransactions: Transaction[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          const result = await transactionsApi.getAll({
            startDate,
            endDate,
            page,
            limit: 200,
          });
          allTransactions.push(...result.data);
          hasMore = result.pagination.hasMore;
          page++;
        }
        return allTransactions;
      };

      const [accountsData, allTransactions, categoriesData, scheduledData, netWorth] = await Promise.all([
        accountsApi.getAll(),
        fetchAllTransactions(chartStartDate, today),
        categoriesApi.getAll(),
        scheduledTransactionsApi.getAll(),
        netWorthApi.getMonthly({ startDate: twelveMonthsAgo, endDate: today }).catch(() => [] as MonthlyNetWorth[]),
      ]);

      setAccounts(accountsData);
      setTransactions(allTransactions);
      setCategories(categoriesData);
      setScheduledTransactions(scheduledData);
      setNetWorthData(netWorth);

      const investmentAccounts = accountsData.filter(
        (a: Account) => a.accountType === 'INVESTMENT' && !a.isClosed,
      );
      const hasInvestmentAccounts = investmentAccounts.length > 0;
      setHasInvestments(hasInvestmentAccounts);

      // Load investment data directly so it appears even when price refresh is
      // skipped (outside market hours, cooldown active, etc.)
      if (hasInvestmentAccounts) {
        Promise.all([
          investmentsApi.getTopMovers().catch(() => [] as TopMover[]),
          investmentsApi.getPortfolioSummary().catch(() => null),
        ]).then(([moversData, portfolio]) => {
          setTopMovers(moversData);
          setPortfolioSummary(portfolio);
        });
      }
    } catch (error) {
      logger.error('Failed to load dashboard data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [weekStartsOn]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  useOnUndoRedo(loadDashboardData);

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
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                Welcome{user?.firstName ? `, ${user.firstName}` : ''}!
              </h1>
              <a
                href="https://github.com/kenlasko/monize/wiki/Dashboard"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-blue-500 transition-colors"
                aria-label="Help"
              >
                <QuestionMarkCircleIcon className="h-5 w-5" />
              </a>
            </div>
            <p className="text-gray-500 dark:text-gray-400">
              Here&apos;s your financial overview
            </p>
          </div>

          <GettingStarted />

          {/* Reports Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <FavouriteAccounts accounts={accounts} brokerageMarketValues={brokerageMarketValues} isLoading={isLoading} onAccountsChanged={loadDashboardData} />
            <UpcomingBills
              scheduledTransactions={scheduledTransactions}
              accounts={accounts}
              isLoading={isLoading}
              maxItems={accounts.filter((a) => a.isFavourite && !a.isClosed).length + 2}
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
