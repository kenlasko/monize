'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { budgetsApi } from '@/lib/budgets';
import { DashboardBudgetSummary } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { CARD_CLASS } from '@/components/ui/Card';
import { WidgetHeading } from './widget-meta';
import {
  budgetPercentColor,
  budgetProgressBarColor,
  budgetCategoryBarColor,
} from '@/components/budgets/utils/budget-colors';

interface BudgetStatusWidgetProps {
  isLoading: boolean;
}

export function BudgetStatusWidget({ isLoading: parentLoading }: BudgetStatusWidgetProps) {
  const t = useTranslations('dashboard');
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

  const sectionTitle = t('budgetStatus.title');

  if (isLoading || parentLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[390px]`}>
        <WidgetHeading id="budget-status" onClick={() => router.push('/budgets')} className="mb-4">
          {sectionTitle}
        </WidgetHeading>
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
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[390px]`}>
        <WidgetHeading id="budget-status" onClick={() => router.push('/budgets')} className="mb-4">
          {sectionTitle}
        </WidgetHeading>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {t('budgetStatus.noBudget')}
        </p>
        <button
          onClick={() => router.push('/budgets')}
          className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
        >
          {t('budgetStatus.createBudget')}
        </button>
      </div>
    );
  }

  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[390px]`}>
      <div className="flex items-center justify-between mb-3">
        <WidgetHeading id="budget-status" onClick={() => router.push(`/budgets/${summary.budgetId}`)}>
          {sectionTitle}
        </WidgetHeading>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {t('budgetStatus.daysLeft', { count: summary.daysRemaining })}
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
          {t('budgetStatus.safeToSpend')}
        </div>
        <div className="text-lg font-bold text-blue-700 dark:text-blue-300">
          {formatCurrency(summary.safeDailySpend)}
        </div>
      </div>

      {/* Top 3 categories */}
      {summary.topCategories.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            {t('budgetStatus.topCategories')}
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
        {t('budgetStatus.viewFullBudget')}
      </button>
    </div>
  );
}
