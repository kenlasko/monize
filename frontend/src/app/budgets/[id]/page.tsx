'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { BudgetDashboard } from '@/components/budgets/BudgetDashboard';
import { BudgetPeriodSelector } from '@/components/budgets/BudgetPeriodSelector';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { budgetsApi } from '@/lib/budgets';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
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
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [summaryData, velocityData, periodsData, stData] =
        await Promise.all([
          budgetsApi.getSummary(budgetId),
          budgetsApi.getVelocity(budgetId),
          budgetsApi.getPeriods(budgetId),
          scheduledTransactionsApi.getAll(),
        ]);

      setSummary(summaryData);
      setVelocity(velocityData);
      setPeriods(periodsData);
      setScheduledTransactions(stData);
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

  const healthScore = computeHealthScore(summary);

  // For now, daily spending and trend data are computed client-side as empty
  // until report endpoints are available in Phase 6
  const dailySpending: Array<{ date: string; amount: number }> = [];
  const trendData: Array<{ month: string; budgeted: number; actual: number }> = [];

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={summary.budget.name}
          subtitle={`${summary.budget.strategy} budget - ${summary.budget.currencyCode}`}
          actions={
            <div className="flex items-center gap-3">
              <BudgetPeriodSelector
                periods={periods}
                selectedPeriodId={selectedPeriodId}
                onPeriodChange={setSelectedPeriodId}
              />
              <Button
                variant="outline"
                onClick={() => router.push(`/budgets/${budgetId}/edit`)}
              >
                Edit
              </Button>
              <Button variant="outline" onClick={() => router.push('/budgets')}>
                Back
              </Button>
            </div>
          }
        />
        <BudgetDashboard
          summary={summary}
          velocity={velocity}
          scheduledTransactions={scheduledTransactions}
          dailySpending={dailySpending}
          trendData={trendData}
          healthScore={healthScore}
          formatCurrency={(amount) =>
            formatCurrency(amount, summary.budget.currencyCode)
          }
        />
      </main>
    </PageLayout>
  );
}
