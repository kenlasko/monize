'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { subMonths, format } from 'date-fns';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { GettingStarted } from '@/components/dashboard/GettingStarted';
import {
  DASHBOARD_WIDGETS,
  DashboardWidgetContext,
  delegateDashboardWidgets,
} from '@/components/dashboard/widget-registry';
import { defaultLayoutItem, resolveDashboardLayout } from '@/components/dashboard/dashboard-layout';
import { DashboardGrid, type DashboardGridEditing } from '@/components/dashboard/DashboardGrid';
import { useDashboardLayoutDraft } from '@/hooks/useDashboardLayoutDraft';
import { useGridReorder } from '@/hooks/useGridReorder';
import { accountsApi } from '@/lib/accounts';
import { institutionsApi } from '@/lib/institutions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { netWorthApi } from '@/lib/net-worth';
import { invalidateCache } from '@/lib/apiCache';
import { Account } from '@/types/account';
import type { Institution } from '@/types/institution';
import { countLogicalAccounts } from '@/lib/account-utils';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { TopMover, PortfolioValuation, FavouriteSecurityQuote } from '@/types/investment';
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

// Edit mode's parts load on demand, behind `editing` (and the hero dialog
// behind its own open flag), so the dashboard's first load does not grow.
const DashboardEditBar = dynamic(
  () => import('@/components/dashboard/DashboardEditBar').then((m) => m.DashboardEditBar),
  { ssr: false },
);
const WidgetEditOverlay = dynamic(
  () => import('@/components/dashboard/WidgetEditOverlay').then((m) => m.WidgetEditOverlay),
  { ssr: false },
);
const WidgetPlaceholder = dynamic(
  () => import('@/components/dashboard/WidgetEditOverlay').then((m) => m.WidgetPlaceholder),
  { ssr: false },
);
const WidgetDragChip = dynamic(
  () => import('@/components/dashboard/WidgetEditOverlay').then((m) => m.WidgetDragChip),
  { ssr: false },
);
const AddWidgetDialog = dynamic(
  () => import('@/components/dashboard/AddWidgetDialog').then((m) => m.AddWidgetDialog),
  { ssr: false },
);
const AddWidgetTile = dynamic(
  () => import('@/components/dashboard/AddWidgetDialog').then((m) => m.AddWidgetTile),
  { ssr: false },
);
const DashboardHeroSettingsModal = dynamic(
  () => import('@/components/dashboard/DashboardHeroSettingsModal').then((m) => m.DashboardHeroSettingsModal),
  { ssr: false },
);
const UnsavedChangesDialog = dynamic(
  () => import('@/components/ui/UnsavedChangesDialog').then((m) => m.UnsavedChangesDialog),
  { ssr: false },
);

