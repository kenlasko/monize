'use client';

import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import { PastImpactResult } from '@/lib/loan-past-impact';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';

interface PastImpactSectionProps {
  account: Account;
  /**
   * Precomputed by the parent, which also feeds `originalSchedule` into the
   * payoff chart's contractual curve -- so the "already saved" figures here and
   * the actual-vs-contractual gap on that one chart come from the same source.
   */
  impact: PastImpactResult | null;
}

/**
 * How overpayments already made have shortened the loan: extra principal paid,
 * months saved, and interest saved versus the original contractual schedule.
 * The balance-over-time comparison lives in the shared payoff chart (which
 * plots the same contractual curve), so this section is just the figures.
 */
export function PastImpactSection({ account, impact }: PastImpactSectionProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatCurrency } = useNumberFormat();

  if (!impact) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t('loanDetail.pastImpact.title')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('loanDetail.pastImpact.missingData')}
        </p>
      </div>
    );
  }

  const formatMonth = (date: string | null) =>
    date ? formatChartDate(date, 'MMM yyyy') : t('loanDetail.pastImpact.unknown');

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1 px-4 sm:px-0">
        {t('loanDetail.pastImpact.title')}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 px-4 sm:px-0">
        {t('loanDetail.pastImpact.description')}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 px-4 sm:px-0">
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {t('loanDetail.pastImpact.extraPrincipalPaid')}
          </div>
          <div className="text-lg font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(impact.extraPrincipalPaid, account.currencyCode)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t('loanDetail.pastImpact.extraPrincipalNote')}
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {t('loanDetail.pastImpact.monthsAlreadySaved')}
          </div>
          <div className="text-lg font-bold text-green-600 dark:text-green-400">
            {t('loanDetail.pastImpact.monthsValue', { count: impact.monthsAlreadySaved })}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t('loanDetail.pastImpact.payoffComparison', {
              original: formatMonth(impact.originalPayoffDate),
              current: formatMonth(impact.currentPayoffDate),
            })}
          </div>
        </div>
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {t('loanDetail.pastImpact.interestAlreadySaved')}
          </div>
          <div className="text-lg font-bold text-green-600 dark:text-green-400">
            {formatCurrency(impact.interestAlreadySaved, account.currencyCode)}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t('loanDetail.pastImpact.vsOriginalInterest', {
              amount: formatCurrency(impact.originalSchedule.totalInterest, account.currencyCode),
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
