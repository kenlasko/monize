'use client';

import { ReportingBasisScope, ReportingBasisControl, useReportingBasis } from '@/components/reports/ReportingBasis';
import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { subMonths, format } from 'date-fns';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { Button } from '@/components/ui/Button';
import { GettingStarted } from '@/components/dashboard/GettingStarted';
import { CustomizeDashboardModal } from '@/components/dashboard/CustomizeDashboardModal';
import {
  DashboardWidgetContext,
  delegateDashboardWidgets,
  resolveDashboardWidgets,
} from '@/components/dashboard/widget-registry';
import { accountsApi } from '@/lib/accounts';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { netWorthApi } from '@/lib/net-worth';
import { invalidateCache } from '@/lib/apiCache';
import { Account } from '@/types/account';
import { countLogicalAccounts } from '@/lib/account-utils';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { TopMover, PortfolioSummary, FavouriteSecurityQuote } from '@/types/investment';
import { MonthlyNetWorth } from '@/types/net-worth';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { createLogger } from '@/lib/logger';
import { incompleteHoldingAccountIds as incompleteHoldingAccountIdsOf } from '@/lib/logical-accounts';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { TourBanner } from '@/components/dashboard/TourBanner';

const logger = createLogger('Dashboard');

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <ReportingBasisScope surface="dashboard" resetOnBasis><DashboardContent /></ReportingBasisScope>
    </ProtectedRoute>
  );
}

