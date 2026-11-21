'use client';

import { useTranslations } from 'next-intl';
import { BudgetProgressBar } from './BudgetProgressBar';
import type { CategoryBreakdown, BudgetCategory } from '@/types/budget';

import { useNumberFormat } from '@/hooks/useNumberFormat';
import { CARD_CLASS } from '@/components/ui/Card';
interface FlexGroupData {
  name: string;
  totalBudgeted: number;
  totalSpent: number;
  remaining: number;
  percentUsed: number;
  categories: Array<{
    categoryName: string;
    spent: number;
  }>;
}

interface BudgetFlexGroupCardProps {
  categories: CategoryBreakdown[];
  budgetCategories: BudgetCategory[];
  formatCurrency: (amount: number) => string;
}

function computeFlexGroups(
  categories: CategoryBreakdown[],
  budgetCategories: BudgetCategory[],
): FlexGroupData[] {
  const bcMap = new Map<string, BudgetCategory>();
  for (const bc of budgetCategories) {
    bcMap.set(bc.id, bc);
  }

  const groupMap = new Map<string, FlexGroupData>();
  for (const cat of categories) {
    if (cat.isIncome) continue;
    const bc = bcMap.get(cat.budgetCategoryId);
    if (!bc?.flexGroup) continue;

    const existing = groupMap.get(bc.flexGroup);
    if (existing) {
      existing.totalBudgeted += cat.budgeted;
      existing.totalSpent += cat.spent;
      existing.remaining += cat.remaining;
      existing.categories.push({
        categoryName: cat.categoryName,
        spent: cat.spent,
      });
    } else {
      groupMap.set(bc.flexGroup, {
        name: bc.flexGroup,
        totalBudgeted: cat.budgeted,
        totalSpent: cat.spent,
        remaining: cat.remaining,
        percentUsed: 0,
        categories: [{ categoryName: cat.categoryName, spent: cat.spent }],
      });
    }
  }

  const groups = Array.from(groupMap.values());
  for (const group of groups) {
    group.percentUsed =
      group.totalBudgeted > 0
        ? (group.totalSpent / group.totalBudgeted) * 100
        : 0;
  }

  return groups.sort((a, b) => b.percentUsed - a.percentUsed);
}

export function BudgetFlexGroupCard({
  categories,
  budgetCategories,
  formatCurrency,
}: BudgetFlexGroupCardProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const flexGroups = computeFlexGroups(categories, budgetCategories);

  if (flexGroups.length === 0) {
    return null;
  }

  return (
    <div className={`${CARD_CLASS} p-4 sm:p-6`}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('flexGroups.title')}
      </h2>
      <div className="space-y-4">
        {flexGroups.map((group) => (
          <div key={group.name}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {group.name}
              </span>
              <span className="text-sm text-gray-600 dark:text-gray-300">
                {formatCurrency(group.totalSpent)} / {formatCurrency(group.totalBudgeted)}{' '}
                ({formatPercentTrimmed(Math.round(group.percentUsed))})
              </span>
            </div>
            <BudgetProgressBar percentUsed={group.percentUsed} />
            <div className="mt-2 space-y-1">
              {group.categories.map((cat) => (
                <div
                  key={cat.categoryName}
                  className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400 pl-2"
                >
                  <span>{cat.categoryName}</span>
                  <span>{formatCurrency(cat.spent)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
