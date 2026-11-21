'use client';

import { CARD_CLASS } from '@/components/ui/Card';
import { useTranslations } from 'next-intl';
import { HoldingWithMarketValue } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';

interface HoldingsListProps {
  holdings: HoldingWithMarketValue[];
  isLoading: boolean;
}

export function HoldingsList({ holdings, isLoading }: HoldingsListProps) {
  const t = useTranslations('investments');
  const { formatCurrency, formatCurrencyPrecise, formatSignedPercent, formatQuantity } = useNumberFormat();

  const formatMoney = (value: number | null) => {
    if (value === null) return '-';
    return formatCurrency(value);
  };

  // Per-share prices can be sub-penny (e.g. LSE pennies); expand precision so
  // they don't collapse to the currency's 2dp zero.
  const formatPrice = (value: number | null) => {
    if (value === null) return '-';
    return formatCurrencyPrecise(value);
  };

  const formatPercent = (value: number | null) => {
    if (value === null) return '-';
    return formatSignedPercent(value);
  };

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('holdingsList.title')}
        </h3>
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex justify-between">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-4 w-1/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('holdingsList.title')}
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          {t('holdingsList.noHoldings')}
        </p>
      </div>
    );
  }

  return (
    <div className={`${CARD_CLASS} overflow-hidden`}>
      <div className="p-6 pb-0">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('holdingsList.title')}
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                {t('holdingsList.symbolColumn')}
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                {t('holdingsList.sharesColumn')}
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                {t('holdingsList.avgCostColumn')}
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                {t('holdingsList.priceColumn')}
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                {t('holdingsList.marketValueColumn')}
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                {t('holdingsList.gainLossColumn')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {holdings.map((holding) => (
              <tr key={holding.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {holding.symbol}
                  </div>
                  <div
                    className="text-sm text-gray-500 dark:text-gray-400 whitespace-normal break-words sm:truncate sm:max-w-[150px]"
                    title={holding.name}
                  >
                    {holding.name}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-gray-900 dark:text-gray-100">
                  {formatQuantity(holding.quantity)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-gray-900 dark:text-gray-100">
                  {formatPrice(holding.averageCost)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-gray-900 dark:text-gray-100">
                  {formatPrice(holding.currentPrice)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right font-medium text-gray-900 dark:text-gray-100">
                  {formatMoney(holding.marketValue)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right">
                  <div className={`font-medium ${gainLossColor(holding.gainLoss ?? 0)}`}>
                    {formatMoney(holding.gainLoss)}
                  </div>
                  <div className={`text-sm ${gainLossColor(holding.gainLossPercent ?? 0)}`}>
                    {formatPercent(holding.gainLossPercent)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
