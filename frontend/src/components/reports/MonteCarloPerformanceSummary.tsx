'use client';

import { PerformanceSummary } from '@/lib/monte-carlo';
import { InfoTooltip } from '@/components/ui/InfoTooltip';

export type SummaryRow = {
  label: string;
  description: string;
  band: PerformanceSummary[keyof PerformanceSummary];
  format: 'currency' | 'percent' | 'ratio';
};

export const PERFORMANCE_SUMMARY_HEADERS = [
  'Summary Statistics',
  '10th Percentile',
  '25th Percentile',
  '50th Percentile',
  '75th Percentile',
  '90th Percentile',
];

export function buildPerformanceSummaryRows(summary: PerformanceSummary): SummaryRow[] {
  return [
    {
      label: 'Time Weighted Rate of Return (nominal)',
      description:
        'Geometric mean of the simulated annual returns. Ignores cash flows and is reported in nominal terms (not adjusted for inflation).',
      band: summary.twrNominal,
      format: 'percent',
    },
    {
      label: 'Time Weighted Rate of Return (real)',
      description:
        'Geometric mean of the simulated annual returns, adjusted for inflation so the result is in today’s purchasing power.',
      band: summary.twrReal,
      format: 'percent',
    },
    {
      label: 'Portfolio End Balance (nominal)',
      description:
        'Final portfolio value at the end of the simulation horizon, in future-dollar (nominal) terms.',
      band: summary.endBalanceNominal,
      format: 'currency',
    },
    {
      label: 'Portfolio End Balance (real)',
      description:
        'Final portfolio value discounted back to today’s purchasing power using the inflation rate.',
      band: summary.endBalanceReal,
      format: 'currency',
    },
    {
      label: 'Annual Mean Return (nominal)',
      description:
        'Arithmetic average of the simulated annual returns. Always greater than or equal to the time-weighted return when volatility is non-zero.',
      band: summary.meanReturnNominal,
      format: 'percent',
    },
    {
      label: 'Annualized Volatility',
      description:
        'Standard deviation of the simulated annual returns — a measure of how much returns vary year-to-year.',
      band: summary.annualizedVolatility,
      format: 'percent',
    },
    {
      label: 'Maximum Drawdown',
      description:
        'Largest peak-to-trough drop in portfolio value during the simulation, including the effect of contributions and withdrawals.',
      band: summary.maxDrawdown,
      format: 'percent',
    },
    {
      label: 'Maximum Drawdown Excluding Cashflows',
      description:
        'Largest peak-to-trough drop driven purely by investment returns, ignoring contributions and withdrawals.',
      band: summary.maxDrawdownExcludingCashflows,
      format: 'percent',
    },
    {
      label: 'Safe Withdrawal Rate',
      description:
        'Largest constant inflation-adjusted withdrawal, expressed as a percentage of the starting balance, that exactly depletes the portfolio at the end of the horizon.',
      band: summary.safeWithdrawalRate,
      format: 'percent',
    },
    {
      label: 'Perpetual Withdrawal Rate',
      description:
        'Largest constant inflation-adjusted withdrawal, as a percentage of the starting balance, that preserves the real value of the portfolio at the end of the horizon.',
      band: summary.perpetualWithdrawalRate,
      format: 'percent',
    },
  ];
}

export function formatSummaryValue(
  v: number,
  kind: SummaryRow['format'],
  formatCurrency: (v: number) => string,
): string {
  if (!Number.isFinite(v)) return '—';
  if (kind === 'currency') return formatCurrency(v);
  if (kind === 'percent') return `${(v * 100).toFixed(2)}%`;
  return v.toFixed(2);
}

export function PerformanceSummaryTable({
  summary,
  formatCurrency,
}: {
  summary: PerformanceSummary;
  formatCurrency: (v: number) => string;
}) {
  const rows = buildPerformanceSummaryRows(summary);
  const formatValue = (v: number, kind: SummaryRow['format']): string =>
    formatSummaryValue(v, kind, formatCurrency);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">
              Summary Statistics
            </th>
            <th className="px-3 py-2 text-right font-medium">10th Percentile</th>
            <th className="px-3 py-2 text-right font-medium">25th Percentile</th>
            <th className="px-3 py-2 text-right font-semibold text-gray-700 dark:text-gray-200 bg-blue-50 dark:bg-blue-900/30">
              50th Percentile
            </th>
            <th className="px-3 py-2 text-right font-medium">75th Percentile</th>
            <th className="px-3 py-2 text-right font-medium">90th Percentile</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="px-3 py-1.5 text-gray-900 dark:text-gray-100">
                {row.label}
                <InfoTooltip text={row.description} />
              </td>
              <td className="px-3 py-1.5 text-right">
                {formatValue(row.band.p10, row.format)}
              </td>
              <td className="px-3 py-1.5 text-right">
                {formatValue(row.band.p25, row.format)}
              </td>
              <td className="px-3 py-1.5 text-right font-semibold text-gray-900 dark:text-gray-100 bg-blue-50 dark:bg-blue-900/30">
                {formatValue(row.band.p50, row.format)}
              </td>
              <td className="px-3 py-1.5 text-right">
                {formatValue(row.band.p75, row.format)}
              </td>
              <td className="px-3 py-1.5 text-right">
                {formatValue(row.band.p90, row.format)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
