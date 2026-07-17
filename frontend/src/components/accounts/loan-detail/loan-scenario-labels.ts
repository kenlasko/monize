import type { LoanScenario } from '@/types/loan-scenario';
import type { OverpaymentFrequency, ScenarioComparison } from '@/lib/loan-schedule';

/** i18n key for each overpayment frequency's label, shared across the scenario
 *  summaries, table, chart and PDF so a saved cadence reads the same way. */
export const FREQUENCY_LABEL_KEY: Record<OverpaymentFrequency, string> = {
  ONE_OFF: 'loanDetail.simulator.frequencyOneOff',
  WEEKLY: 'loanDetail.simulator.frequencyWeekly',
  BIWEEKLY: 'loanDetail.simulator.frequencyBiweekly',
  MONTHLY: 'loanDetail.simulator.frequencyMonthly',
  QUARTERLY: 'loanDetail.simulator.frequencyQuarterly',
  ANNUALLY: 'loanDetail.simulator.frequencyAnnually',
};

/**
 * Formatting hooks the labels need, passed in by the caller so the same
 * wording renders in the SavedScenariosPanel table and in the loan page's
 * PDF export. Method syntax keeps `t` assignable from next-intl's narrower
 * translator type.
 */
export interface ScenarioLabelDeps {
  t(key: string, values?: Record<string, string | number>): string;
  formatCurrency(amount: number, currency?: string): string;
  formatChartDate(date: string, format: string): string;
  currencyCode: string;
}

/** The saved-scenario labels used by the comparison table and exports. */
export function createScenarioLabels({
  t,
  formatCurrency,
  formatChartDate,
  currencyCode,
}: ScenarioLabelDeps) {
  const describeScenario = (scenario: LoanScenario): string => {
    const parts: string[] = [];
    if (scenario.recurringExtraAmount && scenario.recurringExtraAmount > 0) {
      const freq = scenario.recurringExtraFrequency;
      parts.push(
        freq && freq !== 'MONTHLY'
          ? t('loanDetail.scenarios.overpaymentWithFrequency', {
              amount: formatCurrency(scenario.recurringExtraAmount, currencyCode),
              frequency: t(FREQUENCY_LABEL_KEY[freq]),
            })
          : t('loanDetail.scenarios.recurringSummary', {
              amount: formatCurrency(scenario.recurringExtraAmount, currencyCode),
            }),
      );
    }
    if (scenario.lumpSums.length > 0) {
      parts.push(
        t('loanDetail.scenarios.lumpSumSummary', { count: scenario.lumpSums.length }),
      );
    }
    return parts.join(' + ') || t('loanDetail.scenarios.emptyScenario');
  };

  // The saved recurring overpayment with its cadence (e.g. "$300.00
  // (Quarterly)"); a plain amount for a monthly/legacy cadence.
  const overpaymentLabel = (scenario: LoanScenario): string => {
    if (!scenario.recurringExtraAmount || scenario.recurringExtraAmount <= 0) return '—';
    const amount = formatCurrency(scenario.recurringExtraAmount, currencyCode);
    const freq = scenario.recurringExtraFrequency;
    return freq && freq !== 'MONTHLY'
      ? t('loanDetail.scenarios.overpaymentWithFrequency', {
          amount,
          frequency: t(FREQUENCY_LABEL_KEY[freq]),
        })
      : amount;
  };

  const payoffLabel = (comparison: ScenarioComparison | null): string =>
    comparison
      ? comparison.scenario.payoffDate
        ? formatChartDate(comparison.scenario.payoffDate, 'MMM yyyy')
        : t('loanDetail.comparison.beyondProjection')
      : '—';

  const timeSavedLabel = (comparison: ScenarioComparison | null): string => {
    if (!comparison) return '—';
    if (comparison.installmentReduction > 0.005) {
      return t('loanDetail.comparison.installmentDrop', {
        payment: formatCurrency(comparison.scenario.finalPaymentAmount, currencyCode),
        reduction: formatCurrency(comparison.installmentReduction, currencyCode),
      });
    }
    return comparison.monthsSaved > 0
      ? t('loanDetail.comparison.monthsSaved', { count: comparison.monthsSaved })
      : t('loanDetail.comparison.paymentsSaved', {
          count: Math.max(comparison.paymentsSaved, 0),
        });
  };

  const interestSavedLabel = (comparison: ScenarioComparison | null): string =>
    comparison
      ? formatCurrency(Math.max(0, comparison.interestSaved), currencyCode)
      : '—';

  /** The comparison table exactly as the panel displays it. */
  const comparisonTable = (
    scenarios: LoanScenario[],
    comparisons: Map<string, ScenarioComparison | null>,
  ): { headers: string[]; rows: string[][] } => ({
    headers: [
      t('loanDetail.scenarios.nameLabel'),
      t('loanDetail.scenarios.colOverpayment'),
      t('loanDetail.scenarios.colDetails'),
      t('loanDetail.comparison.newPayoff'),
      t('loanDetail.comparison.timeSaved'),
      t('loanDetail.comparison.interestSaved'),
    ],
    rows: scenarios.map((scenario) => {
      const comparison = comparisons.get(scenario.id) ?? null;
      return [
        scenario.name,
        overpaymentLabel(scenario),
        describeScenario(scenario),
        payoffLabel(comparison),
        timeSavedLabel(comparison),
        interestSavedLabel(comparison),
      ];
    }),
  });

  return {
    describeScenario,
    overpaymentLabel,
    payoffLabel,
    timeSavedLabel,
    interestSavedLabel,
    comparisonTable,
  };
}
