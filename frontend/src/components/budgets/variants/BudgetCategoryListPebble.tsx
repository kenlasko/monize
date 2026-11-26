'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { BudgetProgressBar } from '../BudgetProgressBar';
import type { BudgetCategoryListViewProps } from './budget-category-list-view';

/**
 * The category budgets as white blocks: the name over what is left in a big
 * tight figure, a fat pill gauge, and the state as a pill. Each block is one
 * button that opens the category's transactions.
 */
export function BudgetCategoryListPebble({
  rows,
  formatCurrency,
  pacePercent,
  onCategoryClick,
}: BudgetCategoryListViewProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  return (
    <ul className="ui-bud-tiles grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {rows.map(({ category, rolloverType, flexGroup }) => {
        const over = category.remaining < 0;
        const hasPositiveBudget = category.budgeted > 0;
        const body = (
          <>
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0 truncate font-semibold text-gray-900 dark:text-gray-100">
                {category.categoryName}
              </span>
              {hasPositiveBudget && (
                <Badge variant={over ? 'red' : category.percentUsed >= 80 ? 'amber' : 'gray'}>
                  {formatPercentTrimmed(Math.round(category.percentUsed))}
                </Badge>
              )}
            </span>
            <span className="ui-bud-tile-figure mt-3 block text-3xl text-gray-900 dark:text-gray-50">
              <span className={over ? 'text-red-600 dark:text-red-400' : undefined}>
                {formatCurrency(Math.abs(category.remaining))}
              </span>
              <span className="ml-1.5 text-sm font-medium text-gray-500 dark:text-gray-400">
                {over ? t('categoryRow.overWord') : t('categoryRow.leftWord')}
              </span>
            </span>
            {hasPositiveBudget && (
              <span className="mt-3 block">
                <BudgetProgressBar
                  percentUsed={category.percentUsed}
                  pacePercent={pacePercent}
                  showPaceMarker={pacePercent !== undefined}
                />
              </span>
            )}
            <span className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>
                {formatCurrency(category.spent)} / {formatCurrency(category.budgeted)}
              </span>
              <span className="flex items-center gap-1.5">
                {flexGroup && <Badge variant="purple">{flexGroup}</Badge>}
                {rolloverType && rolloverType !== 'NONE' && (
                  <span>{t('categoryRow.rollover', { type: rolloverType.toLowerCase() })}</span>
                )}
              </span>
            </span>
          </>
        );
        return (
          <li key={category.budgetCategoryId}>
            {onCategoryClick ? (
              <button
                type="button"
                className="ui-bud-tile block w-full text-left"
                onClick={() => onCategoryClick(category.budgetCategoryId)}
              >
                {body}
              </button>
            ) : (
              <div className="ui-bud-tile block w-full text-left">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
