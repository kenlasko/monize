'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import type { SecurityDetail } from '@/types/investment';

interface SecurityPositionStateProps {
  detail: SecurityDetail;
}

/**
 * Stands in for the summary cards when there is no position to summarise.
 *
 * Two different situations, told apart deliberately: a security sold down to
 * nothing has a realized result and a period it was held, which is worth
 * stating; one that was never traded has neither, and filling either case with
 * zeroes would claim a value of zero where the truth is "nothing here yet".
 */
export function SecurityPositionState({ detail }: SecurityPositionStateProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const { activity } = detail;

  if (!detail.hasTransactions) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-gray-600">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t('empty.noPosition')}
        </p>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('empty.noPositionHint')}
        </p>
      </div>
    );
  }

  const heldRange =
    activity.firstTransactionDate && activity.lastTransactionDate
      ? t('closed.heldRange', {
          start: formatDate(activity.firstTransactionDate),
          end: formatDate(activity.lastTransactionDate),
        })
      : null;

  return (
    <Card padding="sm">
      <div className="flex flex-wrap items-center gap-3">
        <Badge>{t('closed.title')}</Badge>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('closed.description')}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* In the holding account's currency, which is how the average-cost
            replay denominates it; omitted when sales spanned currencies and no
            single figure exists. */}
        {activity.realizedGain !== null &&
          activity.realizedGainCurrency !== null && (
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {t('closed.realizedPl')}
              </div>
              <div
                className={`text-lg font-bold ${gainLossColor(activity.realizedGain)}`}
              >
                {activity.realizedGain >= 0 ? '+' : ''}
                {formatCurrency(
                  activity.realizedGain,
                  activity.realizedGainCurrency,
                )}
              </div>
            </div>
          )}
        {activity.realizedGainComplete === false && (
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {t('closed.realizedPl')}
            </div>
            <div className="text-lg font-bold">
              <UnknownAmount reasonText={t('closed.realizedUnknownReason')} />
            </div>
            {activity.realizedGainKnownSubtotal != null &&
              activity.realizedGainCurrency !== null && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t('closed.realizedKnownPart', {
                    amount: formatCurrency(
                      activity.realizedGainKnownSubtotal,
                      activity.realizedGainCurrency,
                    ),
                  })}
                </div>
              )}
          </div>
        )}
        {heldRange && (
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {t('closed.heldFrom')}
            </div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {heldRange}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
