'use client';

import { useTranslations } from 'next-intl';
import { CARD_CLASS } from '@/components/ui/Card';
import { UnknownAmount } from '@/components/ui/UnknownAmount';

interface BudgetZeroBasedBarProps {
  /** `null` when an income row had no exchange rate: nothing can be assigned against it. */
  totalIncome: number | null;
  /** The translated cause shown beside an unknown figure. */
  partialReason?: string;
  totalBudgeted: number;
  formatCurrency: (amount: number) => string;
}

export function BudgetZeroBasedBar({
  totalIncome,
  partialReason,
  totalBudgeted,
  formatCurrency,
}: BudgetZeroBasedBarProps) {
  const t = useTranslations('budgets');
  if (totalIncome === null) {
    return (
      <div className={`${CARD_CLASS} p-4 sm:p-6`}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('zeroBasedBar.title')}
          </h3>
          <UnknownAmount reasonText={partialReason} />
        </div>
      </div>
    );
  }
  const unassigned = totalIncome - totalBudgeted;
  const assignedPercent =
    totalIncome > 0
      ? Math.min((totalBudgeted / totalIncome) * 100, 100)
      : 0;

  const tolerance = totalIncome * 0.02;
  const isFullyAssigned = Math.abs(unassigned) <= tolerance;
  const isOverAssigned = unassigned < -tolerance;

  let statusColor: string;
  let statusLabel: string;
  if (isFullyAssigned) {
    statusColor = 'text-green-600 dark:text-green-400';
    statusLabel = t('zeroBasedBar.fullyAssigned');
  } else if (isOverAssigned) {
    statusColor = 'text-red-600 dark:text-red-400';
    statusLabel = t('zeroBasedBar.overAssigned');
  } else {
    statusColor = 'text-yellow-600 dark:text-yellow-400';
    statusLabel = t('zeroBasedBar.underAssigned');
  }

  let barColor: string;
  if (isFullyAssigned) {
    barColor = 'bg-green-500 dark:bg-green-400';
  } else if (isOverAssigned) {
    barColor = 'bg-red-500 dark:bg-red-400';
  } else {
    barColor = 'bg-yellow-500 dark:bg-yellow-400';
  }

  return (
    <div className={`${CARD_CLASS} p-4 sm:p-6`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('zeroBasedBar.title')}
        </h3>
        <span className={`text-sm font-medium ${statusColor}`}>
          {statusLabel}
        </span>
      </div>
      <div className="relative w-full h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${assignedPercent}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-2 text-sm">
        <span className="text-gray-600 dark:text-gray-300">
          {t('zeroBasedBar.assigned', { assigned: formatCurrency(totalBudgeted), income: formatCurrency(totalIncome) })}
        </span>
        <span className={statusColor}>
          {unassigned >= 0
            ? t('zeroBasedBar.unassigned', { amount: formatCurrency(unassigned) })
            : t('zeroBasedBar.over', { amount: formatCurrency(Math.abs(unassigned)) })}
        </span>
      </div>
    </div>
  );
}
