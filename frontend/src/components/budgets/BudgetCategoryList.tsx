'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { BudgetCategoryRow } from './BudgetCategoryRow';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { BudgetCategoryListFolio } from './variants/BudgetCategoryListFolio';
import { BudgetCategoryListPebble } from './variants/BudgetCategoryListPebble';
import type { BudgetCategoryListViewProps } from './variants/budget-category-list-view';
import type { CategoryBreakdown, BudgetCategory } from '@/types/budget';
import { CARD_CLASS } from '@/components/ui/Card';
import { spentUnknown, figuresUnknown } from './utils/line-completeness';

type SortField = BudgetCategoryListViewProps['sortField'];
type SortDirection = 'asc' | 'desc';

/** Standard: one bordered row per category, as ever. */
function BudgetCategoryListStandard({
  rows,
  formatCurrency,
  pacePercent,
  onCategoryClick,
}: BudgetCategoryListViewProps) {
  return (
    <div className="space-y-2">
      {rows.map(({ category, rolloverType, flexGroup }) => (
        <BudgetCategoryRow
          key={category.budgetCategoryId}
          category={category}
          formatCurrency={formatCurrency}
          pacePercent={pacePercent}
          rolloverType={rolloverType}
          flexGroup={flexGroup}
          onClick={
            onCategoryClick
              ? () => onCategoryClick(category.budgetCategoryId)
              : undefined
          }
        />
      ))}
    </div>
  );
}

const VARIANTS: StyleVariants<BudgetCategoryListViewProps> = {
  standard: BudgetCategoryListStandard,
  folio: BudgetCategoryListFolio,
  pebble: BudgetCategoryListPebble,
};

interface BudgetCategoryListProps {
  categories: CategoryBreakdown[];
  budgetCategories: BudgetCategory[];
  formatCurrency: (amount: number) => string;
  pacePercent?: number;
  onCategoryClick?: (budgetCategoryId: string) => void;
}

export function BudgetCategoryList({
  categories,
  budgetCategories,
  formatCurrency,
  pacePercent,
  onCategoryClick,
}: BudgetCategoryListProps) {
  const t = useTranslations('budgets');
  const uiStyle = useUiStyle();
  const [sortField, setSortField] = useState<SortField>('percentUsed');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const expenseCategories = useMemo(
    () => categories.filter((c) => !c.isIncome),
    [categories],
  );

  const sortedCategories = useMemo(() => {
    const sorted = [...expenseCategories];
    sorted.sort((a, b) => {
      // A line with an unknown figure has nothing to rank by on the figure
      // columns: it goes last in either direction (read as `=== false`).
      if (sortField !== 'name') {
        // Spent follows its own flag; what is left and the percent also need
        // the budget.
        const unknownOn = sortField === 'spent' ? spentUnknown : figuresUnknown;
        const aPartial = unknownOn(a);
        const bPartial = unknownOn(b);
        if (aPartial !== bPartial) return aPartial ? 1 : -1;
        if (aPartial && bPartial) return a.categoryName.localeCompare(b.categoryName);
      }
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.categoryName.localeCompare(b.categoryName);
          break;
        case 'spent':
          comparison = a.spent - b.spent;
          break;
        case 'remaining':
          comparison = a.remaining - b.remaining;
          break;
        case 'percentUsed':
          comparison = a.percentUsed - b.percentUsed;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [expenseCategories, sortField, sortDirection]);

  const budgetCategoryMap = useMemo(() => {
    const map = new Map<string, BudgetCategory>();
    for (const bc of budgetCategories) {
      map.set(bc.id, bc);
    }
    return map;
  }, [budgetCategories]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const sortOptions: Array<{ field: SortField; labelKey: string }> = [
    { field: 'percentUsed', labelKey: 'categoryList.sortOptions.percentUsed' },
    { field: 'spent', labelKey: 'categoryList.sortOptions.spent' },
    { field: 'remaining', labelKey: 'categoryList.sortOptions.remaining' },
    { field: 'name', labelKey: 'categoryList.sortOptions.name' },
  ];

  if (sortedCategories.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-6`}>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('categoryList.title')}
        </h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {t('categoryList.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className={`${CARD_CLASS} ui-bud-list p-4 sm:p-6`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('categoryList.title')}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">{t('categoryList.sort')}</span>
          <select
            value={sortField}
            onChange={(e) => handleSort(e.target.value as SortField)}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            aria-label={t('categoryList.sortAriaLabel')}
          >
            {sortOptions.map((opt) => (
              <option key={opt.field} value={opt.field}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
            }
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
            aria-label={sortDirection === 'asc' ? t('categoryList.sortAscAriaLabel') : t('categoryList.sortDescAriaLabel')}
            title={sortDirection === 'asc' ? t('categoryList.sortDescTitle') : t('categoryList.sortAscTitle')}
          >
            {sortDirection === 'asc' ? (
              <ChevronUpIcon className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {renderForStyle(uiStyle, VARIANTS, {
        rows: sortedCategories.map((category) => {
          const bc = budgetCategoryMap.get(category.budgetCategoryId);
          return { category, rolloverType: bc?.rolloverType, flexGroup: bc?.flexGroup };
        }),
        formatCurrency,
        pacePercent,
        onCategoryClick,
        sortField,
        sortDirection,
        onSort: handleSort,
      })}
    </div>
  );
}
