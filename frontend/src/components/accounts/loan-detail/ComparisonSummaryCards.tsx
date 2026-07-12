'use client';

import { useTranslations } from 'next-intl';
import { ScenarioComparison } from '@/lib/loan-schedule';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';

interface ComparisonSummaryCardsProps {
  comparison: ScenarioComparison;
  currencyCode: string;
}

/**
 * Baseline-versus-scenario outcome cards: the new payoff date, time saved,
 * interest saved, and the total extra principal the scenario contributes.
 */
export function ComparisonSummaryCards({ comparison, currencyCode }: ComparisonSummaryCardsProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { scenario } = comparison;

  const newPayoffLabel = scenario.payoffDate
    ? formatChartDate(scenario.payoffDate, 'MMM yyyy')
    : t('loanDetail.comparison.beyondProjection');

  // Lower-installment scenarios keep the end date (no time saved); their headline
  // outcome is the smaller installment instead.
  const isLowerInstallment = comparison.installmentReduction > 0.005;

  return (
    <div className="grid grid-cols-2 gap-4">
      <Card
        label={t('loanDetail.comparison.newPayoff')}
        value={newPayoffLabel}
        valueClass="text-purple-600 dark:text-purple-400"
      />
      {isLowerInstallment ? (
        <Card
          label={t('loanDetail.comparison.newInstallment')}
          value={t('loanDetail.comparison.installmentDrop', {
            payment: formatCurrency(scenario.finalPaymentAmount, currencyCode),
            reduction: formatCurrency(comparison.installmentReduction, currencyCode),
          })}
          valueClass="text-green-600 dark:text-green-400"
        />
      ) : (
        <Card
          label={t('loanDetail.comparison.timeSaved')}
          value={
            comparison.monthsSaved > 0
              ? t('loanDetail.comparison.monthsSaved', { count: comparison.monthsSaved })
              : t('loanDetail.comparison.paymentsSaved', { count: Math.max(comparison.paymentsSaved, 0) })
          }
          valueClass="text-green-600 dark:text-green-400"
        />
      )}
      <Card
        label={t('loanDetail.comparison.interestSaved')}
        value={formatCurrency(Math.max(comparison.interestSaved, 0), currencyCode)}
        valueClass="text-green-600 dark:text-green-400"
      />
      <Card
        label={t('loanDetail.comparison.totalExtraContributed')}
        value={formatCurrency(scenario.totalExtraPrincipal, currencyCode)}
        valueClass="text-blue-600 dark:text-blue-400"
      />
    </div>
  );
}

function Card({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}
