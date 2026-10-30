'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { SecurityDetailHeader } from '@/components/securities/detail/SecurityDetailHeader';
import { SecuritySummaryCards } from '@/components/securities/detail/SecuritySummaryCards';
import { SecurityPositionState } from '@/components/securities/detail/SecurityPositionState';
import { SecurityChartSection } from '@/components/securities/detail/SecurityChartSection';
import { SecurityKeyInformation } from '@/components/securities/detail/SecurityKeyInformation';
import { SecurityAboutCard } from '@/components/securities/detail/SecurityAboutCard';
import { SecurityPerformanceCard } from '@/components/securities/detail/SecurityPerformanceCard';
import { SecurityPositionInfoCard } from '@/components/securities/detail/SecurityPositionInfoCard';
import { SecurityAccountsTable } from '@/components/securities/detail/SecurityAccountsTable';
import { SecurityBondBreakdownCard } from '@/components/securities/detail/SecurityBondBreakdownCard';
import { SecurityBreakdownCard } from '@/components/securities/detail/SecurityBreakdownCard';
import { SecurityBondCard } from '@/components/securities/detail/SecurityBondCard';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { BondRefreshProgress } from '@/components/securities/BondRefreshProgress';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import { SECURITY_PRICE_HISTORY_LIMIT } from '@/lib/constants';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { roundToDecimals } from '@/lib/format';
import {
  toPriceSeries,
  buildQuantitySteps,
  type SecurityChartMode,
} from '@/lib/security-detail';
import type {
  CreateSecurityData,
  Security,
  SecurityDetail,
  SecurityPrice,
  SecurityHistoryTransaction,
} from '@/types/investment';

const SecurityForm = dynamic(
  () =>
    import('@/components/securities/SecurityForm').then((m) => ({
      default: m.SecurityForm,
    })),
  { ssr: false },
);

const SecurityTransactionHistory = dynamic(
  () =>
    import('@/components/securities/SecurityTransactionHistory').then((m) => ({
      default: m.SecurityTransactionHistory,
    })),
  { ssr: false },
);

const SecurityPriceHistory = dynamic(
  () =>
    import('@/components/securities/SecurityPriceHistory').then((m) => ({
      default: m.SecurityPriceHistory,
    })),
  { ssr: false },
);

const SecurityBondTermsTab = dynamic(
  () =>
    import('@/components/securities/detail/SecurityBondTermsTab').then((m) => ({
      default: m.SecurityBondTermsTab,
    })),
  { ssr: false },
);

const SecurityDocumentsTab = dynamic(
  () =>
    import('@/components/securities/detail/SecurityDocumentsTab').then((m) => ({
      default: m.SecurityDocumentsTab,
    })),
  { ssr: false },
);

const SecurityNewsTab = dynamic(
  () =>
    import('@/components/securities/detail/SecurityNewsTab').then((m) => ({
      default: m.SecurityNewsTab,
    })),
  { ssr: false },
);

const TAB_KEYS = [
  'overview',
  'transactions',
  'prices',
  'terms',
  'documents',
  'news',
] as const;
type TabKey = (typeof TAB_KEYS)[number];

/**
 * A program-linked security gets the terms history in place of the Price
 * history tab (its manual prices sit under the terms); every other security
 * has the reverse. A tab the security does not have falls back to Overview.
 */
function tabKeysFor(isBond: boolean): readonly TabKey[] {
  return TAB_KEYS.filter((key) => key !== (isBond ? 'prices' : 'terms'));
}

/** `?tab=` if it names a real tab, so a link can point at one. */
function tabFromQuery(value: string | null): TabKey {
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : 'overview';
}

export default function SecurityDetailPage() {
  return (
    <ProtectedRoute>
      <SecurityDetailContent />
    </ProtectedRoute>
  );
}

