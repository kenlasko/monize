'use client';

import type { BudgetCategory, CategoryBreakdown } from '@/types/budget';

interface Budget503020SummaryProps {
  budgetCategories: BudgetCategory[];
  categoryBreakdown: CategoryBreakdown[];
  totalIncome: number;
  formatCurrency: (amount: number) => string;
}

const GROUPS = [
  { key: 'NEED', label: 'Needs', target: 50, color: 'bg-blue-500 dark:bg-blue-400' },
  { key: 'WANT', label: 'Wants', target: 30, color: 'bg-purple-500 dark:bg-purple-400' },
  { key: 'SAVING', label: 'Savings', target: 20, color: 'bg-green-500 dark:bg-green-400' },
] as const;

export function Budget503020Summary({
  budgetCategories,
  categoryBreakdown,
  totalIncome,
  formatCurrency,
}: Budget503020SummaryProps) {
  // Build a map from budgetCategoryId to categoryGroup
  const groupMap = new Map<string, string>();
  for (const bc of budgetCategories) {
    if (bc.categoryGroup) {
      groupMap.set(bc.id, bc.categoryGroup);
    }
  }

  // Compute spent by group from categoryBreakdown
  const groupTotals = new Map<string, { budgeted: number; spent: number }>();
  for (const group of GROUPS) {
    groupTotals.set(group.key, { budgeted: 0, spent: 0 });
  }

  for (const cat of categoryBreakdown) {
    if (cat.isIncome) continue;
    const group = groupMap.get(cat.budgetCategoryId);
    if (group && groupTotals.has(group)) {
      const current = groupTotals.get(group)!;
      current.budgeted += cat.budgeted;
      current.spent += cat.spent;
    }
  }

  if (totalIncome <= 0) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
        50/30/20 Allocation
      </h3>
      <div className="space-y-4">
        {GROUPS.map((group) => {
          const data = groupTotals.get(group.key)!;
          const actualPercent =
            totalIncome > 0
              ? Math.round((data.spent / totalIncome) * 100)
              : 0;
          const budgetedPercent =
            totalIncome > 0
              ? Math.round((data.budgeted / totalIncome) * 100)
              : 0;
          const diff = actualPercent - group.target;

          let statusColor: string;
          if (Math.abs(diff) <= 5) {
            statusColor = 'text-green-600 dark:text-green-400';
          } else if (Math.abs(diff) <= 10) {
            statusColor = 'text-yellow-600 dark:text-yellow-400';
          } else {
            statusColor = 'text-red-600 dark:text-red-400';
          }

          const barWidth = Math.min(actualPercent, 100);

          return (
            <div key={group.key}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {group.label}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    Target: {group.target}%
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium ${statusColor}`}>
                    {actualPercent}%
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formatCurrency(data.spent)}
                  </span>
                </div>
              </div>
              <div className="relative w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${group.color}`}
                  style={{ width: `${barWidth}%` }}
                />
                {/* Target marker */}
                <div
                  className="absolute top-0 h-full w-px bg-gray-500/60 dark:bg-gray-400/60"
                  style={{ left: `${group.target}%` }}
                  title={`Target: ${group.target}%`}
                />
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                Budgeted: {budgetedPercent}% ({formatCurrency(data.budgeted)})
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
