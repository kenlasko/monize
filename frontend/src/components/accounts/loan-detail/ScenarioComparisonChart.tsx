'use client';

import { useTranslations } from 'next-intl';
import { chartColors } from '@/lib/chart-colors';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';

export interface ScenarioOutcome {
  id: string;
  name: string;
  /** Extra paid on top of each installment; null when the scenario has none */
  recurringExtra: number | null;
  /** Number of one-time lump sums in the scenario */
  lumpSumCount: number;
  /** Interest saved vs the no-overpayment baseline */
  interestSaved: number;
  /** Projected payoff date (yyyy-MM-dd), or null when not paid off in range */
  payoffDate: string | null;
}

export interface BaselineOutcome {
  totalInterest: number;
  payoffDate: string | null;
}

interface ScenarioComparisonChartProps {
  outcomes: ScenarioOutcome[];
  baseline: BaselineOutcome;
  currencyCode: string;
}

/**
 * Compares saved overpayment scenarios side by side. Each row shows the three
 * figures that define a scenario's trade-off: what is paid extra per
 * installment, the interest that saves vs the no-overpayment baseline (also
 * the bar length), and the new payoff date. Every value is labelled directly,
 * so no tooltip layer is needed. Rendered only when more than one scenario is
 * saved; the baseline appears as a context line under the description.
 */
export function ScenarioComparisonChart({
  outcomes,
  baseline,
  currencyCode,
}: ScenarioComparisonChartProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatCurrency } = useNumberFormat();

  const sorted = [...outcomes].sort((a, b) => b.interestSaved - a.interestSaved);
  const maxSaved = Math.max(0, ...sorted.map((o) => o.interestSaved));

  const overpaymentLabel = (o: ScenarioOutcome): string => {
    const parts: string[] = [];
    if (o.recurringExtra && o.recurringExtra > 0) {
      parts.push(
        t('loanDetail.scenarios.recurringSummary', {
          amount: formatCurrency(o.recurringExtra, currencyCode),
        }),
      );
    }
    if (o.lumpSumCount > 0) {
      parts.push(t('loanDetail.scenarios.lumpSumSummary', { count: o.lumpSumCount }));
    }
    return parts.join(' + ') || t('loanDetail.scenarios.emptyScenario');
  };

  const payoffLabel = (payoffDate: string | null): string =>
    payoffDate
      ? formatChartDate(payoffDate, 'MMM yyyy')
      : t('loanDetail.comparison.beyondProjection');

  const rowGrid =
    'grid grid-cols-[minmax(9rem,16rem)_minmax(6rem,1fr)_auto_auto] items-center gap-x-4';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('loanDetail.scenarioChart.title')}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('loanDetail.scenarioChart.description')}
      </p>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('loanDetail.scenarioChart.baselineSummary', {
          interest: formatCurrency(baseline.totalInterest, currencyCode),
          date: payoffLabel(baseline.payoffDate),
        })}
      </p>
      <div className="overflow-x-auto">
        <div className="min-w-[36rem]">
          <div className={`${rowGrid} pb-2 border-b border-gray-200 dark:border-gray-700`}>
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('loanDetail.scenarios.nameLabel')}
            </span>
            <span />
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 text-right">
              {t('loanDetail.comparison.interestSaved')}
            </span>
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 text-right">
              {t('loanDetail.comparison.newPayoff')}
            </span>
          </div>
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {sorted.map((o) => (
              <li key={o.id} className={`${rowGrid} py-3`}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {o.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {overpaymentLabel(o)}
                  </p>
                </div>
                <div
                  className="h-4 rounded bg-gray-100 dark:bg-gray-700/50"
                  role="presentation"
                >
                  <div
                    className="h-full rounded"
                    style={{
                      backgroundColor: chartColors.primary,
                      width:
                        maxSaved > 0
                          ? `${(Math.max(0, o.interestSaved) / maxSaved) * 100}%`
                          : '0%',
                    }}
                  />
                </div>
                <span className="text-sm text-right whitespace-nowrap tabular-nums text-green-600 dark:text-green-400">
                  {formatCurrency(Math.max(0, o.interestSaved), currencyCode)}
                </span>
                <span className="text-sm text-right whitespace-nowrap text-purple-600 dark:text-purple-400">
                  {payoffLabel(o.payoffDate)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