const WIDGET_TITLE_SECTIONS = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w.titleSection]));

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
  const dashboardWidgetConfig = usePreferencesStore((s) => s.preferences?.dashboardWidgetConfig);
  const timezonePref = usePreferencesStore((s) => s.preferences?.timezone);
  const today = useFinancialToday();
  const formatChartDate = useChartDateFormat();
  // The moment the page opened, read once: the greeting does not change under
  // the reader while the page stays open.
  const [openedAt] = useState(() => new Date());

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [topMovers, setTopMovers] = useState<TopMover[]>([]);
  const [portfolioValuation, setPortfolioValuation] = useState<PortfolioValuation | null>(null);
  const [hasInvestments, setHasInvestments] = useState(false);
  const [netWorthData, setNetWorthData] = useState<MonthlyNetWorth[]>([]);
  // The net worth request failed: `netWorthData` is then empty, which is not
  // the answer "no history yet" and must not be shown as one.
  const [netWorthFailed, setNetWorthFailed] = useState(false);
  const [favouriteSecurities, setFavouriteSecurities] = useState<FavouriteSecurityQuote[]>([]);
  const [hasSecurities, setHasSecurities] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // The portfolio valuation loads after `isLoading` clears (below). The hero
  // holds only its "invested" figure on this, and the automatic price refresh
  // waits for it so the two do not compete for the server.
  const [investmentSummaryLoading, setInvestmentSummaryLoading] = useState(false);
  const layoutDraft = useDashboardLayoutDraft();
  // A delegate never enters edit mode (DASH-9).
  const editing = layoutDraft.editing && !isDelegateView;
  const [showAddWidget, setShowAddWidget] = useState(false);
  const [showHeroSettings, setShowHeroSettings] = useState(false);
  // The latest move, for the grid's polite live region.
  const [moveAnnouncement, setMoveAnnouncement] = useState('');

  const brokerageMarketValues = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioValuation) return map;
    for (const accountHoldings of portfolioValuation.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.totalMarketValue);
    }
    return map;
  }, [portfolioValuation]);

  const unpricedHoldingCounts = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioValuation) return map;
    for (const accountHoldings of portfolioValuation.holdingsByAccount) {
      map.set(accountHoldings.accountId, accountHoldings.unpricedHoldingsCount ?? 0);
    }
    return map;
  }, [portfolioValuation]);

  const incompleteHoldingAccountIds = useMemo(
    () => incompleteHoldingAccountIdsOf(portfolioValuation?.holdingsByAccount),
    [portfolioValuation],
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
          investmentsApi.getPortfolioValuation().catch(() => null),
        ]);
        setTopMovers(moversData);
        setPortfolioValuation(portfolio);
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
          setInstitutions([]);
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

        const [accountsData, scheduledData, netWorth, favouriteSecs, securitiesList, institutionsData] = await Promise.all([
          accountsApi.getAll(),
          scheduledTransactionsApi.getAll(),
          netWorthApi.getMonthly({ startDate: twelveMonthsAgo, endDate: today }).catch((error) => {
            logger.error('Failed to load net worth history:', error);
            return null;
          }),
          investmentsApi.getFavouriteSecurities().catch(() => [] as FavouriteSecurityQuote[]),
          investmentsApi.getSecurities().catch(() => []),
          institutionsApi.getAll().catch((error) => {
            logger.error('Failed to load institutions for their logos:', error);
            return [] as Institution[];
          }),
        ]);

        setAccounts(accountsData);
        setInstitutions(institutionsData);
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
            investmentsApi.getPortfolioValuation().catch(() => null),
          ])
            .then(([moversData, portfolio]) => {
              setTopMovers(moversData);
              setPortfolioValuation(portfolio);
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
    if (hasInvestments && !isLoading && !investmentSummaryLoading) {
      triggerAutoRefresh();
    }
  }, [hasInvestments, isLoading, investmentSummaryLoading, triggerAutoRefresh]);

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
    institutions,
    isLoading,
    hasInvestments,
    hasSecurities,
    isRefreshing,
    onRefresh: triggerManualRefresh,
    onAccountsChanged: loadDashboardData,
  };

  // Delegates always get the fixed delegate layout at default sizes (the
  // stored preferences are the owner's); everyone else gets their own
  // configured layout, falling back to the default when they never customized.
  const storedLayout = useMemo(
    () =>
      isDelegateView
        ? delegateDashboardWidgets(delegateSections).map((w) => defaultLayoutItem(w.id))
        : resolveDashboardLayout(dashboardWidgets, dashboardWidgetConfig),
    [isDelegateView, delegateSections, dashboardWidgets, dashboardWidgetConfig],
  );
  // While editing, the grid is drawn from the draft; otherwise from what is stored.
  const draft = editing ? layoutDraft.draft : null;
  const layout = draft ?? storedLayout;

  // Each visit to edit mode starts with its dialogs shut and nothing announced.
  const enterEditMode = () => {
    setShowAddWidget(false);
    setShowHeroSettings(false);
    setMoveAnnouncement('');
    layoutDraft.enter();
  };

  const { dispatch: dispatchLayout } = layoutDraft;
  // One move, from the overlay's buttons or the grip: dispatched, read out,
  // and focus kept on the control that moved it. A pointer drop moves no
  // focus: the grip's press never took it.
  const moveWidget = useCallback(
    (from: number, to: number, focus: 'button' | 'grip' | 'none' = 'button') => {
      if (!draft || to < 0 || to >= draft.length || from === to) return;
      const { id } = draft[from];
      dispatchLayout({ type: 'move', from, to });
      const section = WIDGET_TITLE_SECTIONS.get(id);
      const name = section ? t(`${section}.title` as Parameters<typeof t>[0]) : id;
      setMoveAnnouncement(t('edit.moved', { name, position: to + 1, count: draft.length }));
      if (focus === 'none') return;
      const direction = to < from ? 'earlier' : 'later';
      requestAnimationFrame(() => {
        const item = document.querySelector(`[data-widget-id="${id}"]`);
        if (focus === 'grip') {
          item?.querySelector<HTMLButtonElement>('[data-edit-slot="grip"] button')?.focus();
          return;
        }
        const button =
          item?.querySelector<HTMLButtonElement>(`[data-edit-action="${direction}"]:not(:disabled)`) ??
          item?.querySelector<HTMLButtonElement>('[data-edit-action]:not(:disabled)');
        button?.focus();
      });
    },
    [draft, dispatchLayout, t],
  );

  const gridRef = useRef<HTMLDivElement>(null);
  const reorder = useGridReorder({
    containerRef: gridRef,
    count: draft?.length ?? 0,
    enabled: !!draft,
    onMove: (from, to, via) => moveWidget(from, to, via === 'keyboard' ? 'grip' : 'none'),
  });
  const draggedItem = draft && reorder.draggingIndex !== null ? draft[reorder.draggingIndex] : undefined;

  const gridEditing: DashboardGridEditing | undefined = draft
    ? {
        overlay: (item, index) => (
          <WidgetEditOverlay
            item={item}
            index={index}
            count={draft.length}
            onMove={moveWidget}
            onRemove={(removed) => dispatchLayout({ type: 'remove', id: removed.id })}
            onResize={(id, size) => dispatchLayout({ type: 'resize', id, ...size })}
            grip={reorder.grip(index)}
          />
        ),
        placeholder: (item) => <WidgetPlaceholder item={item} />,
        trailing: <AddWidgetTile onClick={() => setShowAddWidget(true)} empty={draft.length === 0} />,
        announcement: moveAnnouncement,
        reorder: {
          draggingIndex: reorder.draggingIndex,
          axis: reorder.axis,
          dropIndicator: reorder.dropIndicator,
          chip: draggedItem ? <WidgetDragChip id={draggedItem.id} positionRef={reorder.chipRef} /> : null,
        },
      }
    : undefined;

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
            onClick={enterEditMode}
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
              portfolioValuation={portfolioValuation}
              hasInvestments={hasInvestments}
              isLoading={isLoading}
              investmentSummaryLoading={investmentSummaryLoading}
              investmentAccounts={portfolioAccounts}
              header={header}
            />
          )}

          {!isDelegateView && <GettingStarted />}

          {draft && (
            <DashboardEditBar
              onAddWidget={() => setShowAddWidget(true)}
              onHeroSettings={() => setShowHeroSettings(true)}
              onReset={() => dispatchLayout({ type: 'reset' })}
              onCancel={layoutDraft.cancel}
              onDone={layoutDraft.save}
              doneDisabled={draft.length === 0}
              saving={layoutDraft.saving}
            />
          )}

          <DashboardGrid ref={gridRef} layout={layout} context={widgetContext} editing={gridEditing} />

          {draft && (
            <>
              <AddWidgetDialog
                isOpen={showAddWidget}
                onClose={() => setShowAddWidget(false)}
                shownIds={draft.map((item) => item.id)}
                onAdd={(id) => dispatchLayout({ type: 'add', id })}
              />
              <UnsavedChangesDialog
                isOpen={layoutDraft.confirmingLeave}
                onSave={layoutDraft.save}
                onDiscard={layoutDraft.discard}
                onCancel={layoutDraft.keepEditing}
              />
            </>
          )}
          {draft && showHeroSettings && (
            <DashboardHeroSettingsModal
              isOpen
              onClose={() => setShowHeroSettings(false)}
              investmentAccounts={portfolioAccounts}
            />
          )}
        </div>
      </main>
    </PageLayout>
  );
}
