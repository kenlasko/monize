'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { BudgetDashboard } from '@/components/budgets/BudgetDashboard';
import { BudgetPeriodDetail } from '@/components/budgets/BudgetPeriodDetail';
import { BudgetPeriodSelector } from '@/components/budgets/BudgetPeriodSelector';
import type { BudgetBucketStatusState } from '@/components/budgets/BudgetBucketSummary';
import { BudgetBackLink } from '@/components/budgets/BudgetBackLink';
import { BudgetSwitcher } from '@/components/budgets/BudgetSwitcher';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { budgetsApi } from '@/lib/budgets';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import { STRATEGY_LABELS } from '@/components/budgets/utils/budget-labels';
import type {
  Budget,
  BudgetSummary,
  BudgetVelocity,
  BudgetPeriod,
  BudgetTrendPoint,
} from '@/types/budget';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import { CARD_CLASS } from '@/components/ui/Card';

export default function BudgetDetailPage() {
  return (
    <ProtectedRoute>
      <BudgetDetailContent />
    </ProtectedRoute>
  );
}

function computeHealthScore(summary: BudgetSummary): number {
  let score = 100;
  const expenseCategories = summary.categoryBreakdown.filter((c) => !c.isIncome);

  for (const cat of expenseCategories) {
    if (cat.percentUsed > 100) {
      const overage = cat.percentUsed - 100;
      score -= Math.min(overage * 0.5, 15);
    } else if (cat.percentUsed > 95) {
      score -= 3;
    } else if (cat.percentUsed < 50) {
      score += 1;
    }
  }

  if (summary.percentUsed !== null && summary.percentUsed > 100) {
    score -= (summary.percentUsed - 100) * 0.8;
  }

  return Math.min(Math.max(Math.round(score), 0), 100);
}

