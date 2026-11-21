'use client';

import { useTranslations } from 'next-intl';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';

import { useNumberFormat } from '@/hooks/useNumberFormat';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { BudgetSummaryClassic } from './variants/BudgetSummaryClassic';
import { BudgetSummaryModern } from './variants/BudgetSummaryModern';
import type { BudgetSummaryViewProps } from './variants/budget-summary-view';

type BudgetSummaryCardsProps = BudgetSummaryViewProps;

const VARIANTS: StyleVariants<BudgetSummaryViewProps> = {
  standard: BudgetSummaryCardsStandard,
  classic: BudgetSummaryClassic,
  modern: BudgetSummaryModern,
};

/**
 * The period's totals. Standard keeps the four stat tiles; Classic reads them
 * as a statement line over a ticked gauge, Modern as an accent block for what
 * is left beside white blocks (`variants/`).
 */
export function BudgetSummaryCards(props: BudgetSummaryCardsProps) {
  return renderForStyle(useUiStyle(), VARIANTS, props);
}

function BudgetSummaryCardsStandard({
  totalBudgeted,
  totalSpent,
  remaining,
  totalIncome,
  percentUsed,
  daysRemaining,
  formatCurrency,
}: BudgetSummaryCardsProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const projectedSavings = totalIncome - totalSpent;
  const savingsLabel = projectedSavings >= 0 ? t('summaryCards.onTrack') : t('summaryCards.overBudget');

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <SummaryCard
        label={t('summaryCards.totalBudget')}
        value={formatCurrency(totalBudgeted)}
        icon={SummaryIcons.money}
        valueColor="blue"
      />
      <SummaryCard
        label={t('summaryCards.spent')}
        value={
          <span>
            {formatCurrency(totalSpent)}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">
              ({formatPercentTrimmed(Math.round(percentUsed))})
            </span>
          </span>
        }
        icon={SummaryIcons.minus}
        valueColor={percentUsed > 100 ? 'red' : 'default'}
      />
      <SummaryCard
        label={t('summaryCards.remaining')}
        value={
          <span>
            {formatCurrency(Math.abs(remaining))}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">
              {daysRemaining > 0 ? t('summaryCards.days', { count: String(daysRemaining) }) : t('summaryCards.periodEnded')}
            </span>
          </span>
        }
        icon={remaining >= 0 ? SummaryIcons.checkmark : SummaryIcons.cross}
        valueColor={remaining >= 0 ? 'green' : 'red'}
      />
      <SummaryCard
        label={t('summaryCards.savings')}
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
