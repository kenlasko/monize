'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface InvestmentIncomePanelProps {
  dividendInterestYtd: number;
  realizedGainsYtd: number;
  currencyCode: string;
  isLoading: boolean;
}

function gainClass(value: number): string {
  return value < 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400';
}

/** Year-to-date investment income: dividends/interest plus realized gains. */
export function InvestmentIncomePanel({
  dividendInterestYtd,
  realizedGainsYtd,
  currencyCode,
  isLoading,
}: InvestmentIncomePanelProps) {
  const t = useTranslations('accountDetail-investment');
  const { formatCurrency } = useNumberFormat();

  const hasIncome = dividendInterestYtd !== 0 || realizedGainsYtd !== 0;

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('income.title')}
      </h2>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {isLoading ? (
          <div className="h-16 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : !hasIncome ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('income.empty')}</p>
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">
                {t('income.dividendsInterest')}
              </dt>
              <dd className="text-xl font-bold text-green-600 dark:text-green-400">
                {formatCurrency(dividendInterestYtd, currencyCode)}
              </dd>
              <dd className="text-xs text-gray-500 dark:text-gray-400">{t('income.ytd')}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">
                {t('income.realizedGains')}
              </dt>
              <dd className={`text-xl font-bold ${gainClass(realizedGainsYtd)}`}>
                {formatCurrency(realizedGainsYtd, currencyCode)}
              </dd>
              <dd className="text-xs text-gray-500 dark:text-gray-400">{t('income.ytd')}</dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}
