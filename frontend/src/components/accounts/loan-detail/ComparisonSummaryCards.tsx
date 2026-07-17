'use client';

import { useTranslations } from 'next-intl';
import { ScenarioComparison } from '@/lib/loan-schedule';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';

interface ComparisonSummaryCardsProps {
  comparison: ScenarioComparison;
  currencyCode: string;
  /** The scenario's recurring extra per payment, when any -- added to the
   *  installment to show the resulting monthly payment. */
  recurringExtra?: number;
}

/**
 * Baseline-versus-scenario outcome cards: the new payoff date, time saved,
 * interest saved, the resulting monthly payment, and the total extra principal
 * the scenario contributes.
 */
export function ComparisonSummaryCards({
  comparison,
  currencyCode,
  recurringExtra = 0,
}: ComparisonSummaryCardsProps) {
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

  // The resulting monthly outlay: for lower-installment the recomputed smaller
  // installment; otherwise the unchanged installment plus the recurring extra.
  const monthlyPayment = isLowerInstallment
    ? scenario.finalPaymentAmount
    : Math.round((scenario.finalPaymentAmount + recurringExtra) * 100) / 100;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
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
        label={t('loanDetail.comparison.monthlyPayment')}
        value={formatCurrency(monthlyPayment, currencyCode)}
        valueClass="text-gray-900 dark:text-gray-100"
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
