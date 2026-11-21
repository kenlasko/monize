'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { BudgetProgressBar } from '../BudgetProgressBar';
import type { BudgetSummaryViewProps } from './budget-summary-view';

const LOSS = 'text-red-600 dark:text-red-400';

function Entry({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="ui-bud-entry">
      <dt className="ui-figure-label">{label}</dt>
      <dd className="ui-bud-entry-figure text-2xl text-gray-900 dark:text-gray-100">{children}</dd>
      {hint && <dd className="ui-bud-entry-hint text-xs text-gray-500 dark:text-gray-400">{hint}</dd>}
    </div>
  );
}

/**
 * The period's totals as a statement line: Budgeted, Spent, Remaining and
 * Savings as four ruled entries in ledger figures, and the ticked gauge under
 * them. Only an overspend takes the loss colour.
 */
export function BudgetSummaryClassic({
  totalBudgeted,
  totalSpent,
  remaining,
  totalIncome,
  percentUsed,
  daysRemaining,
  displayCurrency,
}: BudgetSummaryViewProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const projectedSavings = totalIncome - totalSpent;
  return (
    <section aria-label={t('summaryCards.ariaLabel')} className="ui-bud-statement">
      <dl className="ui-bud-statement-row">
        <Entry label={t('summaryCards.totalBudget')}>
          <MoneyFigure amount={totalBudgeted} currencyCode={displayCurrency} display />
        </Entry>
        <Entry label={t('summaryCards.spent')} hint={`(${formatPercentTrimmed(Math.round(percentUsed))})`}>
          <span className={percentUsed > 100 ? LOSS : undefined}>
            <MoneyFigure amount={totalSpent} currencyCode={displayCurrency} display />
          </span>
        </Entry>
        <Entry
          label={t('summaryCards.remaining')}
          hint={daysRemaining > 0 ? t('summaryCards.days', { count: String(daysRemaining) }) : t('summaryCards.periodEnded')}
        >
          <span className={remaining < 0 ? LOSS : undefined}>
            <MoneyFigure amount={Math.abs(remaining)} currencyCode={displayCurrency} display />
          </span>
        </Entry>
        <Entry
          label={t('summaryCards.savings')}
          hint={projectedSavings >= 0 ? t('summaryCards.onTrack') : t('summaryCards.overBudget')}
        >
          <span className={projectedSavings < 0 ? LOSS : undefined}>
            <MoneyFigure amount={Math.abs(projectedSavings)} currencyCode={displayCurrency} display />
          </span>
        </Entry>
      </dl>
      <div className="mt-4">
        <BudgetProgressBar percentUsed={percentUsed} />
      </div>
    </section>
  );
}
