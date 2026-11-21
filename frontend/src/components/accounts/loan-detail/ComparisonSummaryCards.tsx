'use client';

import { useTranslations } from 'next-intl';
import {
  OverpaymentMode,
  RecurringOverpaymentFrequency,
  ScenarioComparison,
  ScheduleFrequency,
  getPeriodsPerYear,
  overpaymentsPerYear,
  perPaymentExtraAmount,
} from '@/lib/loan-schedule';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import {
  FREQUENCY_LABEL_KEY,
  frequencyLabelKey,
} from '@/components/accounts/loan-detail/loan-scenario-labels';
import { CARD_CLASS } from '@/components/ui/Card';

interface ComparisonSummaryCardsProps {
  comparison: ScenarioComparison;
  currencyCode: string;
  /** The scenario's recurring overpayment (amount at its cadence), when any. */
  recurringOverpayment?: {
    amount: number;
    frequency?: RecurringOverpaymentFrequency;
    /**
     * What the bank holds fixed. Supplied rather than inferred, because the
     * inference (`installmentReduction > 0`) is unavailable exactly when a
     * schedule was truncated -- and a LOWER_INSTALLMENT scenario read as
     * SHORTEN_TERM adds the overpayment on top of an already-reduced
     * installment and offers "time saved" for a plan that saves none.
     */
    mode?: OverpaymentMode;
  };
  /** The loan's own payment cadence, needed to place a recurring overpayment. */
  loanFrequency?: ScheduleFrequency;
  /** A fixed total monthly spend (budget mode): shown as the monthly payment. */
  fixedMonthlyPayment?: number;
}

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
  fixedMonthlyPayment,
}: ComparisonSummaryCardsProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { scenario } = comparison;

  const newPayoffLabel = scenario.payoffDate
    ? formatChartDate(scenario.payoffDate, 'MMM yyyy')
    : t('loanDetail.comparison.beyondProjection');

  // Lower-installment scenarios keep the end date (no time saved); their headline
  // outcome is the smaller installment instead. The plan's own mode decides that
  // where it is known; the installment-drop heuristic is the fallback for the
  // saved-scenarios table, which compares without a live plan. Reading the mode
  // off `installmentReduction` alone was wrong precisely when that value is null
  // -- a truncated schedule -- flipping the payment card to the wrong formula.
  //
  // A LINEAR or INTEREST_ONLY schedule has no level installment to report a
  // drop in (`levelInstallment === false`): its outcome is the time saved --
  // none, when the overpayment holds the term end -- and its payment card is
  // the first projected row's outlay rather than a "resulting" installment.
  const levelInstallment = scenario.levelInstallment !== false;
  const isLowerInstallment =
    levelInstallment &&
    (recurringOverpayment?.mode != null
      ? recurringOverpayment.mode === 'LOWER_INSTALLMENT'
      : (comparison.installmentReduction ?? 0) > 0.005);

  const opAmount = recurringOverpayment?.amount ?? 0;
  const opFrequency = recurringOverpayment?.frequency;
  // Presentation only. A cadence sparser than the loan's payments (e.g.
  // quarterly on a monthly loan) does not fall on every payment, so folding it
  // into "monthly payment" would misstate the regular outlay -- it shows as the
  // periodic overpayment note below instead. A denser or equal cadence is added
  // in as its per-payment AVERAGE (`perPaymentExtraAmount`); the schedule itself
  // applies each dated occurrence in full, so an individual row can carry more
  // or less than this figure.
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

  // The resulting monthly outlay: a fixed budget shows that budget as-is;
  // for lower-installment the recomputed smaller installment; otherwise the
  // unchanged installment plus any per-payment extra.
  //
  // Only the LOWER_INSTALLMENT branch loses its answer to truncation, and the
  // gate belongs there rather than over both. `finalPaymentAmount` is the level
  // installment at the last row PROJECTED: for LOWER_INSTALLMENT that is a
  // re-levelled figure mid-schedule, so a horizon-truncated plan has no
  // resulting installment to report. For SHORTEN_TERM the installment is the
  // contractual input the plan never changes, so it is known whether or not the
  // schedule reached payoff -- and `null` there printed "Unknown" over a figure
  // the borrower had typed in themselves. `null` means not known; a state that
  // IS known must not use it. A fixed budget is the borrower's own input and
  // stays known either way.
  const firstRow = scenario.rows[0];
  const monthlyPayment =
    fixedMonthlyPayment != null
      ? fixedMonthlyPayment
      : !levelInstallment
        ? firstRow
          ? Math.round((firstRow.payment + firstRow.extraPrincipal) * 100) / 100
          : null
        : isLowerInstallment
        ? scenario.paidOff
          ? // The overpayment IS the reduction here; adding it on top would
            // count the same money twice.
            scenario.finalPaymentAmount
          : null
        : Math.round((scenario.finalPaymentAmount + perPaymentExtra) * 100) / 100;

  const overpaymentNote =
    fixedMonthlyPayment == null && levelInstallment && !isLowerInstallment && opAmount > 0
      ? t('loanDetail.comparison.overpaymentAtFrequency', {
          // A saved cadence can be any string the column holds, and
          // `t(undefined)` throws -- so an unrecognised one reads as monthly
          // rather than taking the loan page down with it.
          frequency: t(
            frequencyLabelKey(opFrequency) ??
              FREQUENCY_LABEL_KEY.MONTHLY,
          ),
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
          // The drop is unknown when either schedule stopped at the horizon (the
          // scenario's "final" installment is then a mid-schedule one), so the
          // card says so rather than claiming a reduction of 0.00.
          value={
            comparison.installmentReduction == null
              ? t('loanDetail.comparison.unknown')
              : t('loanDetail.comparison.installmentDrop', {
                  payment: formatCurrency(scenario.finalPaymentAmount, currencyCode),
                  reduction: formatCurrency(comparison.installmentReduction, currencyCode),
                })
          }
          valueClass="text-green-600 dark:text-green-400"
        />
      ) : (
        <Card
          label={t('loanDetail.comparison.timeSaved')}
          // Both figures are null when either schedule ran past the projection
          // horizon: a horizon's length minus a lifetime's is not time saved,
          // and "0 payments" would read as "the overpayment bought nothing".
          value={
            comparison.monthsSaved == null || comparison.paymentsSaved == null
              ? t('loanDetail.comparison.unknown')
              : comparison.monthsSaved > 0
                ? t('loanDetail.comparison.monthsSaved', { count: comparison.monthsSaved })
                : t('loanDetail.comparison.paymentsSaved', {
                    count: Math.max(comparison.paymentsSaved, 0),
                  })
          }
          valueClass="text-green-600 dark:text-green-400"
        />
      )}
      <Card
        label={t('loanDetail.comparison.interestSaved')}
        // A saving is unknown when either schedule ran past the projection
        // horizon, and unknown is not zero -- say so rather than print 0.00.
        value={
          comparison.interestSaved == null
            ? t('loanDetail.comparison.unknown')
            : formatCurrency(Math.max(comparison.interestSaved, 0), currencyCode)
        }
        valueClass="text-green-600 dark:text-green-400"
      />
      <Card
        label={
          levelInstallment || fixedMonthlyPayment != null
            ? t('loanDetail.comparison.monthlyPayment')
            : t('loanDetail.comparison.firstPayment')
        }
        value={
          monthlyPayment == null
            ? t('loanDetail.comparison.unknown')
            : formatCurrency(monthlyPayment, currencyCode)
        }
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
    <div className={`${CARD_CLASS} p-4`}>
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
