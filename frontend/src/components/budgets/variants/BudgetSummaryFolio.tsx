'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
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
export function BudgetSummaryFolio({
  totalBudgeted,
  totalSpent,
  remaining,
  totalIncome,
  percentUsed,
  partialReason,
  daysRemaining,
  displayCurrency,
}: BudgetSummaryViewProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const spentKnown = totalSpent !== null && percentUsed !== null;
  const savingsKnown = totalSpent !== null && totalIncome !== null;
  const projectedSavings = savingsKnown ? totalIncome - totalSpent : 0;
  const unknown = <UnknownAmount reasonText={partialReason} />;
  return (
    <section aria-label={t('summaryCards.ariaLabel')} className="ui-bud-statement">
      <dl className="ui-bud-statement-row">
        <Entry label={t('summaryCards.totalBudget')}>
          <MoneyFigure amount={totalBudgeted} currencyCode={displayCurrency} display />
        </Entry>
        <Entry
          label={t('summaryCards.spent')}
          hint={spentKnown ? `(${formatPercentTrimmed(Math.round(percentUsed))})` : undefined}
        >
          {spentKnown ? (
            <span className={percentUsed > 100 ? LOSS : undefined}>
              <MoneyFigure amount={totalSpent} currencyCode={displayCurrency} display />
            </span>
          ) : (
            unknown
          )}
        </Entry>
        <Entry
          label={t('summaryCards.remaining')}
          hint={daysRemaining > 0 ? t('summaryCards.days', { count: String(daysRemaining) }) : t('summaryCards.periodEnded')}
        >
          {remaining !== null ? (
            <span className={remaining < 0 ? LOSS : undefined}>
              <MoneyFigure amount={Math.abs(remaining)} currencyCode={displayCurrency} display />
            </span>
          ) : (
            unknown
          )}
        </Entry>
        <Entry
          label={t('summaryCards.savings')}
          hint={savingsKnown ? (projectedSavings >= 0 ? t('summaryCards.onTrack') : t('summaryCards.overBudget')) : undefined}
        >
          {savingsKnown ? (
            <span className={projectedSavings < 0 ? LOSS : undefined}>
              <MoneyFigure amount={Math.abs(projectedSavings)} currencyCode={displayCurrency} display />
            </span>
          ) : (
            unknown
          )}
        </Entry>
      </dl>
      {percentUsed !== null && (
        <div className="mt-4">
          <BudgetProgressBar percentUsed={percentUsed} />
        </div>
      )}
    </section>
  );
}
