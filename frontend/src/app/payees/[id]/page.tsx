'use client';

import { ReportingBasisScope, ReportingBasisControl, useReportingBasis, useReportingRouter, CashReportingNotice } from '@/components/reports/ReportingBasis';
import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { PayeeDetailHeader } from '@/components/payees/detail/PayeeDetailHeader';
import { PayeeSummaryCards } from '@/components/payees/detail/PayeeSummaryCards';
import { PayeeKeyInfoCard } from '@/components/payees/detail/PayeeKeyInfoCard';
import { PayeeRecurringPanel } from '@/components/payees/detail/PayeeRecurringPanel';
import { PayeeSeasonalityPanel } from '@/components/payees/detail/PayeeSeasonalityPanel';
import { TopGroupsPanel } from '@/components/accounts/shared/TopGroupsPanel';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReactivatePayeeDialog } from '@/components/payees/ReactivatePayeeDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { payeesApi } from '@/lib/payees';
import { transactionsApi } from '@/lib/transactions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { categoriesApi } from '@/lib/categories';
import { getNextScheduled } from '@/lib/scheduled-utils';
import { buildCategoryColorMap,
  buildCategoryIconMap, buildCategoryLabelMap } from '@/lib/categoryUtils';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  buildDisplayCurrencyStrategy,
  summarizeInDisplayCurrency,
  aggregateGroupedTotals,
} from '@/components/transactions/widget-shared';
import type { Payee, PayeeDetail, UpdatePayeeData } from '@/types/payee';
import type { PayeeFormSubmitData } from '@/components/payees/PayeeForm';
import type { Category } from '@/types/category';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type {
  GroupedTotal,
  MonthlyTotal,
  RecurringChargeInfo,
  TransactionSummary,
} from '@/types/transaction';
import type {
  PayeePeriodTotals,
  PayeeRecurringSummary,
} from '@/components/payees/detail/PayeeSummaryCards';

const logger = createLogger('PayeeDetail');

const PayeeForm = dynamic(
  () =>
    import('@/components/payees/PayeeForm').then((m) => ({
      default: m.PayeeForm,
    })),
  { ssr: false },
);

const MergePayeeDialog = dynamic(
  () =>
    import('@/components/payees/MergePayeeDialog').then((m) => ({
      default: m.MergePayeeDialog,
    })),
  { ssr: false },
);

const PayeeAliasManager = dynamic(
  () =>
    import('@/components/payees/PayeeAliasManager').then((m) => ({
      default: m.PayeeAliasManager,
    })),
  { ssr: false },
);

const PayeeTransactionsTab = dynamic(
  () =>
    import('@/components/payees/detail/PayeeTransactionsTab').then((m) => ({
      default: m.PayeeTransactionsTab,
    })),
  { ssr: false },
);

const CategoryPayeeBarChart = dynamic(
  () =>
    import('@/components/transactions/CategoryPayeeBarChart').then((m) => ({
      default: m.CategoryPayeeBarChart,
    })),
  { ssr: false },
);

