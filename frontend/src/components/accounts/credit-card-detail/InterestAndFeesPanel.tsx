'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { InterestPaid } from '@/types/credit-card-detail';

interface InterestAndFeesPanelProps {
  interest: InterestPaid | null;
  currencyCode: string;
  isLoading: boolean;
}

/** Year-to-date interest and fees charged to the card. */
export function InterestAndFeesPanel({ interest, currencyCode, isLoading }: InterestAndFeesPanelProps) {
  const t = useTranslations('accountDetail-creditCard');
  const { formatCurrency } = useNumberFormat();

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('interestAndFees.title')}
      </h2>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {isLoading ? (
          <div className="h-12 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : !interest || interest.count === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('interestAndFees.none')}</p>
        ) : (
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                {formatCurrency(interest.amount, currencyCode)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{t('interestAndFees.ytd')}</div>
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {t('interestAndFees.charges', { count: interest.count })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
