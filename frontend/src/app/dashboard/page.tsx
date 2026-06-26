'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { subMonths, subWeeks, startOfWeek, format } from 'date-fns';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { FavouriteAccounts } from '@/components/dashboard/FavouriteAccounts';
import { UpcomingBills } from '@/components/dashboard/UpcomingBills';
import { GettingStarted } from '@/components/dashboard/GettingStarted';
import { TopMovers } from '@/components/dashboard/TopMovers';
import { FavouriteSecurities } from '@/components/dashboard/FavouriteSecurities';
import { InsightsWidget } from '@/components/dashboard/InsightsWidget';
import { BudgetStatusWidget } from '@/components/dashboard/BudgetStatusWidget';

const ExpensesPieChart = dynamic(() => import('@/components/dashboard/ExpensesPieChart').then(m => m.ExpensesPieChart), {
  ssr: false,
  loading: () => <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 lg:min-h-[540px]" />,
});
const IncomeExpensesBarChart = dynamic(() => import('@/components/dashboard/IncomeExpensesBarChart').then(m => m.IncomeExpensesBarChart), {
  ssr: false,
  loading: () => <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[540px]" />,
});
const NetWorthChart = dynamic(() => import('@/components/dashboard/NetWorthChart').then(m => m.NetWorthChart), {
  ssr: false,
  loading: () => <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]" />,
});
const AssetsVsLiabilities = dynamic(() => import('@/components/dashboard/AssetsVsLiabilities').then(m => m.AssetsVsLiabilities), {
  ssr: false,
  loading: () => <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]" />,
});
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { netWorthApi } from '@/lib/net-worth';
import { invalidateCache } from '@/lib/apiCache';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { TopMover, PortfolioSummary, FavouriteSecurityQuote } from '@/types/investment';
import { MonthlyNetWorth } from '@/types/net-worth';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
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
  const t = useTranslations('dashboard');
  const user = useAuthStore((s) => s.user);
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const isDelegateView = !!actingAsUserId;
  const delegateSections = useAuthStore((s) => s.delegateSections);
  const delegateBills = !!delegateSections?.bills;
  // The acting-as context is rehydrated from localStorage; running the
  // owner-only data load before that completes would spuriously 403 a
  // delegate on the owner endpoints (and then re-run with the right
  // path), so wait until the store has hydrated before firing.
  const authHydrated = useAuthStore((s) => s._hasHydrated);
  const weekStartsOn = (usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [topMovers, setTopMovers] = useState<TopMover[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [hasInvestments, setHasInvestments] = useState(false);
  const [netWorthData, setNetWorthData] = useState<MonthlyNetWorth[]>([]);
  const [favouriteSecurities, setFavouriteSecurities] = useState<FavouriteSecurityQuote[]>([]);
  const [hasSecurities, setHasSecurities] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const brokerageMarketValues = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.totalMarketValue);
    }
    return map;
  }, [portfolioSummary]);

  const reloadInvestmentWidgets = useCallback(async () => {
    // Favourite securities can exist without investment accounts, so always
    // refresh them; top movers only apply when there are holdings.
    invalidateCache('investments:favouriteSecurities');
    const favouritesPromise = investmentsApi
      .getFavouriteSecurities()
      .then(setFavouriteSecurities)
      .catch(() => {});
    if (hasInvestments) {
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
    }
    await favouritesPromise;
  }, [hasInvestments]);

  const { isRefreshing, triggerManualRefresh, triggerAutoRefresh } = usePriceRefresh({
    onRefreshComplete: reloadInvestmentWidgets,
  });

  const loadDashboardData = useCallback(async () => {
    if (!authHydrated) return;
    setIsLoading(true);
    try {
      // Phase 1: a delegate only sees the Favourite Accounts widget, and the
      // other dashboard endpoints are not delegate-accessible. Load just the
      // (server-filtered) accounts and stop.
      if (isDelegateView) {
        const delegateAccounts = await accountsApi.getAll();
        setAccounts(delegateAccounts);
        // 3C: when the owner granted the Bills & Deposits section, the
        // scheduled endpoint is delegate-reachable (server-filtered to the
        // delegate's readable accounts) so the widget can render.
        if (delegateBills) {
          try {
            const sched = await scheduledTransactionsApi.getAll();
            setScheduledTransactions(sched);
          } catch (error) {
            logger.error('Failed to load delegate scheduled data:', error);
          }
        }
        setIsLoading(false);
        return;
      }

      const now = new Date();
      const currentWeekStart = startOfWeek(now, { weekStartsOn });
      const fiveWeeksAgoStart = subWeeks(currentWeekStart, 4);
      const chartStartDate = format(fiveWeeksAgoStart, 'yyyy-MM-dd');
      const today = format(now, 'yyyy-MM-dd');

      const twelveMonthsAgo = format(subMonths(new Date(), 12), 'yyyy-MM-dd');

      const [accountsData, allTransactions, categoriesData, scheduledData, netWorth, favouriteSecs, securitiesList] = await Promise.all([
        accountsApi.getAll(),
        transactionsApi.getAllPages({ startDate: chartStartDate, endDate: today }),
        categoriesApi.getAll(),
        scheduledTransactionsApi.getAll(),
        netWorthApi.getMonthly({ startDate: twelveMonthsAgo, endDate: today }).catch(() => [] as MonthlyNetWorth[]),
        investmentsApi.getFavouriteSecurities().catch(() => [] as FavouriteSecurityQuote[]),
        investmentsApi.getSecurities().catch(() => []),
      ]);

      setAccounts(accountsData);
      setTransactions(allTransactions);
      setCategories(categoriesData);
      setScheduledTransactions(scheduledData);
      setNetWorthData(netWorth);
      setFavouriteSecurities(favouriteSecs);
      setHasSecurities(securitiesList.length > 0);

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
  }, [authHydrated, weekStartsOn, isDelegateView, delegateBills]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  useOnUndoRedo(loadDashboardData);
  // An AI write (e.g. a transaction created from the chat bubble) changes the
  // dashboard's totals and recent activity, so refresh the same way.
  useOnAiAction(loadDashboardData);

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
          <PageHeader
            title={user?.firstName ? t('page.welcomeWithName', { name: user.firstName }) : `${t('page.welcomePrefix')}!`}
            subtitle={t('page.subtitle')}
            helpUrl="https://github.com/kenlasko/monize/wiki/Dashboard"
          />

          {isDelegateView ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <FavouriteAccounts
                accounts={accounts}
                brokerageMarketValues={brokerageMarketValues}
                isLoading={isLoading}
                onAccountsChanged={loadDashboardData}
              />
              {delegateBills && (
                <UpcomingBills
                  scheduledTransactions={scheduledTransactions}
                  accounts={accounts}
                  isLoading={isLoading}
                  maxItems={
                    accounts.filter((a) => a.isFavourite && !a.isClosed)
                      .length + 2
                  }
                />
              )}
            </div>
          ) : (
            <>
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

              {(isLoading || hasSecurities) && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                  <TopMovers movers={topMovers} isLoading={isLoading} hasInvestmentAccounts={hasInvestments} onRefresh={triggerManualRefresh} isRefreshing={isRefreshing} />
                  <FavouriteSecurities securities={favouriteSecurities} isLoading={isLoading} onRefresh={triggerManualRefresh} isRefreshing={isRefreshing} />
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                <NetWorthChart data={netWorthData} isLoading={isLoading} />
                <AssetsVsLiabilities data={netWorthData} isLoading={isLoading} />
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
            </>
          )}
        </div>
      </main>
    </PageLayout>
  );
}
