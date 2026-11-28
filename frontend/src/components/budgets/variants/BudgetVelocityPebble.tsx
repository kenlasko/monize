'use client';

import { useTranslations } from 'next-intl';
import type { BudgetVelocity } from '@/types/budget';
import { gainLossColor } from '@/lib/format';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { CARD_CLASS } from '@/components/ui/Card';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useBudgetPartialReason } from '@/hooks/useBudgetPartialReason';

interface BudgetVelocityPebbleProps {
  velocity: BudgetVelocity;
  formatCurrency: (amount: number) => string;
}

const PACE_BADGE: Record<NonNullable<BudgetVelocity['paceStatus']>, BadgeVariant> = {
  under: 'green',
  on_track: 'blue',
  over: 'red',
};

/**
 * The spending pace in Pebble: what is safe to spend each day is the figure,
 * in an accent block; the pace is a pill; the rest sit under it as plain
 * figures. The same figures and the same unknowns as the Standard widget
 * (`BudgetVelocityWidget`): an amount the server could not complete stays an
 * `UnknownAmount`, never a zero.
 */
export function BudgetVelocityPebble({ velocity, formatCurrency }: BudgetVelocityPebbleProps) {
  const t = useTranslations('budgets');
  const tr = useTranslations('reports');
  const partialReason = useBudgetPartialReason();
  const spendingReason =
    velocity.spendingComplete === false ? partialReason(velocity.spendingMissingRatePairs) : undefined;
  const pairs = velocity.projectionMissingRatePairs;
  const missingRate = pairs?.length ? tr('partialData.weightingNoRate', { pairs: pairs.join(', ') }) : undefined;
  const unknownReason =
    (velocity.upcomingBillsMissingRates?.length ?? 0) > 0 ? 'displayFx' : 'scheduledFx';
  return (
    <div className={`${CARD_CLASS} p-4 sm:p-6`}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('velocity.title')}
          <InfoTooltip text={t('velocity.titleTooltip')} learnMore="budgetVelocity" />
        </h2>
        {velocity.paceStatus && <Badge variant={PACE_BADGE[velocity.paceStatus]}>
          {t(`velocity.paceStatus.${velocity.paceStatus}`)}
        </Badge>}
      </div>
      <div className="ui-block-accent ui-bud-lead rounded-(--ui-radius-card) p-5">
        <div className="ui-figure-label">{t('velocity.safeToSpend')}</div>
        <div className="ui-bud-lead-figure mt-1 text-4xl">
          {velocity.safeDailySpend === null ? (
            <UnknownAmount reasonText={spendingReason} />
          ) : (
            <>
              {formatCurrency(velocity.safeDailySpend)}
              <span className="ml-1 text-base font-semibold">/day</span>
            </>
          )}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <dt className="text-sm text-gray-500 dark:text-gray-400">{t('velocity.dailyBurnRate')}</dt>
          <dd className="ui-bud-block-figure text-xl text-gray-900 dark:text-gray-100">
            {velocity.dailyBurnRate === null ? <UnknownAmount reason="displayFx" reasonText={missingRate} /> : <>{formatCurrency(velocity.dailyBurnRate)}/day</>}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-gray-500 dark:text-gray-400">{t('velocity.projectedMonthEnd')}</dt>
          <dd
            className={`ui-bud-block-figure text-xl ${
              velocity.projectedVariance !== null && velocity.projectedVariance > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'
            }`}
          >
            {velocity.projectedTotal === null ? <UnknownAmount reason="displayFx" reasonText={missingRate} /> : formatCurrency(velocity.projectedTotal)}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-gray-500 dark:text-gray-400">{t('velocity.budgetTotal')}</dt>
          <dd className="ui-bud-block-figure text-xl text-gray-900 dark:text-gray-100">
            {formatCurrency(velocity.budgetTotal)}
          </dd>
        </div>
        {(velocity.totalUpcomingBills === null || velocity.totalUpcomingBills > 0) && (
          <>
            <div>
              <dt className="text-sm text-gray-500 dark:text-gray-400">{t('velocity.billsComing')}</dt>
              <dd className="ui-bud-block-figure text-xl text-red-600 dark:text-red-400">
                {velocity.totalUpcomingBills === null ? (
                  <UnknownAmount reason={unknownReason} />
                ) : (
                  formatCurrency(velocity.totalUpcomingBills)
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-gray-500 dark:text-gray-400">{t('velocity.trulyAvailable')}</dt>
              <dd
                className={`ui-bud-block-figure text-xl ${
                  velocity.trulyAvailable === null ? '' : gainLossColor(velocity.trulyAvailable)
                }`}
              >
                {velocity.trulyAvailable === null ? (
                  <UnknownAmount reason={unknownReason} reasonText={spendingReason} />
                ) : (
                  <>
                    {formatCurrency(Math.abs(velocity.trulyAvailable))}
                    {velocity.trulyAvailable < 0 && t('velocity.over')}
                  </>
                )}
              </dd>
            </div>
          </>
        )}
      </dl>
      <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <span>
          {t('velocity.dayProgress', {
            elapsed: String(velocity.daysElapsed),
            total: String(velocity.totalDays),
          })}
        </span>
        <span>{t('velocity.daysRemaining', { count: String(velocity.daysRemaining) })}</span>
      </div>
    </div>
  );
}
