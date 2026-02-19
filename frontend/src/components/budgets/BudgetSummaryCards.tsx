'use client';

import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';

interface BudgetSummaryCardsProps {
  totalBudgeted: number;
  totalSpent: number;
  remaining: number;
  totalIncome: number;
  percentUsed: number;
  daysRemaining: number;
  formatCurrency: (amount: number) => string;
}

export function BudgetSummaryCards({
  totalBudgeted,
  totalSpent,
  remaining,
  totalIncome,
  percentUsed,
  daysRemaining,
  formatCurrency,
}: BudgetSummaryCardsProps) {
  const projectedSavings = totalIncome - totalSpent;
  const savingsLabel = projectedSavings >= 0 ? 'On track' : 'Over budget';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <SummaryCard
        label="Total Budget"
        value={formatCurrency(totalBudgeted)}
        icon={SummaryIcons.money}
        valueColor="blue"
      />
      <SummaryCard
        label="Spent"
        value={
          <span>
            {formatCurrency(totalSpent)}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">
              ({Math.round(percentUsed)}%)
            </span>
          </span>
        }
        icon={SummaryIcons.minus}
        valueColor={percentUsed > 100 ? 'red' : 'default'}
      />
      <SummaryCard
        label="Remaining"
        value={
          <span>
            {formatCurrency(Math.abs(remaining))}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">
              {daysRemaining > 0 ? `${daysRemaining} days` : 'Period ended'}
            </span>
          </span>
        }
        icon={remaining >= 0 ? SummaryIcons.checkmark : SummaryIcons.cross}
        valueColor={remaining >= 0 ? 'green' : 'red'}
      />
      <SummaryCard
        label="Savings"
        value={
          <span>
            {formatCurrency(Math.abs(projectedSavings))}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">
              {savingsLabel}
            </span>
          </span>
        }
        icon={SummaryIcons.plusCircle}
        valueColor={projectedSavings >= 0 ? 'green' : 'red'}
      />
    </div>
  );
}