function DashboardContent() {
  const basis = useReportingBasis();
  const t = useTranslations('dashboard');
  const tc = useTranslations('common.recognitionDetails');
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
  const dashboardWidgets = usePreferencesStore((s) => s.preferences?.dashboardWidgets);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [topMovers, setTopMovers] = useState<TopMover[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [hasInvestments, setHasInvestments] = useState(false);
  const [netWorthData, setNetWorthData] = useState<MonthlyNetWorth[]>([]);
  // The net worth request failed: `netWorthData` is then empty, which is not
  // the answer "no history yet" and must not be shown as one.
  const [netWorthFailed, setNetWorthFailed] = useState(false);
  const [favouriteSecurities, setFavouriteSecurities] = useState<FavouriteSecurityQuote[]>([]);
  const [hasSecurities, setHasSecurities] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);

  const brokerageMarketValues = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.totalMarketValue);
    }
    return map;
  }, [portfolioSummary]);

  const unpricedHoldingCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.unpricedHoldingsCount ?? 0);
    }
    return map;
  }, [portfolioSummary]);

  const incompleteHoldingAccountIds = useMemo(
    () => incompleteHoldingAccountIdsOf(portfolioSummary?.holdingsByAccount),
    [portfolioSummary],
  );

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

  // A change of who the dashboard is loaded for shows the spinner again; set
  // during render rather than in the effect that reloads it.
  const requestKey = `${authHydrated}|${isDelegateView}|${delegateBills}`;
  const [loadingKey, setLoadingKey] = useState(requestKey);
  if (loadingKey !== requestKey) {
    setLoadingKey(requestKey);
    if (authHydrated) setIsLoading(true);
  }

  // The effect's load: the state already says loading.
  const fetchDashboardData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      if (!authHydrated) return;
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
        const today = format(now, 'yyyy-MM-dd');

        const twelveMonthsAgo = format(subMonths(new Date(), 12), 'yyyy-MM-dd');

        const [accountsData, scheduledData, netWorth, favouriteSecs, securitiesList] = await Promise.all([
          accountsApi.getAll(),
          scheduledTransactionsApi.getAll(),
          netWorthApi.getMonthly({ basis, startDate: twelveMonthsAgo, endDate: today }).catch((error) => {
            logger.error('Failed to load net worth history:', error);
            return null;
          }),
          investmentsApi.getFavouriteSecurities().catch(() => [] as FavouriteSecurityQuote[]),
          investmentsApi.getSecurities().catch(() => []),
        ]);

        setAccounts(accountsData);
        setScheduledTransactions(scheduledData);
        setLoadError(false);
        setNetWorthData(netWorth ?? []);
        setNetWorthFailed(netWorth === null);
        setFavouriteSecurities(favouriteSecs);
        setHasSecurities(securitiesList.length > 0);

        const investmentAccounts = accountsData.filter(
          (a: Account) => a.accountType === 'INVESTMENT' && !a.isClosed,
        );
        // A linked pair is one investment account, not two.
        const investmentAccountCount = countLogicalAccounts(investmentAccounts);
        const hasInvestmentAccounts = investmentAccountCount > 0;
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
        setLoadError(true);
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [authHydrated, isDelegateView, delegateBills, basis]);

  const loadDashboardData = useCallback(() => {
    if (authHydrated) setIsLoading(true);
    return fetchDashboardData();
  }, [authHydrated, fetchDashboardData]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  useOnUndoRedo(loadDashboardData);
  // An AI write (e.g. a transaction created from the chat bubble) changes the
  // dashboard's totals and recent activity, so refresh the same way.
  useOnAiAction(loadDashboardData);

  useEffect(() => {
    if (hasInvestments && !isLoading) {
      triggerAutoRefresh();
    }
  }, [hasInvestments, isLoading, triggerAutoRefresh]);

  const widgetContext: DashboardWidgetContext = {
    accounts,
    scheduledTransactions,
    topMovers,
    favouriteSecurities,
    netWorthData,
    netWorthFailed,
    brokerageMarketValues,
    unpricedHoldingCounts,
    incompleteHoldingAccountIds,
    isLoading,
    hasInvestments,
    hasSecurities,
    isRefreshing,
    onRefresh: triggerManualRefresh,
    onAccountsChanged: loadDashboardData,
  };

  // Delegates always get the fixed delegate layout (the stored preference is
  // the owner's); everyone else gets their own configured layout, falling
  // back to the default when they never customized.
  const visibleWidgets = useMemo(
    () =>
      isDelegateView
        ? delegateDashboardWidgets(delegateSections)
        : resolveDashboardWidgets(dashboardWidgets),
    [isDelegateView, delegateSections, dashboardWidgets],
  );

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="sm:px-0">
          <TourBanner />
          {/* Welcome section */}
          <PageHeader
            title={user?.firstName ? t('page.welcomeWithName', { name: user.firstName }) : `${t('page.welcomePrefix')}!`}
            subtitle={t('page.subtitle')}
            helpUrl="https://github.com/kenlasko/monize/wiki/Dashboard"
            compactMobileActions
            actions={
              !isDelegateView ? (
                <button
                  {...tourAnchor(TOUR_ANCHORS.dashboardCustomize)}
                  onClick={() => setShowCustomize(true)}
                  aria-label={t('customize.button')}
                  className="inline-flex items-center justify-center gap-2 p-2 sm:px-3 sm:py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span className="hidden sm:inline">{t('customize.button')}</span>
                </button>
              ) : undefined
            }
          />

          <ReportingBasisControl />
          {!isDelegateView && <GettingStarted />}

          {loadError && <div role="alert" className="mb-4"><p>{tc('failed')}</p><Button onClick={() => loadDashboardData()}>{tc('retry')}</Button></div>}
          {/* Widget grid: consecutive visible widgets pair up into rows */}
          <div
            {...tourAnchor(TOUR_ANCHORS.dashboardWidgets)}
            className="grid grid-cols-1 lg:grid-cols-2 gap-6"
          >
            {!loadError && visibleWidgets
              .filter((w) => !w.shouldRender || w.shouldRender(widgetContext))
              .map((w) => (
                <Fragment key={w.id}>{w.render(widgetContext)}</Fragment>
              ))}
          </div>

          {!isDelegateView && (
            <CustomizeDashboardModal
              isOpen={showCustomize}
              onClose={() => setShowCustomize(false)}
            />
          )}
        </div>
      </main>
    </PageLayout>
  );
}
