'use client';

import { useState, useMemo } from 'react';
import { BudgetCategoryRow } from './BudgetCategoryRow';
import type { CategoryBreakdown, BudgetCategory } from '@/types/budget';

type SortField = 'name' | 'spent' | 'remaining' | 'percentUsed';
type SortDirection = 'asc' | 'desc';

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
  const [sortField, setSortField] = useState<SortField>('percentUsed');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const expenseCategories = useMemo(
    () => categories.filter((c) => !c.isIncome),
    [categories],
  );

  const sortedCategories = useMemo(() => {
    const sorted = [...expenseCategories];
    sorted.sort((a, b) => {
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

  const sortOptions: Array<{ field: SortField; label: string }> = [
    { field: 'percentUsed', label: '% Used' },
    { field: 'spent', label: 'Spent' },
    { field: 'remaining', label: 'Remaining' },
    { field: 'name', label: 'Name' },
  ];

  if (sortedCategories.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Category Budgets
        </h2>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No expense categories in this budget.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Category Budgets
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">Sort:</span>
          <select
            value={sortField}
            onChange={(e) => handleSort(e.target.value as SortField)}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            aria-label="Sort categories"
          >
            {sortOptions.map((opt) => (
              <option key={opt.field} value={opt.field}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
            }
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
            aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
            title={sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
          >
            {sortDirection === 'asc' ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            ) }
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {sortedCategories.map((category) => {
          const bc = budgetCategoryMap.get(category.budgetCategoryId);
          return (
            <BudgetCategoryRow
              key={category.budgetCategoryId}
              category={category}
              formatCurrency={formatCurrency}
              pacePercent={pacePercent}
              rolloverType={bc?.rolloverType}
              flexGroup={bc?.flexGroup}
              onClick={
                onCategoryClick
                  ? () => onCategoryClick(category.budgetCategoryId)
                  : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}
