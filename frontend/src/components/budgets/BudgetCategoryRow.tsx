'use client';

import { useTranslations } from 'next-intl';
import { BudgetProgressBar } from './BudgetProgressBar';
import type { CategoryBreakdown } from '@/types/budget';

import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useBudgetPartialReason } from '@/hooks/useBudgetPartialReason';
import { spentUnknown, budgetedUnknown, figuresUnknown, spentPairs, budgetedPairs, unknownPairs } from './utils/line-completeness';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
interface BudgetCategoryRowProps {
  category: CategoryBreakdown;
  formatCurrency: (amount: number) => string;
  pacePercent?: number;
  rolloverType?: string;
  flexGroup?: string | null;
  onClick?: () => void;
}

function getPaceStatus(percentUsed: number, pacePercent: number): 'over' | 'under' | 'on' {
  const diff = percentUsed - pacePercent;
  if (diff > 5) return 'over';
  if (diff < -5) return 'under';
  return 'on';
}

export function BudgetCategoryRow({
  category,
  formatCurrency,
  pacePercent,
  rolloverType,
  flexGroup,
  onClick,
}: BudgetCategoryRowProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const partialReason = useBudgetPartialReason();
  // A row with no exchange rate is left out of `spent`: read as `=== false`.
  // Spent follows its own flag; the budget, what is left and the percent
  // follow the budget's (an income-linked line over income with no rate).
  const spentIsUnknown = spentUnknown(category);
  const budgetIsUnknown = budgetedUnknown(category);
  const partial = figuresUnknown(category);
  const unknownSpent = <UnknownAmount reasonText={partialReason(spentPairs(category))} />;
  const unknownBudget = <UnknownAmount reasonText={partialReason(budgetedPairs(category))} />;
  const unknown = <UnknownAmount reasonText={partialReason(unknownPairs(category))} />;
  const isOverBudget = !partial && category.remaining < 0;
  const hasPositiveBudget = category.budgeted > 0;
  const paceStatus = !partial && hasPositiveBudget && pacePercent !== undefined
    ? getPaceStatus(category.percentUsed, pacePercent)
    : undefined;
  const paceLabelMap = {
    over: { text: t('categoryRow.overPace'), className: 'text-red-600 dark:text-red-400' },
    under: { text: t('categoryRow.underPace'), className: 'text-green-600 dark:text-green-400' },
    on: { text: t('categoryRow.onPace'), className: 'text-blue-600 dark:text-blue-400' },
  };
  const paceLabel = paceStatus !== undefined ? paceLabelMap[paceStatus] : undefined;

  return (
    <button
      className="w-full text-left p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 focus:bg-gray-50 dark:focus:bg-gray-700/50 transition-colors"
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
            {category.categoryName}
          </span>
          {flexGroup && (
            <span className="px-1.5 py-0.5 bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 text-xs rounded font-medium whitespace-nowrap">
              {flexGroup}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 ml-2 whitespace-nowrap">
          <span className={`text-sm font-semibold ${
            isOverBudget
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-900 dark:text-gray-100'
          }`}>
            {spentIsUnknown ? unknownSpent : formatCurrency(category.spent)}
          </span>
          <span className="text-sm text-gray-400 dark:text-gray-500">/</span>
          <span className="text-sm text-gray-600 dark:text-gray-300">
            {budgetIsUnknown ? unknownBudget : formatCurrency(category.budgeted)}
            {category.percentage != null && (
              <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">
                ({formatPercentTrimmed(category.percentage)})
              </span>
            )}
          </span>
          {hasPositiveBudget && !partial && (
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
              isOverBudget
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                : category.percentUsed >= 80
                  ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                  : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
            }`}>
              {formatPercentTrimmed(Math.round(category.percentUsed))}
            </span>
          )}
        </div>
      </div>
      {hasPositiveBudget && !partial && (
        <BudgetProgressBar
          percentUsed={category.percentUsed}
          pacePercent={pacePercent}
          showPaceMarker={pacePercent !== undefined}
        />
      )}
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          {rolloverType && rolloverType !== 'NONE' && (
            <span>{t('categoryRow.rollover', { type: rolloverType.toLowerCase() })}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {paceLabel && (
            <span className={`text-xs font-medium ${paceLabel.className}`}>
              {paceLabel.text}
            </span>
          )}
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {partial
              ? unknown
              : category.remaining >= 0
                ? t('categoryRow.remaining', { amount: formatCurrency(category.remaining) })
                : t('categoryRow.over', { amount: formatCurrency(Math.abs(category.remaining)) })}
          </span>
        </div>
      </div>
    </button>
  );
}
