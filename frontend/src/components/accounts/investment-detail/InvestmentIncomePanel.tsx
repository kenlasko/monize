'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { gainLossColor } from '@/lib/format';

interface InvestmentIncomePanelProps {
  /** `null` when a payment could not be expressed in `currencyCode`. */
  dividendInterestYtd: number | null;
  /** Why `dividendInterestYtd` is `null`. */
  dividendInterestUnknownReason?: 'displayFx' | 'unknownCurrency';
  /** `null` when a sale's gain is unknown; the gains that are known are `realizedGainsKnownYtd`. */
  realizedGainsYtd: number | null;
  realizedGainsKnownYtd?: number;
  currencyCode: string;
  isLoading: boolean;
}

/** Year-to-date investment income: dividends/interest plus realized gains. */
export function InvestmentIncomePanel({
  dividendInterestYtd,
  dividendInterestUnknownReason = 'displayFx',
  realizedGainsYtd,
  realizedGainsKnownYtd = 0,
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
          <div className="h-16 rounded bg-gray-100 dark:bg-gray-700 animate-pulse skeleton-shimmer" />
        ) : !hasIncome ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('income.empty')}</p>
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">
                {t('income.dividendsInterest')}
              </dt>
              <dd className="text-xl font-bold text-green-600 dark:text-green-400">
                {dividendInterestYtd === null ? (
                  <UnknownAmount reason={dividendInterestUnknownReason} />
                ) : (
                  formatCurrency(dividendInterestYtd, currencyCode)
                )}
              </dd>
              <dd className="text-xs text-gray-500 dark:text-gray-400">{t('income.ytd')}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">
                {t('income.realizedGains')}
              </dt>
              <dd
                className={`text-xl font-bold ${realizedGainsYtd === null ? '' : gainLossColor(realizedGainsYtd)}`}
              >
                {realizedGainsYtd === null ? (
                  <UnknownAmount reasonText={t('income.realizedUnknownReason')} />
                ) : (
                  formatCurrency(realizedGainsYtd, currencyCode)
                )}
              </dd>
              {realizedGainsYtd === null && (
                <dd className="text-xs text-gray-500 dark:text-gray-400">
                  {t('income.realizedKnownPart', {
                    amount: formatCurrency(realizedGainsKnownYtd, currencyCode),
                  })}
                </dd>
              )}
              <dd className="text-xs text-gray-500 dark:text-gray-400">{t('income.ytd')}</dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}
