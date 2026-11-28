'use client';

import { useTranslations } from 'next-intl';
import { BudgetProgressBar } from './BudgetProgressBar';
import type { CategoryBreakdown, BudgetCategory } from '@/types/budget';

import { useNumberFormat } from '@/hooks/useNumberFormat';
import { CARD_CLASS } from '@/components/ui/Card';
import { useBudgetPartialReason } from '@/hooks/useBudgetPartialReason';
import { spentUnknown, budgetedUnknown, spentPairs, budgetedPairs } from './utils/line-completeness';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
interface FlexGroupData {
  name: string;
  totalBudgeted: number;
  totalSpent: number;
  remaining: number;
  percentUsed: number;
  /** `false` when a member line had a row with no exchange rate. */
  complete: boolean;
  missingRatePairs: string[];
  /** `false`: a member line's budget derives from income with no rate. */
  budgetedComplete: boolean;
  budgetedMissingRatePairs: string[];
  categories: Array<{
    categoryName: string;
    spent: number;
    complete: boolean;
    missingRatePairs: string[];
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

    const member = {
      categoryName: cat.categoryName,
      spent: cat.spent,
      complete: !spentUnknown(cat),
      missingRatePairs: spentPairs(cat),
    };
    const existing = groupMap.get(bc.flexGroup);
    if (existing) {
      existing.totalBudgeted += cat.budgeted;
      existing.totalSpent += cat.spent;
      existing.remaining += cat.remaining;
      if (spentUnknown(cat)) {
        existing.complete = false;
        existing.missingRatePairs = [...new Set([...existing.missingRatePairs, ...spentPairs(cat)])];
      }
      if (budgetedUnknown(cat)) {
        existing.budgetedComplete = false;
        existing.budgetedMissingRatePairs = [
          ...new Set([...existing.budgetedMissingRatePairs, ...budgetedPairs(cat)]),
        ];
      }
      existing.categories.push(member);
    } else {
      groupMap.set(bc.flexGroup, {
        name: bc.flexGroup,
        totalBudgeted: cat.budgeted,
        totalSpent: cat.spent,
        remaining: cat.remaining,
        percentUsed: 0,
        complete: !spentUnknown(cat),
        missingRatePairs: spentPairs(cat),
        budgetedComplete: !budgetedUnknown(cat),
        budgetedMissingRatePairs: budgetedPairs(cat),
        categories: [member],
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

  // A group with an unknown total has no percent to rank by: it goes last.
  return groups.sort(
    (a, b) =>
      Number(b.complete && b.budgetedComplete) - Number(a.complete && a.budgetedComplete) ||
      b.percentUsed - a.percentUsed,
  );
}

export function BudgetFlexGroupCard({
  categories,
  budgetCategories,
  formatCurrency,
}: BudgetFlexGroupCardProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const partialReason = useBudgetPartialReason();
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
                {group.complete ? formatCurrency(group.totalSpent) : (
                  <UnknownAmount reasonText={partialReason(group.missingRatePairs)} />
                )}{' '}
                /{' '}
                {group.budgetedComplete ? formatCurrency(group.totalBudgeted) : (
                  <UnknownAmount reasonText={partialReason(group.budgetedMissingRatePairs)} />
                )}
                {group.complete && group.budgetedComplete && (
                  <> ({formatPercentTrimmed(Math.round(group.percentUsed))})</>
                )}
              </span>
            </div>
            {group.complete && group.budgetedComplete && <BudgetProgressBar percentUsed={group.percentUsed} />}
            <div className="mt-2 space-y-1">
              {group.categories.map((cat) => (
                <div
                  key={cat.categoryName}
                  className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400 pl-2"
                >
                  <span>{cat.categoryName}</span>
                  <span>
                    {cat.complete ? (
                      formatCurrency(cat.spent)
                    ) : (
                      <UnknownAmount reasonText={partialReason(cat.missingRatePairs)} />
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