function SecurityDetailContent() {
  const t = useTranslations('securityDetail');
  // The edit modal reuses the securities list's form, heading and toasts.
  const ts = useTranslations('securities');
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const securityId = params.id as string;

  const [detail, setDetail] = useState<SecurityDetail | null>(null);
  const [prices, setPrices] = useState<SecurityPrice[]>([]);
  const [trades, setTrades] = useState<SecurityHistoryTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Read once, from the link that opened the page: the dashboard's price
  // widgets point straight at the Price history tab. Later tab changes are the
  // user's, so this is an initial value rather than a synced one.
  const [tab, setTab] = useState<TabKey>(() =>
    tabFromQuery(searchParams.get('tab')),
  );
  const [chartMode, setChartMode] = useState<SecurityChartMode>('price');
  const [isEditing, setIsEditing] = useState(false);
  const [isFavouritePending, setIsFavouritePending] = useState(false);
  // Only for the caret beside the name; a failure costs the switcher, not the page.
  const [securities, setSecurities] = useState<Security[]>([]);

  // The security on screen right now, readable from inside an in-flight load.
  // The switcher moves between securities on the same route (`router.push`
  // below), so this component stays mounted and a load started for the previous
  // one can still be running. Assigned in a layout effect, before any effect
  // or response can read it, so it is never a commit behind the id the page is
  // currently showing.
  const shownIdRef = useRef(securityId);
  useLayoutEffect(() => {
    shownIdRef.current = securityId;
  });

  // Switching securities shows the spinner again; set during render rather
  // than in the effect that loads the new one.
  const [loadingId, setLoadingId] = useState(securityId);
  if (loadingId !== securityId) {
    setLoadingId(securityId);
    setIsLoading(true);
    setError(null);
  }

  // The mount / security-switch load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      const requestedId = securityId;
      // Every write below is guarded on the page still showing the security this
      // load was started for. Without it a slow response for the previous
      // security lands after the new one's and paints its figures under the new
      // URL -- the reader sees another instrument's position, and nothing looks
      // wrong until they reload.
      const isStale = () => shownIdRef.current !== requestedId;

      try {
        // The detail is the page; prices and trades feed the chart and its
        // markers, so a failure in either costs the chart, never the page.
        const detailData = await investmentsApi.getSecurityDetail(requestedId);
        const [priceData, historyData] = await Promise.all([
          investmentsApi
            .getSecurityPrices(requestedId, { limit: SECURITY_PRICE_HISTORY_LIMIT })
            .catch(() => []),
          investmentsApi
            .getSecurityTransactionHistory(requestedId)
            .catch(() => null),
        ]);
        if (isStale()) return;
        setDetail(detailData);
        setPrices(priceData);
        setTrades(historyData?.transactions ?? []);
      } catch (err) {
        if (isStale()) return;
        const message = getErrorMessage(err, t('loadFailed'));
        setError(message);
      } finally {
        // A stale load must not clear the spinner the current one put up.
        if (!isStale()) setIsLoading(false);
      }
    };
    return run();
  }, [securityId, t]);

  const loadData = useCallback(() => {
    setIsLoading(true);
    setError(null);
    return fetchData();
  }, [fetchData]);

  // After a price refresh the quote and the market-value cards are stale, but
  // the page is already on screen -- reload in place rather than through
  // loadData, whose spinner would blank everything the user was reading.
  const reloadAfterPriceRefresh = useCallback(async () => {
    const requestedId = securityId;
    try {
      const [detailData, priceData] = await Promise.all([
        investmentsApi.getSecurityDetail(requestedId),
        investmentsApi
          .getSecurityPrices(requestedId, { limit: SECURITY_PRICE_HISTORY_LIMIT })
          .catch(() => null),
      ]);
      // Same guard as loadData: a refresh that resolves after the reader moved
      // on must not write the old security's quote onto the new page.
      if (shownIdRef.current !== requestedId) return;
      setDetail(detailData);
      if (priceData) setPrices(priceData);
    } catch {
      // The refresh itself already reported its own outcome; a failed re-read
      // leaves the previous figures up, which is better than an error page.
    }
  }, [securityId]);

  const {
    isRefreshing: isRefreshingPrice,
    triggerManualRefresh: refreshPrices,
  } = usePriceRefresh({ onRefreshComplete: reloadAfterPriceRefresh });

  // One signal for every bond section that loads its own data: bumped when a
  // price refresh settles (success, failure or nothing to do), so each re-reads
  // the series, offer and catalog the refresh may have changed, in place and
  // without remounting (which would reset the as-of date, scenario and tab).
  const [bondDataVersion, setBondDataVersion] = useState(0);
  const [wasRefreshingPrice, setWasRefreshingPrice] = useState(false);
  if (wasRefreshingPrice !== isRefreshingPrice) {
    setWasRefreshingPrice(isRefreshingPrice);
    if (!isRefreshingPrice) setBondDataVersion((v) => v + 1);
  }

  const handleRefreshPrice = useCallback(() => {
    void refreshPrices([securityId]);
  }, [refreshPrices, securityId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    let cancelled = false;
    investmentsApi
      .getSecurities()
      .then((list) => {
        if (!cancelled) setSecurities(list);
      })
      // The switcher simply does not render without a list; the page is fine.
      .catch(() => {
        if (!cancelled) setSecurities([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useOnUndoRedo(loadData);
  useOnAiAction(loadData);

  const priceSeries = useMemo(() => toPriceSeries(prices), [prices]);
  const quantitySteps = useMemo(() => buildQuantitySteps(trades), [trades]);

  // The newest close, plus the server's daily move (`detail.dailyChange`, from
  // `resolveDailyPriceChange`). A refusal is null: the header then shows the
  // newest session's date and no change figure. A move for another session
  // than the newest close shown (a stale read) is not shown under it.
  const serverChange = detail?.dailyChange ?? null;
  const financialToday = useFinancialToday();
  const quote = useMemo(() => {
    const latest = priceSeries[priceSeries.length - 1];
    if (!latest) return null;
    const move =
      serverChange && serverChange.priceDate === latest.date
        ? serverChange
        : null;
    return {
      price: latest.close,
      priceDate: latest.date,
      // When the provider told us the moment, the header shows it. Rows
      // predating the column, manual entries and transaction-derived prices
      // have none, and fall back to the date alone.
      quotedAt: latest.quotedAt ?? null,
      change: move ? roundToDecimals(move.dailyChange, 6) : null,
      changePercent: move ? roundToDecimals(move.dailyChangePercent, 2) : null,
      // The server accepts the last session's move too (Friday's close read on
      // Saturday), so only today's own session is labelled "today".
      isCurrent: move ? move.priceDate === financialToday : false,
    };
  }, [priceSeries, serverChange, financialToday]);

  const handleToggleFavourite = useCallback(async () => {
    if (!detail) return;
    const next = !detail.security.isFavourite;
    setIsFavouritePending(true);
    try {
      await investmentsApi.setSecurityFavourite(detail.security.id, next);
      setDetail((current) =>
        current
          ? { ...current, security: { ...current.security, isFavourite: next } }
          : current,
      );
      toast.success(
        next ? t('toasts.favouriteAdded') : t('toasts.favouriteRemoved'),
      );
    } catch (err) {
      toast.error(getErrorMessage(err, t('toasts.favouriteFailed')));
    } finally {
      setIsFavouritePending(false);
    }
  }, [detail, t]);

  const handleEditSubmit = useCallback(
    async (data: CreateSecurityData) => {
      try {
        await investmentsApi.updateSecurity(securityId, data);
        toast.success(ts('page.toasts.updated'));
        setIsEditing(false);
        await loadData();
      } catch (err) {
        toast.error(getErrorMessage(err, ts('page.toasts.updateFailed')));
        // Rethrown so the form keeps the user's input and its error state.
        throw err;
      }
    },
    [securityId, loadData, ts],
  );

  if (isLoading) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <LoadingSpinner text={t('loading')} />
        </main>
      </PageLayout>
    );
  }

  if (error || !detail) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div
            role="alert"
            className="rounded-lg bg-white p-12 text-center shadow dark:bg-gray-800"
          >
            <h3 className="mb-2 text-lg font-medium text-gray-900 dark:text-gray-100">
              {error || t('notFound')}
            </h3>
            <div className="flex justify-center gap-3">
              {error && (
                <Button variant="outline" onClick={loadData}>
                  {t('error.retry')}
                </Button>
              )}
              <Button onClick={() => router.push('/securities')}>
                {t('backToSecurities')}
              </Button>
            </div>
          </div>
        </main>
      </PageLayout>
    );
  }

  const { security } = detail;
  const isBond = !!security.bondProgramId;
  const tabKeys = tabKeysFor(isBond);
  const tabs = tabKeys.map((key) => ({ key, label: t(`tabs.${key}`) }));
  // A stale `?tab=prices` on a bond (or `?tab=terms` elsewhere) shows Overview.
  const activeTab: TabKey = tabKeys.includes(tab) ? tab : 'overview';

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <SecurityDetailHeader
          security={security}
          quote={quote}
          onBack={() => router.push('/securities')}
          onEdit={() => setIsEditing(true)}
          onToggleFavourite={handleToggleFavourite}
          isFavouritePending={isFavouritePending}
          onRefreshPrice={handleRefreshPrice}
          isRefreshingPrice={isRefreshingPrice}
          securities={securities}
          onSelectSecurity={(id) => router.push(`/securities/${id}`)}
        />

        <BondRefreshProgress
          programId={security.bondProgramId ?? null}
          active={isRefreshingPrice && !!security.bondProgramId}
        />

        <div className="space-y-6">
          {/* Zero-filled cards would claim a position that is not there, so a
              closed or never-held security gets its own panel instead. The tour
              anchor sits on the cards only: with no position there is nothing
              for that step to point at, and it says so instead. */}
          {detail.accounts.length > 0 ? (
            <div {...tourAnchor(TOUR_ANCHORS.securityDetailSummary)}>
              <SecuritySummaryCards
                detail={detail}
                // The Investments page already accepts `?accountId=`; the
                // Accounts list links to it the same way.
                onSelectAccount={(accountId) =>
                  router.push(`/investments?accountId=${accountId}`)
                }
              />
            </div>
          ) : (
            <SecurityPositionState detail={detail} />
          )}

          {/* Two thirds chart, one third a column of two cards: what the
              instrument is, and what it is made of. The chart runs tall so the
              column has the room, and the breakdown's bars are capped and
              scrollable so an eleven-sector fund cannot outgrow it.
              `items-stretch` lets the column reach the row's full height, but the
              row is only ever as tall as its tallest item -- so the cap on the
              bars is what keeps this column from being that item. */}
          <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-3">
            <div
              className="lg:col-span-2"
              {...tourAnchor(TOUR_ANCHORS.securityDetailChart)}
            >
              <SecurityChartSection
                security={security}
                prices={priceSeries}
                quantitySteps={quantitySteps}
                trades={trades}
                isLoading={false}
                mode={chartMode}
                onModeChange={setChartMode}
              />
            </div>
            {/* A column the height of the chart: Key information takes what it
                needs and Breakdown fills the rest, so the two end level with the
                chart rather than stopping short of it. */}
            <div
              className="flex min-h-0 flex-col gap-6"
              {...tourAnchor(TOUR_ANCHORS.securityDetailKeyInfo)}
            >
              <SecurityKeyInformation
                security={security}
                latestPrice={
                  quote
                    ? { price: quote.price, priceDate: quote.priceDate }
                    : null
                }
                prices={priceSeries}
                refreshVersion={bondDataVersion}
              />
              {security.bondProgramId ? (
                <SecurityBondBreakdownCard
                  security={security}
                  refreshVersion={bondDataVersion}
                />
              ) : (
                <SecurityBreakdownCard security={security} />
              )}
            </div>
          </div>

          <div>
            <div {...tourAnchor(TOUR_ANCHORS.securityDetailTabs)}>
              <Tabs
                tabs={tabs}
                value={activeTab}
                onChange={setTab}
                idPrefix="securityDetail"
                ariaLabel={t('tabs.ariaLabel')}
              />
            </div>

            {/* A floor under the panel area, so switching tabs cannot shorten
                the document. Overview is much taller than the two tables, and
                when the page shrank under the scroll position the browser
                clamped it -- which landed the reader back at the top, having
                only meant to change tab. */}
            <div className="min-h-[36rem]">
              <TabPanel
                idPrefix="securityDetail"
                tabKey="overview"
                isActive={activeTab === 'overview'}
                className="mt-6 space-y-6"
              >
                {/* One height across the row: the three cards hold different
                    amounts, so the short ones gain blank space at the bottom,
                    which reads better than three boxes ending at three
                    different heights (review of discussion #964). */}
                <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-5">
                  <div className="lg:col-span-2 h-full">
                    <SecurityAboutCard security={security} />
                  </div>
                  <div className="lg:col-span-1 h-full">
                    <SecurityPerformanceCard prices={priceSeries} />
                  </div>
                  <div className="lg:col-span-2 h-full">
                    <SecurityPositionInfoCard detail={detail} />
                  </div>
                </div>

                {security.bondProgramId && (
                  <SecurityBondCard
                    security={security}
                    onPricesChanged={reloadAfterPriceRefresh}
                    refreshVersion={bondDataVersion}
                  />
                )}

                <SecurityAccountsTable detail={detail} />
              </TabPanel>

              <TabPanel
                idPrefix="securityDetail"
                tabKey="transactions"
                isActive={activeTab === 'transactions'}
                // Holds its own fetched rows: unmounting would refetch and replay
                // the loading state on every return to the tab.
                keepMounted
                className="mt-6"
              >
                <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
                  <SecurityTransactionHistory security={security} onChanged={loadData} />
                </div>
              </TabPanel>

              {isBond ? (
                <TabPanel
                  idPrefix="securityDetail"
                  tabKey="terms"
                  isActive={activeTab === 'terms'}
                  keepMounted
                  className="mt-6"
                >
                  <SecurityBondTermsTab
                    security={security}
                    refreshVersion={bondDataVersion}
                  />
                  {/* The only place to enter a price by hand; the engine never
                      replaces one (INV-BOND-005), so a linked bond keeps it. */}
                  <section className="mt-6">
                    <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {t('bondPrices.title')}
                    </h2>
                    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
                      <SecurityPriceHistory
                        security={security}
                        onPricesChanged={reloadAfterPriceRefresh}
                      />
                    </div>
                  </section>
                </TabPanel>
              ) : (
                <TabPanel
                  idPrefix="securityDetail"
                  tabKey="prices"
                  isActive={activeTab === 'prices'}
                  keepMounted
                  className="mt-6"
                >
                  <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
                    <SecurityPriceHistory
                      security={security}
                      onPricesChanged={reloadAfterPriceRefresh}
                    />
                  </div>
                </TabPanel>
              )}

              <TabPanel
                idPrefix="securityDetail"
                tabKey="documents"
                isActive={activeTab === 'documents'}
                // Loads its own list, so it keeps it between visits.
                keepMounted
                className="mt-6"
              >
                <SecurityDocumentsTab
                  security={security}
                  refreshVersion={bondDataVersion}
                />
              </TabPanel>

              <TabPanel
                idPrefix="securityDetail"
                tabKey="news"
                isActive={activeTab === 'news'}
                keepMounted
                className="mt-6"
              >
                <SecurityNewsTab security={security} />
              </TabPanel>
            </div>
          </div>
        </div>

        {/* The same edit form the securities list opens, so a security is edited
            one way wherever you reach it from. */}
        <Modal
          isOpen={isEditing}
          onClose={() => setIsEditing(false)}
          maxWidth="3xl"
          className="p-6"
          pushHistory
        >
          {isEditing && (
            <>
              <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">
                {ts('page.modalTitleEdit')}
              </h2>
              <SecurityForm
                security={security}
                onSubmit={handleEditSubmit}
                onCancel={() => setIsEditing(false)}
              />
            </>
          )}
        </Modal>
      </main>
    </PageLayout>
  );
}
