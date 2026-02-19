'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { BudgetDashboard } from '@/components/budgets/BudgetDashboard';
import { BudgetPeriodDetail } from '@/components/budgets/BudgetPeriodDetail';
import { BudgetPeriodSelector } from '@/components/budgets/BudgetPeriodSelector';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { budgetsApi } from '@/lib/budgets';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import { STRATEGY_LABELS } from '@/components/budgets/utils/budget-labels';
import type {
  BudgetSummary,
  BudgetVelocity,
  BudgetPeriod,
} from '@/types/budget';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

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

  if (summary.percentUsed > 100) {
    score -= (summary.percentUsed - 100) * 0.8;
  }

  return Math.min(Math.max(Math.round(score), 0), 100);
}

function BudgetDetailContent() {
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
    Array<{ month: string; budgeted: number; actual: number }>
  >([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<BudgetPeriod | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPeriodLoading, setIsPeriodLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [summaryData, velocityData, periodsData, stData, dailyData, trend] =
        await Promise.all([
          budgetsApi.getSummary(budgetId),
          budgetsApi.getVelocity(budgetId),
          budgetsApi.getPeriods(budgetId),
          scheduledTransactionsApi.getAll(),
          budgetsApi.getDailySpending(budgetId).catch(() => []),
          budgetsApi.getTrend(budgetId).catch(() => []),
        ]);

      setSummary(summaryData);
      setVelocity(velocityData);
      setPeriods(periodsData);
      setScheduledTransactions(stData);
      setDailySpending(dailyData);
      setTrendData(trend);
    } catch (err) {
      const message = getErrorMessage(err, 'Failed to load budget');
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [budgetId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
        const message = getErrorMessage(err, 'Failed to load period');
        toast.error(message);
        setSelectedPeriodId(null);
        setSelectedPeriod(null);
      } finally {
        setIsPeriodLoading(false);
      }
    },
    [budgetId, periods],
  );

  const handleDelete = async () => {
    try {
      await budgetsApi.delete(budgetId);
      toast.success('Budget deleted');
      router.push('/budgets');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to delete budget'));
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
      const periodEndVal = summary.budget.periodEnd
        ?? new Date(
          new Date(summary.budget.periodStart + 'T00:00:00').getFullYear(),
          new Date(summary.budget.periodStart + 'T00:00:00').getMonth() + 1,
          0,
        )
          .toISOString()
          .split('T')[0];
      localStorage.setItem('transactions.filter.accountStatus', JSON.stringify('active'));
      const params = new URLSearchParams({
        startDate: summary.budget.periodStart,
        endDate: periodEndVal,
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
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-12 text-center">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
              {error || 'Budget not found'}
            </h3>
            <Button onClick={() => router.push('/budgets')}>
              Back to Budgets
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
        <PageHeader
          title={summary.budget.name}
          subtitle={`${STRATEGY_LABELS[summary.budget.strategy] ?? summary.budget.strategy} budget - ${currencyCode}`}
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
                Edit
              </Button>
              <Button
                variant="danger"
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete
              </Button>
              <Button variant="outline" onClick={() => router.push('/budgets')}>
                Back
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
            formatCurrency={(amount) => formatCurrency(amount, currencyCode)}
            onCategoryClick={handleCategoryClick}
          />
        )}
        <ConfirmDialog
          isOpen={showDeleteConfirm}
          title="Delete Budget"
          message={`Are you sure you want to delete "${summary.budget.name}"? This will remove all budget data including periods and alerts. This action cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      </main>
    </PageLayout>
  );
}
