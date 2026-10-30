'use client';

import { useTranslations } from 'next-intl';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { computePositionReturn } from '@/lib/security-detail';
import type { SecurityDetail } from '@/types/investment';

interface SecurityPositionInfoCardProps {
  detail: SecurityDetail;
}

/**
 * Lifetime totals for this security: what went in, what came out, and where the
 * position stands now. Amounts are in the security's own currency, matching the
 * transaction table below.
 */
export function SecurityPositionInfoCard({
  detail,
}: SecurityPositionInfoCardProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatSignedPercent } = useNumberFormat();
  const { activity, security, position } = detail;
  const currency = security.currencyCode;

  const positionReturn = computePositionReturn({
    totalInvested: activity.totalInvested,
    marketValue: position.marketValue,
    costBasis: position.costBasis,
    dividends: activity.dividends,
    realizedGain: activity.realizedGain,
    realizedGainCurrency: activity.realizedGainCurrency,
    realizedSaleCount: activity.realizedSaleCount,
    securityCurrency: currency,
    isPositionClosed: detail.isPositionClosed,
  });

  const status = !detail.hasTransactions
    ? { label: t('positionInfo.statusNone'), tone: 'neutral' as const }
    : detail.isPositionClosed
      ? { label: t('positionInfo.statusClosed'), tone: 'neutral' as const }
      : { label: t('positionInfo.statusOpen'), tone: 'open' as const };

  // A security in the catalogue that was never traded has no lifetime totals,
  // and `formatCurrency(0)` is not the same statement as "there is nothing
  // here": four rows of $0.00 read as a position that lost everything. The card
  // already drops a row whose value is null (KeyValueList), so use that -- the
  // Status row saying "Never held" is the whole answer.
  const untraded = !detail.hasTransactions;
  const lifetimeTotal = (amount: number | null): string | null =>
    untraded || amount === null ? null : formatCurrency(amount, currency);

  const rows: KeyValueRow[] = [
    {
      key: 'firstTransaction',
      label: t('positionInfo.firstTransaction'),
      value: activity.firstTransactionDate
        ? formatDate(activity.firstTransactionDate)
        : null,
    },
    {
      key: 'lastTransaction',
      label: t('positionInfo.lastTransaction'),
      value: activity.lastTransactionDate
        ? formatDate(activity.lastTransactionDate)
        : null,
    },
    {
      key: 'totalInvested',
      label: t('positionInfo.totalInvested'),
      value: lifetimeTotal(activity.totalInvested),
    },
    {
      key: 'totalSold',
      label: t('positionInfo.totalSold'),
      value: lifetimeTotal(activity.totalSold),
    },
    {
      key: 'dividends',
      label: t('positionInfo.dividends'),
      value: lifetimeTotal(activity.dividends),
    },
    {
      key: 'fees',
      label: t('positionInfo.fees'),
      value: lifetimeTotal(activity.fees),
    },
    {
      key: 'realizedPl',
      label: t('positionInfo.realizedPl'),
      // Denominated in the holding account's currency, not the security's. When
      // sales spanned currencies the gains are real but not addable, so the row
      // says which currencies they sit in instead of going blank -- a blank row
      // is how "you never sold" reads, and that is a different statement.
      value:
        activity.realizedGain !== null &&
        activity.realizedGainCurrency !== null ? (
          <span className={gainLossColor(activity.realizedGain)}>
            {activity.realizedGain >= 0 ? '+' : ''}
            {formatCurrency(
              activity.realizedGain,
              activity.realizedGainCurrency,
            )}
          </span>
        ) : activity.realizedGainComplete === false ? (
          // A sale drew on shares of unknown cost: its gain is unknown, which
          // is not the same statement as "sold across currencies".
          // The sales whose cost is known are a part of the total, shown as
          // that and never in the figure's place.
          <>
            <UnknownAmount
              reasonText={t('positionInfo.realizedUnknownReason')}
            />
            {activity.realizedGainKnownSubtotal != null &&
              activity.realizedGainCurrency !== null && (
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  {t('positionInfo.realizedKnownPart', {
                    amount: formatCurrency(
                      activity.realizedGainKnownSubtotal,
                      activity.realizedGainCurrency,
                    ),
                  })}
                </span>
              )}
          </>
        ) : activity.realizedSaleCount > 0 ? (
          <span className="text-gray-500 dark:text-gray-400">
            {t('positionInfo.realizedMixed', {
              currencies: activity.realizedGainCurrencies.join(', '),
            })}
          </span>
        ) : null,
    },
    {
      key: 'totalReturn',
      label: t('positionInfo.totalReturn'),
      // What the holder made, as opposed to what the instrument did -- the
      // Performance card answers the latter. Absent whenever a component is
      // unknown or in another currency; see `computePositionReturn`.
      value:
        positionReturn === null ? null : (
          <span
            className={gainLossColor(positionReturn.profit)}
            title={t('positionInfo.totalReturnTitle')}
          >
            {/* Composed in the catalog, not here: the bracketing around a
                percentage is copy, and a locale may want it another way. */}
            {t('positionInfo.totalReturnValue', {
              amount: `${positionReturn.profit >= 0 ? '+' : ''}${formatCurrency(
                positionReturn.profit,
                currency,
              )}`,
              percent: formatSignedPercent(positionReturn.percent),
            })}
          </span>
        ),
    },
    {
      key: 'status',
      label: t('positionInfo.status'),
      value: (
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            status.tone === 'open'
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
          }`}
        >
          {status.label}
        </span>
      ),
    },
  ];

  return (
    <div className="flex h-full flex-col rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('positionInfo.title')}
      </h3>
      <KeyValueList rows={rows} />
    </div>
  );
}
