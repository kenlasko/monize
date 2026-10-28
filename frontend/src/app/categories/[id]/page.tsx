'use client';

import { ReportingBasisScope, ReportingBasisControl, useReportingBasis, useReportingRouter, CashReportingNotice } from '@/components/reports/ReportingBasis';
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { CategoryDetailHeader } from '@/components/categories/detail/CategoryDetailHeader';
import { CategorySummaryCards } from '@/components/categories/detail/CategorySummaryCards';
import { CategoryKeyInfoCard } from '@/components/categories/detail/CategoryKeyInfoCard';
import { SubcategoryBreakdownPanel } from '@/components/categories/detail/SubcategoryBreakdownPanel';
import { CategoryScheduledPanel } from '@/components/categories/detail/CategoryScheduledPanel';
import { CategoryTagBreakdownPanel } from '@/components/categories/detail/CategoryTagBreakdownPanel';
import { CategorySubcategoriesTab } from '@/components/categories/detail/CategorySubcategoriesTab';
import { SeasonalityPanel } from '@/components/accounts/shared/SeasonalityPanel';
import { TopGroupsPanel } from '@/components/accounts/shared/TopGroupsPanel';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { DeleteCategoryDialog } from '@/components/categories/DeleteCategoryDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { categoriesApi } from '@/lib/categories';
import { transactionsApi } from '@/lib/transactions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { tagsApi } from '@/lib/tags';
import { collectTagKeys } from '@/lib/tag-key-value';
import { getUpcomingScheduled } from '@/lib/scheduled-utils';
import {
  buildCategoryColorMap,
  buildCategoryIconMap,
  buildCategoryLabelMap,
  buildDescendantIdSet,
  rollupToDirectChildren,
} from '@/lib/categoryUtils';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  buildDisplayCurrencyStrategy,
  summarizeInDisplayCurrency,
  aggregateGroupedTotals,
} from '@/components/transactions/widget-shared';
import type { Category, CategoryDetail, UpdateCategoryData } from '@/types/category';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Tag } from '@/types/tag';
import type {
  GroupedTotal,
  MonthlyTotal,
  TransactionSummary,
} from '@/types/transaction';
import type { CategoryPeriodTotals } from '@/components/categories/detail/CategorySummaryCards';

const logger = createLogger('CategoryDetail');

const CategoryForm = dynamic(
  () =>
    import('@/components/categories/CategoryForm').then((m) => ({
      default: m.CategoryForm,
    })),
  { ssr: false },
);

