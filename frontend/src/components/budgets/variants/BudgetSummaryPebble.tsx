'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CARD_CLASS } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { BudgetProgressBar } from '../BudgetProgressBar';
import type { BudgetSummaryViewProps } from './budget-summary-view';

function Block({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className={`${CARD_CLASS} ui-bud-block p-5`}>
      <div className="flex items-center justify-between gap-2">
        <dt className="ui-figure-label">{label}</dt>
        {aside}
      </div>
      <dd className="ui-bud-block-figure mt-2 text-3xl text-gray-900 dark:text-gray-50">{children}</dd>
    </div>
  );
}

/**
 * The period's totals as colour blocks: what is left in an accent block
 * (the figure a person opens the page for), then Budgeted, Spent and Savings
 * as white blocks, with the spend as a fat pill gauge.
 */
export function BudgetSummaryPebble({
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
    <section aria-label={t('summaryCards.ariaLabel')}>
      <dl className="ui-bud-blocks grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="ui-block-accent ui-bud-lead rounded-(--ui-radius-card) p-5 md:col-span-2 lg:col-span-1">
          <dt className="ui-figure-label">{t('summaryCards.remaining')}</dt>
          <dd className="ui-bud-lead-figure mt-2 text-5xl">
            {remaining !== null ? (
              <MoneyFigure amount={Math.abs(remaining)} currencyCode={displayCurrency} display />
            ) : (
              unknown
            )}
          </dd>
          <dd className="mt-3 flex flex-wrap gap-2 text-sm font-semibold">
            <span className="ui-bud-lead-pill">
              {remaining !== null && remaining < 0
                ? t('summaryCards.overBudget')
                : daysRemaining > 0
                  ? t('summaryCards.days', { count: String(daysRemaining) })
                  : t('summaryCards.periodEnded')}
            </span>
          </dd>
        </div>
        <Block label={t('summaryCards.totalBudget')}>
          <MoneyFigure amount={totalBudgeted} currencyCode={displayCurrency} display />
        </Block>
        <Block
          label={t('summaryCards.spent')}
          aside={
            spentKnown ? (
              <Badge variant={percentUsed > 100 ? 'red' : 'gray'}>
                {formatPercentTrimmed(Math.round(percentUsed))}
              </Badge>
            ) : undefined
          }
        >
          {spentKnown ? (
            <>
              <span className={percentUsed > 100 ? 'text-red-600 dark:text-red-400' : undefined}>
                <MoneyFigure amount={totalSpent} currencyCode={displayCurrency} display />
              </span>
              <div className="mt-3">
                <BudgetProgressBar percentUsed={percentUsed} />
              </div>
            </>
          ) : (
            unknown
          )}
        </Block>
        <Block
          label={t('summaryCards.savings')}
          aside={
            savingsKnown ? (
              <Badge variant={projectedSavings >= 0 ? 'green' : 'red'}>
                {projectedSavings >= 0 ? t('summaryCards.onTrack') : t('summaryCards.overBudget')}
              </Badge>
            ) : undefined
          }
        >
          {savingsKnown ? (
            <span className={projectedSavings < 0 ? 'text-red-600 dark:text-red-400' : undefined}>
              <MoneyFigure amount={Math.abs(projectedSavings)} currencyCode={displayCurrency} display />
            </span>
          ) : (
            unknown
          )}
        </Block>
      </dl>
    </section>
  );
}
