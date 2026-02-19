'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { budgetsApi } from '@/lib/budgets';
import { DashboardBudgetSummary } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  budgetPercentColor,
  budgetProgressBarColor,
  budgetCategoryBarColor,
} from '@/components/budgets/utils/budget-colors';

interface BudgetStatusWidgetProps {
  isLoading: boolean;
}

export function BudgetStatusWidget({ isLoading: parentLoading }: BudgetStatusWidgetProps) {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const [summary, setSummary] = useState<DashboardBudgetSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (parentLoading) return;

    const loadBudgetSummary = async () => {
      try {
        const data = await budgetsApi.getDashboardSummary();
        setSummary(data);
      } catch {
        setHasError(true);
      } finally {
        setIsLoading(false);
      }
    };

    loadBudgetSummary();
  }, [parentLoading]);

  const sectionTitle = 'Budget Status';

  if (isLoading || parentLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <button
          onClick={() => router.push('/budgets')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          {sectionTitle}
        </button>
        <div className="animate-pulse space-y-3">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-16 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (hasError || !summary) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <button
          onClick={() => router.push('/budgets')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          {sectionTitle}
        </button>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No active budget found. Create a budget to track your spending.
        </p>
        <button
          onClick={() => router.push('/budgets')}
          className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
        >
          Create Budget
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => router.push(`/budgets/${summary.budgetId}`)}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {sectionTitle}
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {summary.daysRemaining} days left
        </span>
      </div>

      {/* Overall progress */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className={`text-xl font-bold ${budgetPercentColor(summary.percentUsed)}`}>
            {summary.percentUsed.toFixed(0)}%
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {formatCurrency(summary.totalSpent)} / {formatCurrency(summary.totalBudgeted)}
          </span>
        </div>
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${budgetProgressBarColor(summary.percentUsed)}`}
            style={{ width: `${Math.min(summary.percentUsed, 100)}%` }}
          />
        </div>
      </div>

      {/* Safe daily spend */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-2 sm:p-3 mb-3">
        <div className="text-xs text-blue-600 dark:text-blue-400 font-medium">
          Safe to spend today
        </div>
        <div className="text-lg font-bold text-blue-700 dark:text-blue-300">
          {formatCurrency(summary.safeDailySpend)}
        </div>
      </div>

      {/* Top 3 categories */}
      {summary.topCategories.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            Top Categories
          </div>
          {summary.topCategories.map((cat) => (
            <div key={cat.categoryName} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                    {cat.categoryName}
                  </span>
                  <span className={`text-xs font-medium ${budgetPercentColor(cat.percentUsed)}`}>
                    {cat.percentUsed.toFixed(0)}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full ${budgetCategoryBarColor(cat.percentUsed)}`}
                    style={{ width: `${Math.min(cat.percentUsed, 100)}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => router.push(`/budgets/${summary.budgetId}`)}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        View full budget
      </button>
    </div>
  );
}