const TAB_KEYS = ['overview', 'transactions', 'aliases'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/** `?tab=` if it names a real tab, so a link can point at one. */
function tabFromQuery(value: string | null): TabKey {
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : 'overview';
}

/** Cadences the recurring detector can report that mean an actual rhythm. */
const CADENCE_KEYS = new Set(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);

/** Local `yyyy-MM-dd` for an offset in days from today. */
function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

/** The analytics the page composes from the generic, payee-filterable endpoints. */
interface PayeeAnalytics {
  lifetimeSummary: TransactionSummary | null;
  thisYearSummary: TransactionSummary | null;
  lastYearSummary: TransactionSummary | null;
  monthlyTotals: MonthlyTotal[];
  /** Trailing 12 months, the default range for the Top Categories panel. */
  categoryTotals: GroupedTotal[];
  /** The same breakdown over the payee's whole history. */
  categoryTotalsAllTime: GroupedTotal[];
  recurringCharges: RecurringChargeInfo[];
}

/** Which window the Top Categories panel is showing. */
type CategoryRange = 'year' | 'all';
const CATEGORY_RANGES: readonly CategoryRange[] = ['year', 'all'];

export default function PayeeDetailPage() {
  const viewQuery = useSearchParams();
  const initialBasis = viewQuery.get('basis') === 'cash' ? 'cash' : viewQuery.get('basis') === 'accrual' ? 'accrual' : undefined;
  const params = useParams();
  return (
    <ProtectedRoute>
      <ReportingBasisScope initialBasis={initialBasis} resetOnBasis surface={`payees:${params.id}`}><PayeeDetailContent /></ReportingBasisScope>
    </ProtectedRoute>
  );
}

function PayeeDetailContent() {
  const basis = useReportingBasis();
  const t = useTranslations('payeeDetail');
  // The edit modal reuses the payees list's form, heading and toasts.
  const tp = useTranslations('payees');
  const params = useParams();
  const router = useRouter();
  const reportingRouter = useReportingRouter();
  const searchParams = useSearchParams();
  const payeeId = params.id as string;

  const { convertToDefault, defaultCurrency } = useExchangeRates();

  const [detail, setDetail] = useState<PayeeDetail | null>(null);
  const [analytics, setAnalytics] = useState<PayeeAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every reload so panels that fetch their own data refetch too.
  const [refreshKey, setRefreshKey] = useState(0);
  // Read once, from the link that opened the page; later changes are the user's.
  const [tab, setTab] = useState<TabKey>(() => tabFromQuery(searchParams.get('tab')));
  const [categoryRange, setCategoryRange] = useState<CategoryRange>('year');
  const [isMerging, setIsMerging] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [isReactivating, setIsReactivating] = useState(false);
  const [isTogglePending, setIsTogglePending] = useState(false);
  const [isApplyingDefault, setIsApplyingDefault] = useState(false);
  // Supporting data; a failure costs its feature, never the page.
  const [payees, setPayees] = useState<Payee[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTransaction[]>([]);

  const {
    showForm,
    openEdit,
    close,
    editingItem,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<Payee>();

  // Switching payees shows the spinner again; set during render rather than in
  // the effect that loads the new one.
  const [loadingId, setLoadingId] = useState(payeeId);
  if (loadingId !== payeeId) {
    setLoadingId(payeeId);
    setIsLoading(true);
    setError(null);
  }

  // The mount / payee-switch load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        // The detail is the page; the analytics feed the cards and panels, so a
        // failure in any of them costs its panel, never the page.
        const detailData = await payeesApi.getDetail(payeeId);

        const today = isoDaysAgo(0);
        const yearAgo = isoDaysAgo(365);
        const thisYearStart = `${today.slice(0, 4)}-01-01`;
        const lastYearStart = `${Number(today.slice(0, 4)) - 1}-01-01`;
        const lastYearSameDate = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;

        const [
          lifetimeSummary,
          thisYearSummary,
          lastYearSummary,
          monthlyTotals,
          categoryTotals,
          categoryTotalsAllTime,
          recurringCharges,
        ] = await Promise.all([
          transactionsApi.getSummary({ basis, payeeIds: [payeeId] }),
          transactionsApi
            .getSummary({ basis, payeeIds: [payeeId], startDate: thisYearStart, endDate: today })
            ,
          transactionsApi
            .getSummary({ basis,
              payeeIds: [payeeId],
              startDate: lastYearStart,
              endDate: lastYearSameDate,
            })
            ,
          // No date range: the chart covers the payee's whole history, and its
          // own granularity control buckets by quarter or year once that history
          // outgrows monthly bars. A window here would silently hide the years
          // before it, which is the opposite of what a detail page is for.
          transactionsApi
            .getMonthlyTotals({ basis, payeeIds: [payeeId] })
            ,
          transactionsApi
            .getGroupedTotals({ basis,
              groupBy: 'category',
              payeeIds: [payeeId],
              startDate: yearAgo,
              endDate: today,
              limit: 25,
            })
            ,
          // Both ranges are fetched up front so the Top Categories toggle is
          // instant. They are two cheap grouped queries, and switching range is a
          // comparison -- putting a spinner between the two halves of it would
          // make the comparison harder than the request is expensive.
          transactionsApi
            .getGroupedTotals({ basis,
              groupBy: 'category',
              payeeIds: [payeeId],
              limit: 25,
            })
            ,
          transactionsApi
            .getRecurringCharges({ payeeIds: [payeeId], startDate: yearAgo, endDate: today })
            .catch(() => [] as RecurringChargeInfo[]),
        ]);

        setDetail(detailData);
        setAnalytics({
          lifetimeSummary,
          thisYearSummary,
          lastYearSummary,
          monthlyTotals,
          categoryTotals,
          categoryTotalsAllTime,
          recurringCharges,
        });
        setRefreshKey((key) => key + 1);
      } catch (err) {
        logger.error(err);
        setError(getErrorMessage(err, t('loadFailed')));
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [payeeId, t, basis]);

  const loadData = useCallback(() => {
    setIsLoading(true);
    setError(null);
    return fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Supporting data, loaded once: the switcher and merge dialog need the payee
  // list, the edit form needs categories, the recurring panel the schedules.
  useEffect(() => {
    let cancelled = false;
    payeesApi
      .getAll('all')
      .then((list) => {
        if (!cancelled) setPayees(list);
      })
      .catch(() => {
        if (!cancelled) setPayees([]);
      });
    categoriesApi
      .getAll()
      .then((list) => {
        if (!cancelled) setCategories(list);
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });
    scheduledTransactionsApi
      .getAll()
      .then((list) => {
        if (!cancelled) setScheduled(list);
      })
      .catch(() => {
        if (!cancelled) setScheduled([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useOnUndoRedo(loadData);
  useOnAiAction(loadData);

  const currencyStrategy = useMemo(
    () =>
      buildDisplayCurrencyStrategy(
        analytics?.lifetimeSummary ?? null,
        defaultCurrency,
        convertToDefault,
      ),
    [analytics?.lifetimeSummary, defaultCurrency, convertToDefault],
  );

  const isMultiCurrency =
    Object.keys(analytics?.lifetimeSummary?.byCurrency ?? {}).length > 1;

  const toTotals = useCallback(
    (summary: TransactionSummary | null): PayeePeriodTotals | null =>
      summary ? summarizeInDisplayCurrency(summary, currencyStrategy) : null,
    [currencyStrategy],
  );

  const lifetimeTotals = useMemo(
    () => toTotals(analytics?.lifetimeSummary ?? null),
    [analytics?.lifetimeSummary, toTotals],
  );
  const thisYearTotals = useMemo(
    () => toTotals(analytics?.thisYearSummary ?? null),
    [analytics?.thisYearSummary, toTotals],
  );
  const lastYearTotals = useMemo(
    () => toTotals(analytics?.lastYearSummary ?? null),
    [analytics?.lastYearSummary, toTotals],
  );

  // The dominant detected cadence, as the transactions-page widget picks it.
  const recurringSummary = useMemo<PayeeRecurringSummary | null>(() => {
    const best = [...(analytics?.recurringCharges ?? [])]
      .filter((charge) => CADENCE_KEYS.has(charge.frequency))
      .sort((a, b) => b.dates.length - a.dates.length)[0];
    return best
      ? {
          cadence: best.frequency,
          amount: best.currentAmount,
          previousAmount: best.previousAmount,
        }
      : null;
  }, [analytics?.recurringCharges]);

  const categoryLabelMap = useMemo(() => buildCategoryLabelMap(categories), [categories]);
  const categoryColorMap = useMemo(() => buildCategoryColorMap(categories), [categories]);
  const categoryIconMap = useMemo(() => buildCategoryIconMap(categories), [categories]);

  // Category rows aggregated across currencies into the display currency, with
  // the hierarchy-aware labels the rest of the app uses.
  const categoryPanelTotals = useMemo<{ rows: GroupedTotal[]; excludedCount: number }>(() => {
    const source =
      categoryRange === 'all'
        ? (analytics?.categoryTotalsAllTime ?? [])
        : (analytics?.categoryTotals ?? []);
    // A row whose total could not be converted is dropped rather than drawn: a
    // bar has no way to say "unknown", and a zero-width one reads as a measured
    // zero (docs/frontend/financial-figures.md). Count the dropped rows so the panel marks the
    // bars as a subtotal.
    const aggregated = aggregateGroupedTotals(source, currencyStrategy);
    const rows = aggregated
      .filter((row): row is typeof row & { total: number } => row.total !== null)
      .map((row) => ({
        id: row.id,
        name: row.id ? (categoryLabelMap.get(row.id) ?? row.name) : row.name,
        currencyCode: currencyStrategy.displayCurrency,
        total: row.total,
        count: row.count,
      }));
    return { rows, excludedCount: aggregated.length - rows.length };
  }, [
    analytics?.categoryTotals,
    analytics?.categoryTotalsAllTime,
    categoryRange,
    currencyStrategy,
    categoryLabelMap,
  ]);

  // One row per account, converted so the bars stay comparable.
  const accountPanelTotals = useMemo<{ rows: GroupedTotal[]; excludedCount: number }>(() => {
    const accounts = detail?.accounts ?? [];
    const rows = accounts
      .map((row) => ({
        id: row.accountId,
        name: row.accountName,
        currencyCode: currencyStrategy.displayCurrency,
        total: currencyStrategy.toDisplay(row.total, row.currencyCode),
        count: row.transactionCount,
      }))
      // Same reasoning as the category panel: no rate, no bar.
      .filter((row): row is typeof row & { total: number } => row.total !== null);
    return { rows, excludedCount: accounts.length - rows.length };
  }, [detail?.accounts, currencyStrategy]);

  const nextBill = useMemo(
    () =>
      detail
        ? getNextScheduled(
            scheduled,
            (st) =>
              st.payeeId === detail.payee.id ||
              (!st.payeeId && st.payeeName === detail.payee.name),
          )
        : null,
    [scheduled, detail],
  );

  // Every link out of this page goes to the register filtered to this payee.
  //
  // `accountStatus=all` is not optional here: the register prunes selected
  // accounts against its stored Show Accounts toggle, and when that toggle is
  // "active" it also scopes an unfiltered query to the open accounts only. A
  // payee's history is a lifetime of it, so without this a payment made from an
  // account since closed simply vanishes -- and the account row for that closed
  // account would link to an empty list. Same reasoning as the Institutions
  // page and `ai-entity-links.ts`, which pass it for the same reason.
  const goToRegister = useCallback(
    (query: Record<string, string> = {}, recognized = false) => {
      const search = new URLSearchParams({
        payeeId,
        accountStatus: 'all',
        ...query,
      });
      if (!recognized && !search.has('basis') && basis) search.set('basis', basis);
      (recognized ? reportingRouter : router).push(`/transactions?${search.toString()}`);
    },
    [basis, router, reportingRouter, payeeId],
  );

  // Stable, so the memoized chart is not re-rendered by unrelated page state
  // (the Top Categories range, say). A re-render replays the bars' entry
  // animation, and Recharts hides their value labels until it finishes.
  const handleMonthClick = useCallback(
    (startDate: string, endDate: string) => goToRegister({ startDate, endDate }, true),
    [goToRegister],
  );

  const handleEditSubmit = useCallback(
    async (data: PayeeFormSubmitData) => {
      try {
        const { pendingAliases: _pendingAliases, ...formData } = data;
        // An empty category selection clears the default (null), matching the
        // payees list page's submit handling.
        const cleaned = {
          ...formData,
          defaultCategoryId:
            formData.defaultCategoryId === '' || formData.defaultCategoryId === undefined
              ? null
              : formData.defaultCategoryId,
          notes: formData.notes || undefined,
        } as UpdatePayeeData;
        const updated = await payeesApi.update(payeeId, cleaned);
        toast.success(tp('page.toasts.updated'));
        const categorized = updated.transactionsCategorized ?? 0;
        if (categorized > 0) {
          toast.success(tp('page.toasts.categorized', { count: categorized }));
        }
        close();
        await loadData();
      } catch (err) {
        toast.error(getErrorMessage(err, tp('page.toasts.updateFailed')));
        // Rethrown so the form keeps the user's input and its error state.
        throw err;
      }
    },
    [payeeId, close, loadData, tp],
  );

  const handleDeactivate = useCallback(async () => {
    if (!detail) return;
    setIsDeactivating(false);
    setIsTogglePending(true);
    try {
      await payeesApi.update(detail.payee.id, { isActive: false });
      toast.success(t('toasts.deactivated', { name: detail.payee.name }));
      await loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, t('toasts.deactivateFailed')));
    } finally {
      setIsTogglePending(false);
    }
  }, [detail, loadData, t]);

  const handleReactivate = useCallback(async () => {
    if (!detail) return;
    setIsReactivating(false);
    setIsTogglePending(true);
    try {
      const reactivated = await payeesApi.reactivatePayee(detail.payee.id);
      toast.success(t('toasts.reactivated', { name: reactivated.name }));
      await loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, t('toasts.reactivateFailed')));
    } finally {
      setIsTogglePending(false);
    }
  }, [detail, loadData, t]);

  // The Uncategorized card: with a default category, one confirm applies it to
  // the uncategorized backlog (the update endpoint's backfill); without one,
  // the edit form opens to pick a category first.
  const handleUncategorizedClick = useCallback(() => {
    if (!detail) return;
    if (detail.payee.defaultCategoryId) {
      setIsApplyingDefault(true);
    } else {
      openEdit(detail.payee);
    }
  }, [detail, openEdit]);

  const handleApplyDefault = useCallback(async () => {
    if (!detail?.payee.defaultCategoryId) return;
    setIsApplyingDefault(false);
    try {
      const updated = await payeesApi.update(detail.payee.id, {
        defaultCategoryId: detail.payee.defaultCategoryId,
        applyCategoryToTransactions: 'uncategorized',
      });
      toast.success(
        t('applyDefault.applied', { count: updated.transactionsCategorized ?? 0 }),
      );
      await loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, t('applyDefault.failed')));
    }
  }, [detail, loadData, t]);

  if (isLoading) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <ReportingBasisControl detail />
          <LoadingSpinner text={t('loading')} />
        </main>
      </PageLayout>
    );
  }

  if (error || !detail) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <ReportingBasisControl detail />
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
              <Button onClick={() => router.push('/payees')}>{t('backToPayees')}</Button>
            </div>
          </div>
        </main>
      </PageLayout>
    );
  }

  const { payee } = detail;
  const tabs = TAB_KEYS.map((key) => ({ key, label: t(`tabs.${key}`) }));

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PayeeDetailHeader
          payee={payee}
          firstTransactionDate={detail.stats.firstTransactionDate}
          onBack={() => router.push('/payees')}
          onViewTransactions={() => goToRegister()}
          onEdit={() => openEdit(payee)}
          onMerge={() => setIsMerging(true)}
          onToggleActive={() =>
            payee.isActive ? setIsDeactivating(true) : setIsReactivating(true)
          }
          isTogglePending={isTogglePending}
          payees={payees}
          onSelectPayee={(id) => router.push(`/payees/${id}`)}
        />

        <ReportingBasisControl detail />
        <div className="space-y-6">
          <PayeeSummaryCards
            detail={detail}
            lifetimeTotals={lifetimeTotals}
            thisYearTotals={thisYearTotals}
            lastYearTotals={lastYearTotals}
            recurring={recurringSummary}
            currencyStrategy={currencyStrategy}
            isMultiCurrency={isMultiCurrency}
            onUncategorizedClick={handleUncategorizedClick}
          />

          <div>
            <Tabs
              tabs={tabs}
              value={tab}
              onChange={setTab}
              idPrefix="payeeDetail"
              ariaLabel={t('tabs.ariaLabel')}
            />

            {/* A floor under the panel area, so switching tabs cannot shorten
                the document and drop the reader back at the top. */}
            <div className="min-h-[36rem]">
              <TabPanel
                idPrefix="payeeDetail"
                tabKey="overview"
                isActive={tab === 'overview'}
                className="mt-6 space-y-6"
              >
                {/* Two thirds chart, one third reference facts -- the same
                    division as the security detail page. */}
                <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
                  <div className="lg:col-span-2">
                    <CategoryPayeeBarChart
                      data={analytics?.monthlyTotals ?? []}
                      isLoading={false}
                      onMonthClick={handleMonthClick}
                      filterLabel={payee.name}
                    />
                  </div>
                  <div>
                  <CashReportingNotice />
                  <PayeeKeyInfoCard
                    detail={detail}
                    categoryLabelMap={categoryLabelMap}
                    // The largest transaction narrows the register to its own
                    // day, so the row it names is the one on screen.
                    onSelectDate={(date) =>
                      goToRegister({ startDate: date, endDate: date, basis: 'cash' })
                    }
                    onSelectAccount={(accountId) =>
                      router.push(`/accounts/${accountId}`)
                    }
                    onContactLookedUp={loadData}
                  />
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <TopGroupsPanel
                    title={t('topCategories.title')}
                    subtitle={t(
                      categoryRange === 'all'
                        ? 'topCategories.subtitleAllTime'
                        : 'topCategories.subtitle',
                    )}
                    emptyLabel={t(
                      categoryRange === 'all'
                        ? 'topCategories.emptyAllTime'
                        : 'topCategories.empty',
                    )}
                    fallbackLabel={t('topCategories.uncategorized')}
                    totals={categoryPanelTotals.rows}
                    excludedCount={categoryPanelTotals.excludedCount}
                    currencyCode={currencyStrategy.displayCurrency}
                    isLoading={false}
                    onSelect={(categoryId) =>
                      goToRegister(
                        categoryId
                          ? {
                              categoryId,
                              // The register opens on the range the panel was
                              // showing, so the figure clicked is the figure
                              // the list adds up to.
                              ...(categoryRange === 'year'
                                ? { startDate: isoDaysAgo(365), endDate: isoDaysAgo(0) }
                                : {}),
                            }
                          : {}, true,
                      )
                    }
                    selectableWhenUnidentified
                    headerAction={
                      <DateRangeSelector
                        ranges={CATEGORY_RANGES}
                        labels={{
                          year: t('topCategories.range12m'),
                          all: t('topCategories.rangeAll'),
                        }}
                        value={categoryRange}
                        onChange={(range) => setCategoryRange(range as CategoryRange)}
                        size="sm"
                      />
                    }
                  />
                  <TopGroupsPanel
                    title={t('accountsPanel.title')}
                    subtitle={t('accountsPanel.subtitle')}
                    emptyLabel={t('accountsPanel.empty')}
                    fallbackLabel={t('accountsPanel.title')}
                    totals={accountPanelTotals.rows}
                    excludedCount={accountPanelTotals.excludedCount}
                    currencyCode={currencyStrategy.displayCurrency}
                    isLoading={false}
                    onSelect={(accountId) =>
                      goToRegister(accountId ? { accountId } : {})
                    }
                  />
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <PayeeRecurringPanel
                    charges={analytics?.recurringCharges ?? []}
                    nextBill={nextBill}
                    currencyStrategy={currencyStrategy}
                    isLoading={false}
                  />
                  <PayeeSeasonalityPanel
                    monthly={analytics?.monthlyTotals ?? []}
                    currencyStrategy={currencyStrategy}
                    isLoading={false}
                  />
                </div>
              </TabPanel>

              <TabPanel
                idPrefix="payeeDetail"
                tabKey="transactions"
                isActive={tab === 'transactions'}
                // Holds its own fetched rows: unmounting would refetch and
                // replay the loading state on every return to the tab.
                keepMounted
                className="mt-6"
              >
                <PayeeTransactionsTab
                  key={basis}
                  basis={basis}
                  payeeId={payee.id}
                  refreshKey={refreshKey}
                  categoryLabelMap={categoryLabelMap}
                  categoryColorMap={categoryColorMap}
                  categoryIconMap={categoryIconMap}
                  onChanged={loadData}
                  onViewInRegister={() => goToRegister()}
                  onSelectDate={(date) =>
                    goToRegister({ startDate: date, endDate: date })
                  }
                />
              </TabPanel>

              <TabPanel
                idPrefix="payeeDetail"
                tabKey="aliases"
                isActive={tab === 'aliases'}
                keepMounted
                className="mt-6"
              >
                <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
                  <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
                    {t('aliasesTab.description')}
                  </p>
                  <PayeeAliasManager payeeId={payee.id} />
                </div>
              </TabPanel>
            </div>
          </div>
        </div>

        {/* The same edit form the payees list opens, so a payee is edited one
            way wherever you reach it from. */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" className="p-6">
          <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {tp('page.modalTitleEdit')}
          </h2>
          {showForm && (
            <PayeeForm
              payee={editingItem}
              categories={categories}
              onSubmit={handleEditSubmit}
              onCancel={close}
              onDirtyChange={setFormDirty}
              submitRef={formSubmitRef}
            />
          )}
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* Merging deletes this payee into the target, so success leaves the page. */}
        {isMerging && (
          <MergePayeeDialog
            isOpen={isMerging}
            sourcePayee={payee}
            allPayees={payees}
            onClose={() => setIsMerging(false)}
            onSuccess={() => router.push('/payees')}
          />
        )}

        <ConfirmDialog
          isOpen={isDeactivating}
          variant="warning"
          title={t('deactivate.confirmTitle')}
          message={t('deactivate.confirmMessage', { name: payee.name })}
          confirmLabel={t('deactivate.confirmButton')}
          onConfirm={handleDeactivate}
          onCancel={() => setIsDeactivating(false)}
        />

        <ReactivatePayeeDialog
          isOpen={isReactivating}
          payee={payee}
          onReactivate={handleReactivate}
          onCancel={() => setIsReactivating(false)}
          isReactivating={isTogglePending}
        />

        <ConfirmDialog
          isOpen={isApplyingDefault}
          variant="info"
          title={t('applyDefault.confirmTitle')}
          message={t('applyDefault.confirmMessage', {
            category: payee.defaultCategory?.name ?? '',
            count: detail.stats.uncategorizedCount,
            name: payee.name,
          })}
          confirmLabel={t('applyDefault.confirmButton')}
          onConfirm={handleApplyDefault}
          onCancel={() => setIsApplyingDefault(false)}
        />
      </main>
    </PageLayout>
  );
}
