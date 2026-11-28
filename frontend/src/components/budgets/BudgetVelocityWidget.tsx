'use client';

import { useTranslations } from 'next-intl';
import type { BudgetVelocity } from '@/types/budget';
import { gainLossColor } from '@/lib/format';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useBudgetPartialReason } from '@/hooks/useBudgetPartialReason';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { CARD_CLASS } from '@/components/ui/Card';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { BudgetVelocityPebble } from './variants/BudgetVelocityPebble';

interface BudgetVelocityWidgetProps {
  velocity: BudgetVelocity;
  formatCurrency: (amount: number) => string;
}

function getPaceColor(paceStatus: NonNullable<BudgetVelocity['paceStatus']>): string {
  switch (paceStatus) {
    case 'under':
      return 'text-green-600 dark:text-green-400';
    case 'on_track':
      return 'text-blue-600 dark:text-blue-400';
    case 'over':
      return 'text-red-600 dark:text-red-400';
  }
}

function getPaceBgColor(paceStatus: NonNullable<BudgetVelocity['paceStatus']>): string {
  switch (paceStatus) {
    case 'under':
      return 'bg-green-50 dark:bg-green-900/20';
    case 'on_track':
      return 'bg-blue-50 dark:bg-blue-900/20';
    case 'over':
      return 'bg-red-50 dark:bg-red-900/20';
  }
}

const VARIANTS: StyleVariants<BudgetVelocityWidgetProps> = {
  standard: BudgetVelocityWidgetStandard,
  pebble: BudgetVelocityPebble,
};

/**
 * Pebble leads with the safe daily spend in an accent block; Folio is the
 * Standard layout, set in ledger figures by `ui-styles-budgets.css`.
 */
export function BudgetVelocityWidget(props: BudgetVelocityWidgetProps) {
  return renderForStyle(useUiStyle(), VARIANTS, props);
}

function BudgetVelocityWidgetStandard({
  velocity,
  formatCurrency,
}: BudgetVelocityWidgetProps) {
  const t = useTranslations('budgets');
  const tr = useTranslations('reports');
  const partialReason = useBudgetPartialReason();
  const pairs = velocity.projectionMissingRatePairs;
  const missingRate = pairs?.length ? tr('partialData.weightingNoRate', { pairs: pairs.join(', ') }) : undefined;
  const paceColor = velocity.paceStatus && getPaceColor(velocity.paceStatus);
  const paceBgColor = velocity.paceStatus && getPaceBgColor(velocity.paceStatus);
  // Why the figure is missing decides which screen fixes it: a named pair is a
  // display rate to refresh on Currencies, an unnamed shortfall is the
  // occurrence's own settlement rate. Read defensively -- an older backend
  // mid-deploy sends no field at all, which is "no information", not "no pairs".
  const unknownReason =
    (velocity.upcomingBillsMissingRates?.length ?? 0) > 0
      ? 'displayFx'
      : 'scheduledFx';
  // Unknown spending (a row with no exchange rate) withholds what is left, which
  // is a different cause and a different repair from an unpriced bill.
  const spendingUnknown = velocity.spendingComplete === false;
  const spendingReason = partialReason(velocity.spendingMissingRatePairs);
  const paceLabel = velocity.paceStatus && t(`velocity.paceStatus.${velocity.paceStatus}`);

  return (
    <div className={`${CARD_CLASS} p-4 sm:p-6`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center">
          {t('velocity.title')}
          <InfoTooltip text={t('velocity.titleTooltip')} learnMore="budgetVelocity" />
        </h2>
        {paceLabel && <span className={`px-2.5 py-1 text-xs font-semibold rounded-full ${paceColor} ${paceBgColor}`}>
          {paceLabel}
        </span>}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            {t('velocity.dailyBurnRate')}
          </div>
          <div className="ui-bud-fig text-lg font-semibold text-gray-900 dark:text-gray-100">
            {velocity.dailyBurnRate === null ? <UnknownAmount reason="displayFx" reasonText={missingRate} /> : <>{formatCurrency(velocity.dailyBurnRate)}/day</>}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            {t('velocity.safeToSpend')}
          </div>
          {/* Derived from "truly available", so it is unknown whenever an
              upcoming bill's current amount is (issue #1247). A `?? 0` here
              would present the unknown as a measured zero. */}
          {velocity.safeDailySpend === null ? (
            <UnknownAmount reasonText={spendingUnknown ? spendingReason : undefined} />
          ) : (
            <div className="ui-bud-fig text-lg font-semibold text-green-600 dark:text-green-400">
              {formatCurrency(velocity.safeDailySpend)}/day
            </div>
          )}
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            {t('velocity.projectedMonthEnd')}
          </div>
          <div className={`ui-bud-fig text-lg font-semibold ${
            velocity.projectedVariance !== null && velocity.projectedVariance > 0
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-900 dark:text-gray-100'
          }`}>
            {velocity.projectedTotal === null ? <UnknownAmount reason="displayFx" reasonText={missingRate} /> : formatCurrency(velocity.projectedTotal)}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            {t('velocity.budgetTotal')}
          </div>
          <div className="ui-bud-fig text-lg font-semibold text-gray-900 dark:text-gray-100">
            {formatCurrency(velocity.budgetTotal)}
          </div>
        </div>
      </div>
      {/* Drawn when there is something to say: a positive total, or a total the
          server could not complete. Hiding the section on an incomplete total
          would make an unresolvable bill indistinguishable from no bills at all
          (issue #1247). */}
      {(velocity.totalUpcomingBills === null ||
        velocity.totalUpcomingBills > 0) && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              {t('velocity.billsComing')}
            </div>
            {velocity.totalUpcomingBills === null ? (
              <UnknownAmount reason={unknownReason} />
            ) : (
              <div className="ui-bud-fig text-lg font-semibold text-red-600 dark:text-red-400">
                {formatCurrency(velocity.totalUpcomingBills)}
              </div>
            )}
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              {t('velocity.trulyAvailable')}
            </div>
            {velocity.trulyAvailable === null ? (
              <UnknownAmount
                reason={unknownReason}
                reasonText={spendingUnknown ? spendingReason : undefined}
              />
            ) : (
              <div className={`ui-bud-fig text-lg font-semibold ${
                gainLossColor(velocity.trulyAvailable)
              }`}>
                {formatCurrency(Math.abs(velocity.trulyAvailable))}
                {velocity.trulyAvailable < 0 && t('velocity.over')}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
        <span>{t('velocity.dayProgress', { elapsed: String(velocity.daysElapsed), total: String(velocity.totalDays) })}</span>
        <span>{t('velocity.daysRemaining', { count: String(velocity.daysRemaining) })}</span>
      </div>
    </div>
  );
}
