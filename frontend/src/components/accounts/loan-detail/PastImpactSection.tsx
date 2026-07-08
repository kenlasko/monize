'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { format, parseISO } from 'date-fns';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Account } from '@/types/account';
import { LoanHistoryResult } from '@/lib/loan-history';
import { LoanRateChange } from '@/types/loan-rate-change';
import { computePastImpact } from '@/lib/loan-past-impact';
import { buildPayoffComparisonSeries } from './PayoffComparisonChart';
import { chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';

interface PastImpactSectionProps {
  account: Account;
  history: LoanHistoryResult;
  /** Persisted rate history; the baseline applies these steps as they happened */
  rateChanges?: LoanRateChange[];
}

/**
 * Shows how overpayments already made have shortened the loan: the original
 * contractual schedule versus the actual balance and current projection,
 * with months and interest already saved. With a rate history present, the
 * contractual baseline starts at the origination rate and follows the
 * recorded rate changes, so the comparison isolates the overpayment effect.
 */
export function PastImpactSection({
  account,
  history,
  rateChanges = [],
}: PastImpactSectionProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatCurrency, formatCurrencyCompact, formatCurrencyAxis } = useNumberFormat();

  const impact = useMemo(
    () => computePastImpact(account, history, undefined, rateChanges),
    [account, history, rateChanges],
  );

  const chartData = useMemo(() => {
    if (!impact) return [];
    // Reuse the comparison series merge: baseline slot = current projection,
    // scenario slot = the original contractual schedule
    const { points } = buildPayoffComparisonSeries(
      history.events,
      impact.currentProjection,
      impact.originalSchedule,
    );
    return points.map((point) => ({
      ...point,
      label: formatChartDate(`${point.monthKey}-01`, 'MMM yyyy'),
    }));
  }, [impact, history.events, formatChartDate]);

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
    date ? format(parseISO(date), 'MMM yyyy') : t('loanDetail.pastImpact.unknown');

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1 px-4 sm:px-0">
        {t('loanDetail.pastImpact.title')}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 px-4 sm:px-0">
        {t('loanDetail.pastImpact.description')}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6 px-4 sm:px-0">
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
              amount: formatCurrency(
                impact.originalSchedule.totalInterest,
                account.currencyCode,
              ),
            })}
          </div>
        </div>
      </div>

      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(value: number | string | undefined) =>
                value === undefined ? '' : formatCurrencyCompact(Number(value))
              }
            />
            <Legend />
            <Area
              type="monotone"
              dataKey="scenarioBalance"
              stroke={chartColors.axis}
              fill={chartColors.axis}
              fillOpacity={0.1}
              strokeWidth={2}
              strokeDasharray="2 4"
              name={t('loanDetail.pastImpact.seriesOriginal')}
              connectNulls={false}
            />
            <Area
              type="monotone"
              dataKey="historicalBalance"
              stroke={chartColors.expense}
              fill={chartColors.expense}
              fillOpacity={0.3}
              strokeWidth={2}
              name={t('loanDetail.pastImpact.seriesActual')}
              connectNulls={false}
            />
            <Area
              type="monotone"
              dataKey="baselineBalance"
              stroke={chartColors.primary}
              fill={chartColors.primary}
              fillOpacity={0.15}
              strokeWidth={2}
              strokeDasharray="6 3"
              name={t('loanDetail.pastImpact.seriesCurrent')}
              connectNulls={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
