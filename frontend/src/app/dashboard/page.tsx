'use client';

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { subMonths, format } from 'date-fns';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
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
import { HOVER_TOOLBAR_BUTTON } from '@/components/ui/Card';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { createLogger } from '@/lib/logger';
import { incompleteHoldingAccountIds as incompleteHoldingAccountIdsOf } from '@/lib/logical-accounts';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { TourBanner } from '@/components/dashboard/TourBanner';
import { DashboardHero } from '@/components/dashboard/DashboardHero';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { greetingPeriod } from '@/lib/greeting';

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
  const dashboardWidgets = usePreferencesStore((s) => s.preferences?.dashboardWidgets);
  const timezonePref = usePreferencesStore((s) => s.preferences?.timezone);
  const today = useFinancialToday();
  const formatChartDate = useChartDateFormat();
  // The moment the page opened, read once: the greeting does not change under
  // the reader while the page stays open.
  const [openedAt] = useState(() => new Date());

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
  // The portfolio summary loads after `isLoading` clears (below), so the hero
  // waits on this too -- otherwise its "invested" figure pops in a beat after
  // net worth, assets and liabilities, which render as soon as `isLoading` does.
  const [investmentSummaryLoading, setInvestmentSummaryLoading] = useState(false);
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
          netWorthApi.getMonthly({ startDate: twelveMonthsAgo, endDate: today }).catch((error) => {
            logger.error('Failed to load net worth history:', error);
            return null;
          }),
          investmentsApi.getFavouriteSecurities().catch(() => [] as FavouriteSecurityQuote[]),
          investmentsApi.getSecurities().catch(() => []),
        ]);

        setAccounts(accountsData);
        setScheduledTransactions(scheduledData);
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
          setInvestmentSummaryLoading(true);
          Promise.all([
            investmentsApi.getTopMovers().catch(() => [] as TopMover[]),
            investmentsApi.getPortfolioSummary().catch(() => null),
          ])
            .then(([moversData, portfolio]) => {
              setTopMovers(moversData);
              setPortfolioSummary(portfolio);
            })
            .finally(() => setInvestmentSummaryLoading(false));
        } else {
          setInvestmentSummaryLoading(false);
        }
      } catch (error) {
        logger.error('Failed to load dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [authHydrated, isDelegateView, delegateBills]);

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

  // The accounts the hero's portfolio set offers, as the Portfolio Value
  // widget offers them.
  const portfolioAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === 'INVESTMENT'),
    [accounts],
  );

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

  // The greeting for the part of the day, and today's date. They are the
  // page header whether or not the hero below them is on.
  const period = greetingPeriod(openedAt, timezonePref);
  const pageTitle = user?.firstName
    ? t(`page.greeting.${period}WithName`, { name: user.firstName })
    : t(`page.greeting.${period}`);
  const pageSubtitle = formatChartDate(today, 'EEEE MMMM d');

  const header = (
    <PageHeader
      title={pageTitle}
      subtitle={pageSubtitle}
      help='dashboard'
      titleAdornment={
        !isDelegateView ? (
          <button
            type="button"
            {...tourAnchor(TOUR_ANCHORS.dashboardCustomize)}
            onClick={() => setShowCustomize(true)}
            aria-label={t('customize.button')}
            title={t('customize.button')}
            className={`p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${HOVER_TOOLBAR_BUTTON}`}
          >
            <Cog6ToothIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : undefined
      }
    />
  );

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="sm:px-0">
          <TourBanner />
          {/* The greeting, with Customize as a gear beside it. The hero holds
              it in its figures column so the net worth chart can sit beside
              the greeting. A delegate sees only the sections they were
              granted; the net worth figures are not one of them, so for a
              delegate the header stands alone. */}
          {isDelegateView ? (
            header
          ) : (
            <DashboardHero
              portfolioSummary={portfolioSummary}
              hasInvestments={hasInvestments}
              isLoading={isLoading}
              investmentSummaryLoading={investmentSummaryLoading}
              investmentAccounts={portfolioAccounts}
              header={header}
            />
          )}

          {!isDelegateView && <GettingStarted />}

          {/* Widget grid: consecutive visible widgets pair up into rows */}
          <div
            {...tourAnchor(TOUR_ANCHORS.dashboardWidgets)}
            className="grid grid-cols-1 lg:grid-cols-2 gap-6"
          >
            {visibleWidgets
              .filter((w) => !w.shouldRender || w.shouldRender(widgetContext))
              .map((w) => (
                <Fragment key={w.id}>{w.render(widgetContext)}</Fragment>
              ))}
          </div>

          {!isDelegateView && (
            <CustomizeDashboardModal
              isOpen={showCustomize}
              onClose={() => setShowCustomize(false)}
              investmentAccounts={portfolioAccounts}
            />
          )}
        </div>
      </main>
    </PageLayout>
  );
}
