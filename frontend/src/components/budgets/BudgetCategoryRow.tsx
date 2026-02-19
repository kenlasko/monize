'use client';

import { BudgetProgressBar } from './BudgetProgressBar';
import type { CategoryBreakdown } from '@/types/budget';

interface BudgetCategoryRowProps {
  category: CategoryBreakdown;
  formatCurrency: (amount: number) => string;
  pacePercent?: number;
  rolloverType?: string;
  flexGroup?: string | null;
  onClick?: () => void;
}

function getPaceLabel(percentUsed: number, pacePercent: number): {
  text: string;
  className: string;
} {
  const diff = percentUsed - pacePercent;
  if (diff > 5) {
    return { text: 'Over pace', className: 'text-red-600 dark:text-red-400' };
  }
  if (diff < -5) {
    return { text: 'Under pace', className: 'text-green-600 dark:text-green-400' };
  }
  return { text: 'On pace', className: 'text-blue-600 dark:text-blue-400' };
}

export function BudgetCategoryRow({
  category,
  formatCurrency,
  pacePercent,
  rolloverType,
  flexGroup,
  onClick,
}: BudgetCategoryRowProps) {
  const isOverBudget = category.percentUsed > 100;
  const paceLabel = pacePercent !== undefined
    ? getPaceLabel(category.percentUsed, pacePercent)
    : undefined;

  return (
    <button
      className="w-full text-left p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
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
            {formatCurrency(category.spent)}
          </span>
          <span className="text-sm text-gray-400 dark:text-gray-500">/</span>
          <span className="text-sm text-gray-600 dark:text-gray-300">
            {formatCurrency(category.budgeted)}
          </span>
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
            isOverBudget
              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
              : category.percentUsed >= 80
                ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
          }`}>
            {Math.round(category.percentUsed)}%
          </span>
        </div>
      </div>
      <BudgetProgressBar
        percentUsed={category.percentUsed}
        pacePercent={pacePercent}
        showPaceMarker={pacePercent !== undefined}
      />
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          {rolloverType && rolloverType !== 'NONE' && (
            <span>Rollover: {rolloverType.toLowerCase()}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {paceLabel && (
            <span className={`text-xs font-medium ${paceLabel.className}`}>
              {paceLabel.text}
            </span>
          )}
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {category.remaining >= 0
              ? `${formatCurrency(category.remaining)} left`
              : `${formatCurrency(Math.abs(category.remaining))} over`}
          </span>
        </div>
      </div>
    </button>
  );
}
