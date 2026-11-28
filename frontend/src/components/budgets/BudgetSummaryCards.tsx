'use client';

import { useTranslations } from 'next-intl';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';

import { useNumberFormat } from '@/hooks/useNumberFormat';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { BudgetSummaryFolio } from './variants/BudgetSummaryFolio';
import { BudgetSummaryPebble } from './variants/BudgetSummaryPebble';
import type { BudgetSummaryViewProps } from './variants/budget-summary-view';

type BudgetSummaryCardsProps = BudgetSummaryViewProps;

const VARIANTS: StyleVariants<BudgetSummaryViewProps> = {
  standard: BudgetSummaryCardsStandard,
  folio: BudgetSummaryFolio,
  pebble: BudgetSummaryPebble,
};

/**
 * The period's totals. Standard keeps the four stat tiles; Folio reads them
 * as a statement line over a ticked gauge, Pebble as an accent block for what
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
  partialReason,
  incomeReason,
  daysRemaining,
  formatCurrency,
}: BudgetSummaryCardsProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  // Spent needs only its own rows; the percent, what is left and the budget
  // need the budget's income too, so each unknown figure names its own cause.
  const spentKnown = totalSpent !== null;
  const percentKnown = percentUsed !== null;
  const savingsKnown = totalSpent !== null && totalIncome !== null;
  const projectedSavings = savingsKnown ? totalIncome - totalSpent : 0;
  const savingsLabel = projectedSavings >= 0 ? t('summaryCards.onTrack') : t('summaryCards.overBudget');
  const unknownSpent = <UnknownAmount reasonText={partialReason} />;
  const unknownIncome = <UnknownAmount reasonText={incomeReason ?? partialReason} />;
  const unknownRemaining = totalSpent === null ? unknownSpent : unknownIncome;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <SummaryCard
        label={t('summaryCards.totalBudget')}
        value={totalBudgeted === null ? unknownIncome : formatCurrency(totalBudgeted)}
        icon={SummaryIcons.money}
        valueColor="blue"
      />
      <SummaryCard
        label={t('summaryCards.spent')}
        value={
          spentKnown ? (
            <span>
              {formatCurrency(totalSpent)}
              {percentKnown && (
                <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">
                  ({formatPercentTrimmed(Math.round(percentUsed))})
                </span>
              )}
            </span>
          ) : (
            unknownSpent
          )
        }
        icon={SummaryIcons.minus}
        valueColor={percentKnown && percentUsed > 100 ? 'red' : 'default'}
      />
      <SummaryCard
        label={t('summaryCards.remaining')}
        value={
          remaining !== null ? (
            <span>
              {formatCurrency(Math.abs(remaining))}
              <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">
                {daysRemaining > 0 ? t('summaryCards.days', { count: String(daysRemaining) }) : t('summaryCards.periodEnded')}
              </span>
            </span>
          ) : (
            unknownRemaining
          )
        }
        icon={remaining === null || remaining >= 0 ? SummaryIcons.checkmark : SummaryIcons.cross}
        valueColor={remaining === null ? 'default' : remaining >= 0 ? 'green' : 'red'}
      />
      <SummaryCard
        label={t('summaryCards.savings')}
        value={
          savingsKnown ? (
            <span>
              {formatCurrency(Math.abs(projectedSavings))}
              <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-1">
                {savingsLabel}
              </span>
            </span>
          ) : (
            totalSpent === null ? unknownSpent : unknownIncome
          )
        }
        icon={SummaryIcons.plusCircle}
        valueColor={!savingsKnown ? 'default' : projectedSavings >= 0 ? 'green' : 'red'}
      />
    </div>
  );
}
