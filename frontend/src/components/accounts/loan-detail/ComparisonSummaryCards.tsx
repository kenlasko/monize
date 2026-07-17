'use client';

import { useTranslations } from 'next-intl';
import {
  OverpaymentFrequency,
  ScenarioComparison,
  ScheduleFrequency,
  getPeriodsPerYear,
  overpaymentsPerYear,
  perPaymentExtraAmount,
} from '@/lib/loan-schedule';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';

interface ComparisonSummaryCardsProps {
  comparison: ScenarioComparison;
  currencyCode: string;
  /** The scenario's recurring overpayment (amount at its cadence), when any. */
  recurringOverpayment?: { amount: number; frequency?: OverpaymentFrequency };
  /** The loan's own payment cadence, needed to place a recurring overpayment. */
  loanFrequency?: ScheduleFrequency;
}

const FREQUENCY_LABEL_KEY: Record<OverpaymentFrequency, string> = {
  ONE_OFF: 'loanDetail.simulator.frequencyOneOff',
  WEEKLY: 'loanDetail.simulator.frequencyWeekly',
  BIWEEKLY: 'loanDetail.simulator.frequencyBiweekly',
  MONTHLY: 'loanDetail.simulator.frequencyMonthly',
  QUARTERLY: 'loanDetail.simulator.frequencyQuarterly',
  ANNUALLY: 'loanDetail.simulator.frequencyAnnually',
};

/**
 * Baseline-versus-scenario outcome cards: the new payoff date, time saved,
 * interest saved, the resulting monthly payment, and the total extra principal
 * the scenario contributes.
 */
export function ComparisonSummaryCards({
  comparison,
  currencyCode,
  recurringOverpayment,
  loanFrequency,
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

  const opAmount = recurringOverpayment?.amount ?? 0;
  const opFrequency = recurringOverpayment?.frequency;
  // A cadence sparser than the loan's payments (e.g. quarterly on a monthly
  // loan) does not fall on every payment, so it is not part of the regular
  // monthly payment -- it shows only as the periodic overpayment note below.
  const isSparse =
    !!opFrequency &&
    !!loanFrequency &&
    overpaymentsPerYear(opFrequency) > 0 &&
    overpaymentsPerYear(opFrequency) < getPeriodsPerYear(loanFrequency);
  const perPaymentExtra =
    opAmount > 0 && !isSparse
      ? opFrequency && loanFrequency
        ? perPaymentExtraAmount(opAmount, opFrequency, loanFrequency)
        : opAmount
      : 0;

  // The resulting monthly outlay: for lower-installment the recomputed smaller
  // installment; otherwise the unchanged installment plus any per-payment extra.
  const monthlyPayment = isLowerInstallment
    ? scenario.finalPaymentAmount
    : Math.round((scenario.finalPaymentAmount + perPaymentExtra) * 100) / 100;

  const overpaymentNote =
    !isLowerInstallment && opAmount > 0
      ? t('loanDetail.comparison.overpaymentAtFrequency', {
          frequency: t(FREQUENCY_LABEL_KEY[opFrequency ?? 'MONTHLY']),
          amount: formatCurrency(opAmount, currencyCode),
        })
      : undefined;

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
        subvalue={overpaymentNote}
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
  subvalue,
}: {
  label: string;
  value: string;
  valueClass: string;
  subvalue?: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-bold ${valueClass}`}>{value}</div>
      {subvalue && (
        <div className="mt-1 text-xs font-medium text-green-600 dark:text-green-400">
          {subvalue}
        </div>
      )}
    </div>
  );
}