const CategoryTransactionsTab = dynamic(
  () =>
    import('@/components/categories/detail/CategoryTransactionsTab').then((m) => ({
      default: m.CategoryTransactionsTab,
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

const TAB_KEYS = ['overview', 'transactions', 'subcategories'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/** `?tab=` if it names a real tab, so a link can point at one. */
function tabFromQuery(value: string | null): TabKey {
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : 'overview';
}

/** Local `yyyy-MM-dd` for an offset in days from today. */
function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

/** How many upcoming scheduled items the panel lists. */
const SCHEDULED_LIMIT = 5;

/** The analytics the page composes from the generic, category-filterable endpoints. */
interface CategoryAnalytics {
  lifetimeSummary: TransactionSummary | null;
  thisYearSummary: TransactionSummary | null;
  lastYearSummary: TransactionSummary | null;
  monthlyTotals: MonthlyTotal[];
  /** Trailing 12 months, the default range for the Top Payees panel. */
  payeeTotals: GroupedTotal[];
  /** The same breakdown over the category's whole history. */
  payeeTotalsAllTime: GroupedTotal[];
  /** Per-leaf category totals over the whole history, for the subtree rollup. */
  categoryTotalsAllTime: GroupedTotal[];
}

/** Which window the Top Payees panel is showing. */
type PayeeRange = 'year' | 'all';
const PAYEE_RANGES: readonly PayeeRange[] = ['year', 'all'];

export default function CategoryDetailPage() {
  const viewQuery = useSearchParams();
  const initialBasis = viewQuery.get('basis') === 'cash' ? 'cash' : viewQuery.get('basis') === 'accrual' ? 'accrual' : undefined;
  const params = useParams();
  return (
    <ProtectedRoute>
      <ReportingBasisScope initialBasis={initialBasis} resetOnBasis surface={`categories:${params.id}`}><CategoryDetailContent /></ReportingBasisScope>
    </ProtectedRoute>
  );
}

function CategoryDetailContent() {
  const basis = useReportingBasis();
  const t = useTranslations('categoryDetail');
  // The edit modal and delete dialog reuse the categories list's form and toasts.
  const tc = useTranslations('categories');
  const params = useParams();
  const router = useRouter();
  const reportingRouter = useReportingRouter();
  const searchParams = useSearchParams();
  const categoryId = params.id as string;

  const { convertToDefault, defaultCurrency } = useExchangeRates();

  const [detail, setDetail] = useState<CategoryDetail | null>(null);
  const [analytics, setAnalytics] = useState<CategoryAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every reload so panels that fetch their own data refetch too.
  const [refreshKey, setRefreshKey] = useState(0);
  // Read once, from the link that opened the page; later changes are the user's.
  const [tab, setTab] = useState<TabKey>(() => tabFromQuery(searchParams.get('tab')));
  const [payeeRange, setPayeeRange] = useState<PayeeRange>('year');
  const [isDeleting, setIsDeleting] = useState(false);
  // Supporting data; a failure costs its feature, never the page.
  const [categories, setCategories] = useState<Category[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTransaction[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);

  const {
    showForm,
    openEdit,
    close,
    editingItem,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<Category>();

  // The category on screen right now, readable from inside an in-flight load.
  // The switcher moves between categories on the same route (`router.push`
  // below), so this component stays mounted and a load started for the previous
  // one can still be running. Assigned in a layout effect, before any effect
  // or response can read it, so it is never a commit behind the id the page is
  // currently showing.
  const shownIdRef = useRef(categoryId);
  useLayoutEffect(() => {
    shownIdRef.current = categoryId;
  });

  // Switching categories shows the spinner again; set during render rather
  // than in the effect that loads the new one.
  const [loadingId, setLoadingId] = useState(categoryId);
  if (loadingId !== categoryId) {
    setLoadingId(categoryId);
    setIsLoading(true);
    setError(null);
  }

  // The mount / category-switch load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      const requestedId = categoryId;
      // Every write below is guarded on the page still showing the category this
      // load was started for. Without it a slow response for the previous
      // category lands after the new one's and paints its figures under the new
      // URL -- the reader sees another category's spending, and nothing looks
      // wrong until they reload.
      const isStale = () => shownIdRef.current !== requestedId;

      try {
        // The detail is the page; the analytics feed the cards and panels, so a
        // failure in any of them costs its panel, never the page.
        const detailData = await categoriesApi.getDetail(requestedId);

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
          payeeTotals,
          payeeTotalsAllTime,
          categoryTotalsAllTime,
        ] = await Promise.all([
          transactionsApi.getSummary({ basis, categoryIds: [requestedId] }),
          transactionsApi
            .getSummary({ basis,
              categoryIds: [requestedId],
              startDate: thisYearStart,
              endDate: today,
            })
            ,
          transactionsApi
            .getSummary({ basis,
              categoryIds: [requestedId],
              startDate: lastYearStart,
              endDate: lastYearSameDate,
            })
            ,
          // No date range: the chart covers the category's whole history, and its
          // own granularity control buckets by quarter or year once that history
          // outgrows monthly bars. A window here would silently hide the years
          // before it, which is the opposite of what a detail page is for.
          transactionsApi
            .getMonthlyTotals({ basis, categoryIds: [requestedId] })
            ,
          transactionsApi
            .getGroupedTotals({ basis,
              groupBy: 'payee',
              categoryIds: [requestedId],
              startDate: yearAgo,
              endDate: today,
              limit: 25,
            })
            ,
          // Both ranges are fetched up front so the Top Payees toggle is
          // instant. They are two cheap grouped queries, and switching range is a
          // comparison -- putting a spinner between the two halves of it would
          // make the comparison harder than the request is expensive.
          transactionsApi
            .getGroupedTotals({ basis,
              groupBy: 'payee',
              categoryIds: [requestedId],
              limit: 25,
            })
            ,
          // One all-time call feeds both the overview's subcategory breakdown
          // and the Subcategories tab, which show the same rollup.
          transactionsApi
            .getGroupedTotals({ basis,
              groupBy: 'category',
              categoryIds: [requestedId],
              limit: 100,
            })
            ,
        ]);

        if (isStale()) return;
        setDetail(detailData);
        setAnalytics({
          lifetimeSummary,
          thisYearSummary,
          lastYearSummary,
          monthlyTotals,
          payeeTotals,
          payeeTotalsAllTime,
          categoryTotalsAllTime,
        });
        setRefreshKey((key) => key + 1);
      } catch (err) {
        if (isStale()) return;
        logger.error(err);
        setError(getErrorMessage(err, t('loadFailed')));
      } finally {
        // A stale load must not clear the spinner the current one put up.
        if (!isStale()) setIsLoading(false);
      }
    };
    return run();
  }, [categoryId, t, basis]);

  const loadData = useCallback(() => {
    setIsLoading(true);
    setError(null);
    return fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Supporting data, loaded once: the switcher, label maps and subcategory
  // rollups need the category list, the scheduled panel the schedules, the
  // tag panel the tag names.
  useEffect(() => {
    let cancelled = false;
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
    tagsApi
      .getAll()
      .then((list) => {
        if (!cancelled) setTags(list);
      })
      .catch(() => {
        if (!cancelled) setTags([]);
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
    (summary: TransactionSummary | null): CategoryPeriodTotals | null =>
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

  const categoryLabelMap = useMemo(() => buildCategoryLabelMap(categories), [categories]);
  const categoryColorMap = useMemo(() => buildCategoryColorMap(categories), [categories]);
  const categoryIconMap = useMemo(() => buildCategoryIconMap(categories), [categories]);

  // Payee rows aggregated across currencies into the display currency. A row
  // with no rate has an unknown magnitude and cannot be ranked in a bar panel,
  // so it is left out rather than counted as a zero -- and counted so the panel
  // can say the bars are a subtotal.
  const payeePanelTotals = useMemo<{ rows: GroupedTotal[]; excludedCount: number }>(() => {
    const source =
      payeeRange === 'all'
        ? (analytics?.payeeTotalsAllTime ?? [])
        : (analytics?.payeeTotals ?? []);
    const aggregated = aggregateGroupedTotals(source, currencyStrategy);
    const rows = aggregated.flatMap((row) =>
      row.total === null
        ? []
        : [
            {
              id: row.id,
              name: row.name,
              currencyCode: currencyStrategy.displayCurrency,
              total: row.total,
              count: row.count,
            },
          ],
    );
    return { rows, excludedCount: aggregated.length - rows.length };
  }, [
    analytics?.payeeTotals,
    analytics?.payeeTotalsAllTime,
    payeeRange,
    currencyStrategy,
  ]);

  // One row per account, converted so the bars stay comparable.
  const accountPanelTotals = useMemo<{ rows: GroupedTotal[]; excludedCount: number }>(() => {
    const accounts = detail?.accounts ?? [];
    const rows = accounts.flatMap((row) => {
      // Unconvertible accounts have an unknown magnitude and are left out of
      // the ranked bars rather than shown as zero.
      const total = currencyStrategy.toDisplay(row.total, row.currencyCode);
      return total === null
        ? []
        : [
            {
              id: row.accountId,
              name: row.accountName,
              currencyCode: currencyStrategy.displayCurrency,
              total,
              count: row.transactionCount,
            },
          ];
    });
    return { rows, excludedCount: accounts.length - rows.length };
  }, [detail?.accounts, currencyStrategy]);

  // The subtree rollup both the overview panel and the Subcategories tab show.
  const subcategoryShares = useMemo(
    () =>
      rollupToDirectChildren(
        aggregateGroupedTotals(analytics?.categoryTotalsAllTime ?? [], currencyStrategy),
        categories,
        categoryId,
      ),
    [analytics?.categoryTotalsAllTime, currencyStrategy, categories, categoryId],
  );

  // Upcoming schedules in this category or its subtree. The backend expands
  // descendants for the analytics queries; this predicate is the client-side
  // twin for the locally-held schedule list.
  const upcomingScheduled = useMemo(() => {
    const descendantIds = buildDescendantIdSet(categories, categoryId);
    return getUpcomingScheduled(
      scheduled,
      (st) => (st.categoryId ? descendantIds.has(st.categoryId) : false),
      SCHEDULED_LIMIT,
    );
  }, [scheduled, categories, categoryId]);

  const tagKeys = useMemo(() => collectTagKeys(tags.map((tag) => tag.name)), [tags]);

  const parentName = useMemo(() => {
    const parentId = detail?.category.parentId;
    return parentId ? (categories.find((c) => c.id === parentId)?.name ?? null) : null;
  }, [detail?.category.parentId, categories]);

  const hasChildren = categories.some((c) => c.parentId === categoryId);

  // The Subcategories tab exists only when there are subcategories -- unlike
  // the payee page's aliases tab, which hosts an add flow and is useful empty,
  // an empty subcategory list has nothing to do. A `?tab=subcategories` link
  // to a leaf falls back to the overview.
  const availableTabs = useMemo<TabKey[]>(
    () => TAB_KEYS.filter((key) => key !== 'subcategories' || hasChildren),
    [hasChildren],
  );
  const activeTab: TabKey = availableTabs.includes(tab) ? tab : 'overview';

  // Every link out of this page goes to the register filtered to this category.
  //
  // `accountStatus=all` is not optional here: the register prunes selected
  // accounts against its stored Show Accounts toggle, and when that toggle is
  // "active" it also scopes an unfiltered query to the open accounts only. A
  // category's history is a lifetime of it, so without this a payment made from
  // an account since closed simply vanishes. Same reasoning as the payee detail
  // page, which passes it for the same reason.
  const goToRegister = useCallback(
    (query: Record<string, string> = {}, recognized = false) => {
      const search = new URLSearchParams({
        categoryId,
        accountStatus: 'all',
        ...query,
      });
      if (!recognized && !search.has('basis') && basis) search.set('basis', basis);
      (recognized ? reportingRouter : router).push(`/transactions?${search.toString()}`);
    },
    [basis, router, reportingRouter, categoryId],
  );

  // Stable, so the memoized chart is not re-rendered by unrelated page state
  // (the Top Payees range, say). A re-render replays the bars' entry
  // animation, and Recharts hides their value labels until it finishes.
  const handleMonthClick = useCallback(
    (startDate: string, endDate: string) => goToRegister({ startDate, endDate }, true),
    [goToRegister],
  );

  const handleEditSubmit = useCallback(
    async (data: UpdateCategoryData & Record<string, unknown>) => {
      try {
        // Blank optional fields clear their columns, matching the categories
        // list page's submit handling.
        const cleaned = {
          ...data,
          parentId: data.parentId || null,
          description: data.description || null,
          icon: data.icon || null,
          color: data.color || null,
        } as UpdateCategoryData;
        await categoriesApi.update(categoryId, cleaned);
        toast.success(tc('toasts.updated'));
        close();
        await loadData();
      } catch (err) {
        toast.error(getErrorMessage(err, tc('toasts.updateFailed')));
        // Rethrown so the form keeps the user's input and its error state.
        throw err;
      }
    },
    [categoryId, close, loadData, tc],
  );

  // The same reassign-then-delete flow the categories list runs; success
  // leaves the page, since the category it described no longer exists.
  const handleConfirmDelete = useCallback(
    async (reassignToCategoryId: string | null) => {
      try {
        const count = await categoriesApi.getTransactionCount(categoryId);
        if (count > 0) {
          await categoriesApi.reassignTransactions(categoryId, reassignToCategoryId);
        }
        await categoriesApi.delete(categoryId);
        toast.success(tc('toasts.deleted'));
        router.push('/categories');
      } catch (err) {
        toast.error(getErrorMessage(err, tc('toasts.deleteFailed')));
        logger.error(err);
      } finally {
        setIsDeleting(false);
      }
    },
    [categoryId, router, tc],
  );

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
              <Button onClick={() => router.push('/categories')}>
                {t('backToCategories')}
              </Button>
            </div>
          </div>
        </main>
      </PageLayout>
    );
  }

  const { category } = detail;
  const tabs = availableTabs.map((key) => ({ key, label: t(`tabs.${key}`) }));

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <CategoryDetailHeader
          category={category}
          parentName={parentName}
          firstTransactionDate={detail.stats.firstTransactionDate}
          onBack={() => router.push('/categories')}
          onViewTransactions={() => goToRegister()}
          onEdit={() => openEdit(category)}
          onDelete={() => setIsDeleting(true)}
          categories={categories}
          onSelectCategory={(id) => router.push(`/categories/${id}`)}
        />

        <ReportingBasisControl detail />
        <div className="space-y-6">
          <CategorySummaryCards
            detail={detail}
            lifetimeTotals={lifetimeTotals}
            thisYearTotals={thisYearTotals}
            lastYearTotals={lastYearTotals}
            monthlyTotals={analytics?.monthlyTotals ?? []}
            currencyStrategy={currencyStrategy}
            isMultiCurrency={isMultiCurrency}
            onTransactionsClick={() => setTab('transactions')}
          />

          <div>
            <Tabs
              tabs={tabs}
              value={activeTab}
              onChange={setTab}
              idPrefix="categoryDetail"
              ariaLabel={t('tabs.ariaLabel')}
            />

            {/* A floor under the panel area, so switching tabs cannot shorten
                the document and drop the reader back at the top. */}
            <div className="min-h-[36rem]">
              <TabPanel
                idPrefix="categoryDetail"
                tabKey="overview"
                isActive={activeTab === 'overview'}
                className="mt-6 space-y-6"
              >
                {/* Two thirds chart, one third reference facts -- the same
                    division as the payee and security detail pages. */}
                <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
                  <div className="lg:col-span-2">
                    <CategoryPayeeBarChart
                      data={analytics?.monthlyTotals ?? []}
                      isLoading={false}
                      onMonthClick={handleMonthClick}
                      filterLabel={category.name}
                    />
                  </div>
                  <div>
                  <CashReportingNotice />
                  <CategoryKeyInfoCard
                    detail={detail}
                    parentName={parentName}
                    onSelectParent={() =>
                      category.parentId && router.push(`/categories/${category.parentId}`)
                    }
                    // The largest transaction narrows the register to its own
                    // day, so the row it names is the one on screen.
                    onSelectDate={(date) =>
                      goToRegister({ startDate: date, endDate: date, basis: 'cash' })
                    }
                    onSelectPayee={(payeeId) => router.push(`/payees/${payeeId}`)}
                  />
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <TopGroupsPanel
                    title={t('topPayees.title')}
                    subtitle={t(
                      payeeRange === 'all'
                        ? 'topPayees.subtitleAllTime'
                        : 'topPayees.subtitle',
                    )}
                    emptyLabel={t(
                      payeeRange === 'all' ? 'topPayees.emptyAllTime' : 'topPayees.empty',
                    )}
                    fallbackLabel={t('topPayees.noPayee')}
                    totals={payeePanelTotals.rows}
                    excludedCount={payeePanelTotals.excludedCount}
                    currencyCode={currencyStrategy.displayCurrency}
                    isLoading={false}
                    onSelect={(payeeId) =>
                      goToRegister(
                        payeeId
                          ? {
                              payeeId,
                              // The register opens on the range the panel was
                              // showing, so the figure clicked is the figure
                              // the list adds up to.
                              ...(payeeRange === 'year'
                                ? { startDate: isoDaysAgo(365), endDate: isoDaysAgo(0) }
                                : {}),
                            }
                          : {}, true,
                      )
                    }
                    headerAction={
                      <DateRangeSelector
                        ranges={PAYEE_RANGES}
                        labels={{
                          year: t('topPayees.range12m'),
                          all: t('topPayees.rangeAll'),
                        }}
                        value={payeeRange}
                        onChange={(range) => setPayeeRange(range as PayeeRange)}
                        size="sm"
                      />
                    }
                  />
                  <SubcategoryBreakdownPanel
                    shares={subcategoryShares}
                    currencyCode={currencyStrategy.displayCurrency}
                    isLoading={false}
                    onSelectChild={(id) => router.push(`/categories/${id}`)}
                  />
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
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
                  <CategoryScheduledPanel items={upcomingScheduled} isLoading={false} />
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <SeasonalityPanel
                    monthly={analytics?.monthlyTotals ?? []}
                    currencyStrategy={currencyStrategy}
                    isLoading={false}
                    namespace="categoryDetail"
                  />
                  {tagKeys.length > 0 && (
                    <CategoryTagBreakdownPanel
                      categoryId={categoryId}
                      tagKeys={tagKeys}
                      refreshKey={refreshKey}
                    />
                  )}
                </div>
              </TabPanel>

              <TabPanel
                idPrefix="categoryDetail"
                tabKey="transactions"
                isActive={activeTab === 'transactions'}
                // Holds its own fetched rows: unmounting would refetch and
                // replay the loading state on every return to the tab.
                keepMounted
                className="mt-6"
              >
                <CategoryTransactionsTab
                  key={basis}
                  basis={basis}
                  categoryId={category.id}
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

              {hasChildren && (
                <TabPanel
                  idPrefix="categoryDetail"
                  tabKey="subcategories"
                  isActive={activeTab === 'subcategories'}
                  keepMounted
                  className="mt-6"
                >
                  <CategorySubcategoriesTab
                    category={category}
                    categories={categories}
                    shares={subcategoryShares}
                    currencyCode={currencyStrategy.displayCurrency}
                    onSelectChild={(id) => router.push(`/categories/${id}`)}
                  />
                </TabPanel>
              )}
            </div>
          </div>
        </div>

        {/* The same edit form the categories list opens, so a category is
            edited one way wherever you reach it from. */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" className="p-6">
          <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {tc('page.modalTitleEdit')}
          </h2>
          {showForm && editingItem && (
            <CategoryForm
              category={editingItem}
              categories={categories}
              onSubmit={handleEditSubmit}
              onCancel={close}
              onDirtyChange={setFormDirty}
              submitRef={formSubmitRef}
            />
          )}
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        <DeleteCategoryDialog
          isOpen={isDeleting}
          category={category}
          categories={categories}
          onConfirm={handleConfirmDelete}
          onCancel={() => setIsDeleting(false)}
        />
      </main>
    </PageLayout>
  );
}