function BudgetDetailContent() {
  const t = useTranslations('budgets');
  const tc = useTranslations('common');
  const params = useParams();
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const budgetId = params.id as string;

  const [summary, setSummary] = useState<BudgetSummary | null>(null);
  const [velocity, setVelocity] = useState<BudgetVelocity | null>(null);
  const [periods, setPeriods] = useState<BudgetPeriod[]>([]);
  const [scheduledTransactions, setScheduledTransactions] = useState<
    ScheduledTransaction[]
  >([]);
  const [dailySpending, setDailySpending] = useState<
    Array<{ date: string; amount: number }>
  >([]);
  const [trendData, setTrendData] = useState<
    BudgetTrendPoint[]
  >([]);
  const [bucketStatus, setBucketStatus] = useState<BudgetBucketStatusState>({
    state: 'loading',
  });
  // The newest bucket-status request; a slower, older one (another budget, or
  // an earlier reload) must not land over it.
  const bucketStatusRequest = useRef(0);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<BudgetPeriod | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPeriodLoading, setIsPeriodLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [budgets, setBudgets] = useState<Budget[]>([]);

  // A different budget shows the spinner again; set during render rather than
  // in the effect that loads it.
  const [loadingBudgetId, setLoadingBudgetId] = useState(budgetId);
  if (loadingBudgetId !== budgetId) {
    setLoadingBudgetId(budgetId);
    setIsLoading(true);
    setError(null);
  }

  // The newest page load; a slower, older one (the budget the switcher left,
  // or an earlier reload) must not land over it.
  const loadRequest = useRef(0);

  // The mount / budget-switch load: the state already says loading.
  const fetchData = useCallback(() => {
    const load = ++loadRequest.current;
    const isCurrentLoad = () => loadRequest.current === load;
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const summaryRequest = budgetsApi.getSummary(budgetId);
        // Only a Bucket budget has a bucket status. It needs only the summary,
        // so it starts as soon as the summary answers rather than after the
        // slowest of the page's reads, and never fails the page: its own card
        // says the request failed.
        void summaryRequest
          .then((summaryData) => {
            if (!isCurrentLoad() || summaryData.budget.strategy !== 'BUCKET') return;
            const request = ++bucketStatusRequest.current;
            const isCurrent = () => bucketStatusRequest.current === request;
            setBucketStatus({ state: 'loading' });
            budgetsApi
              .getBucketStatus(budgetId)
              .then((data) => {
                if (isCurrent()) setBucketStatus({ state: 'ready', data });
              })
              .catch(() => {
                if (isCurrent()) setBucketStatus({ state: 'error' });
              });
          })
          // The summary's own failure is reported by the page load below.
          .catch(() => undefined);

        const [summaryData, velocityData, periodsData, stData, dailyData, trend] =
          await Promise.all([
            summaryRequest,
            budgetsApi.getVelocity(budgetId),
            budgetsApi.getPeriods(budgetId),
            scheduledTransactionsApi.getAll(),
            budgetsApi.getDailySpending(budgetId).catch(() => []),
            budgetsApi.getTrend(budgetId).catch(() => []),
          ]);
        if (!isCurrentLoad()) return;

        setSummary(summaryData);
        setVelocity(velocityData);
        setPeriods(periodsData);
        setScheduledTransactions(stData);
        setDailySpending(dailyData);
        setTrendData(trend);
      } catch (err) {
        if (!isCurrentLoad()) return;
        const message = getErrorMessage(err, t('pages.detail.toasts.loadFailed'));
        setError(message);
        toast.error(message);
      } finally {
        if (isCurrentLoad()) setIsLoading(false);
      }
    };
    return run();
  }, [budgetId, t]);

  const loadData = useCallback(() => {
    setIsLoading(true);
    setError(null);
    return fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // The switcher's list. It simply does not render without one; the page is
  // fine either way, so a failure here is not the page's error.
  useEffect(() => {
    let cancelled = false;
    budgetsApi
      .getAll()
      .then((list) => {
        if (!cancelled) setBudgets(list);
      })
      .catch(() => {
        if (!cancelled) setBudgets([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useOnUndoRedo(loadData);
  // Refresh on AI chat-bubble writes (actual spending can change).
  useOnAiAction(loadData);

  const handlePeriodChange = useCallback(
    async (periodId: string | null) => {
      setSelectedPeriodId(periodId);

      if (periodId === null) {
        setSelectedPeriod(null);
        return;
      }

      const period = periods.find((p) => p.id === periodId);
      if (period?.status === 'OPEN') {
        setSelectedPeriod(null);
        return;
      }

      setIsPeriodLoading(true);
      try {
        const periodDetail = await budgetsApi.getPeriodDetail(budgetId, periodId);
        setSelectedPeriod(periodDetail);
      } catch (err) {
        const message = getErrorMessage(err, t('pages.detail.toasts.periodFailed'));
        toast.error(message);
        setSelectedPeriodId(null);
        setSelectedPeriod(null);
      } finally {
        setIsPeriodLoading(false);
      }
    },
    [budgetId, periods, t],
  );

  const handleDelete = async () => {
    try {
      await budgetsApi.delete(budgetId);
      toast.success(t('pages.detail.toasts.deleted'));
      router.push('/budgets');
    } catch (err) {
      toast.error(getErrorMessage(err, t('pages.detail.toasts.deleteFailed')));
      setShowDeleteConfirm(false);
    }
  };

  const handleCategoryClick = useCallback(
    (budgetCategoryId: string) => {
      if (!summary) return;
      const cat = summary.categoryBreakdown.find(
        (c) => c.budgetCategoryId === budgetCategoryId,
      );
      if (!cat?.categoryId) return;
      localStorage.setItem('transactions.filter.accountStatus', JSON.stringify('active'));
      const params = new URLSearchParams({
        startDate: summary.periodStart,
        endDate: summary.periodEnd,
        categoryIds: cat.categoryId,
      });
      router.push(`/transactions?${params.toString()}`);
    },
    [summary, router],
  );

  if (isLoading) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <LoadingSpinner />
        </main>
      </PageLayout>
    );
  }

  if (error || !summary || !velocity) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div className={`${CARD_CLASS} p-12 text-center`}>
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
              {error || t('pages.detail.notFound')}
            </h3>
            <Button onClick={() => router.push('/budgets')}>
              {t('pages.detail.backToBudgets')}
            </Button>
          </div>
        </main>
      </PageLayout>
    );
  }

  const isViewingHistoricalPeriod = selectedPeriod !== null && selectedPeriod.status !== 'OPEN';
  const currencyCode = summary.budget.currencyCode;
  const healthScore = computeHealthScore(summary);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <BudgetBackLink href="/budgets" label={t('pages.detail.backToBudgets')} />
        <PageHeader
          title={summary.budget.name}
          titleAdornment={
            <BudgetSwitcher
              currentId={budgetId}
              budgets={budgets}
              onSelect={(id) => router.push(`/budgets/${id}`)}
            />
          }
          subtitle={`${STRATEGY_LABELS[summary.budget.strategy] ?? summary.budget.strategy} budget - ${currencyCode}`}
          help="budgets"
          actions={
            <div className="flex items-center gap-3">
              <BudgetPeriodSelector
                periods={periods}
                selectedPeriodId={selectedPeriodId}
                onPeriodChange={handlePeriodChange}
              />
              <Button
                variant="outline"
                onClick={() => router.push(`/budgets/${budgetId}/edit`)}
              >
                {tc('edit')}
              </Button>
              <Button
                variant="danger"
                onClick={() => setShowDeleteConfirm(true)}
              >
                {tc('delete')}
              </Button>
            </div>
          }
        />
        {isPeriodLoading ? (
          <LoadingSpinner />
        ) : isViewingHistoricalPeriod ? (
          <BudgetPeriodDetail
            period={selectedPeriod}
            formatCurrency={(amount) => formatCurrency(amount, currencyCode)}
          />
        ) : (
          <BudgetDashboard
            summary={summary}
            velocity={velocity}
            scheduledTransactions={scheduledTransactions}
            dailySpending={dailySpending}
            trendData={trendData}
            healthScore={healthScore}
            bucketStatus={bucketStatus}
            displayCurrency={currencyCode}
            // A bare amount is the budget's currency; a row that knows its own
            // currency says so, because an occurrence's amount is in the
            // occurrence's currency (issue #1247).
            formatCurrency={(amount, code) =>
              formatCurrency(amount, code ?? currencyCode)
            }
            onCategoryClick={handleCategoryClick}
          />
        )}
        <ConfirmDialog
          isOpen={showDeleteConfirm}
          title={t('pages.detail.delete.title')}
          message={t('pages.detail.delete.message', { name: summary.budget.name })}
          confirmLabel={t('pages.detail.delete.confirm')}
          cancelLabel={tc('cancel')}
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      </main>
    </PageLayout>
  );
}
