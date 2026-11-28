'use client';

import { useTranslations } from 'next-intl';
import { SortableTh, TABLE_BODY_CLASS, TABLE_CLASS, Th, TD_CLASS } from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useBudgetPartialReason } from '@/hooks/useBudgetPartialReason';
import { spentUnknown, budgetedUnknown, figuresUnknown, spentPairs, budgetedPairs, unknownPairs } from '../utils/line-completeness';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { BudgetProgressBar } from '../BudgetProgressBar';
import type { BudgetCategoryListViewProps } from './budget-category-list-view';

const LOSS = 'text-red-600 dark:text-red-400';

/**
 * The category budgets as a ruled schedule: Budgeted, Spent and Remaining in
 * ledger figures down their own columns, and the ticked gauge for how far
 * through the line the period is. Only an overspend takes the loss colour.
 */
export function BudgetCategoryListFolio({
  rows,
  formatCurrency,
  pacePercent,
  onCategoryClick,
  sortField,
  sortDirection,
  onSort,
}: BudgetCategoryListViewProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const partialReason = useBudgetPartialReason();
  const sort = { sortField, sortDirection, onSort };
  return (
    <div className="ui-bud-schedule overflow-x-auto">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <SortableTh field="name" {...sort}>{t('categoryTrend.tableHeaders.category')}</SortableTh>
            <Th align="right" className="hidden sm:table-cell">{t('trendChart.budgeted')}</Th>
            <SortableTh field="spent" align="right" {...sort}>{t('summaryCards.spent')}</SortableTh>
            <SortableTh field="remaining" align="right" className="hidden sm:table-cell" {...sort}>
              {t('summaryCards.remaining')}
            </SortableTh>
            <SortableTh field="percentUsed" className="w-[28%] min-w-[9rem]" {...sort}>
              {t('categoryList.sortOptions.percentUsed')}
            </SortableTh>
          </tr>
        </thead>
        <tbody className={TABLE_BODY_CLASS}>
          {rows.map(({ category, rolloverType, flexGroup }) => {
            const partial = figuresUnknown(category);
            const unknownSpent = <UnknownAmount reasonText={partialReason(spentPairs(category))} />;
            const unknownBudget = <UnknownAmount reasonText={partialReason(budgetedPairs(category))} />;
            const unknown = <UnknownAmount reasonText={partialReason(unknownPairs(category))} />;
            const over = !partial && category.remaining < 0;
            return (
              <tr key={category.budgetCategoryId}>
                <td className={`${TD_CLASS} break-words`}>
                  {onCategoryClick ? (
                    <button
                      type="button"
                      className="ui-bud-schedule-name text-left font-medium text-gray-900 hover:underline focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-100"
                      onClick={() => onCategoryClick(category.budgetCategoryId)}
                    >
                      {category.categoryName}
                    </button>
                  ) : (
                    <span className="font-medium">{category.categoryName}</span>
                  )}
                  {(flexGroup || (rolloverType && rolloverType !== 'NONE')) && (
                    <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                      {[flexGroup, rolloverType && rolloverType !== 'NONE'
                        ? t('categoryRow.rollover', { type: rolloverType.toLowerCase() })
                        : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </td>
                <td className={`${TD_CLASS} ui-bud-num hidden text-right whitespace-nowrap sm:table-cell`}>
                  {budgetedUnknown(category) ? unknownBudget : formatCurrency(category.budgeted)}
                </td>
                <td className={`${TD_CLASS} ui-bud-num text-right whitespace-nowrap ${over ? LOSS : ''}`}>
                  {spentUnknown(category) ? unknownSpent : formatCurrency(category.spent)}
                </td>
                <td className={`${TD_CLASS} ui-bud-num hidden text-right whitespace-nowrap sm:table-cell ${over ? LOSS : ''}`}>
                  {partial ? unknown : over ? `(${formatCurrency(Math.abs(category.remaining))})` : formatCurrency(category.remaining)}
                </td>
                <td className={TD_CLASS}>
                  {partial ? unknown : category.budgeted > 0 ? (
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <BudgetProgressBar
                          percentUsed={category.percentUsed}
                          pacePercent={pacePercent}
                          showPaceMarker={pacePercent !== undefined}
                        />
                      </div>
                      <span className="ui-bud-num w-10 shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
                        {formatPercentTrimmed(Math.round(category.percentUsed))}
                      </span>
                    </div>
                  ) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
