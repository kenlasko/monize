'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { RateChangePoint } from '@/lib/loan-history';
import { chartColors } from '@/lib/chart-colors';
import { ChartTooltip } from '@/components/reports/ChartTooltip';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useDateFormat } from '@/hooks/useDateFormat';

interface RateHistorySidebarProps {
  /** The points where the effective rate changed, oldest first. */
  points: RateChangePoint[];
  /** Last payment date, to extend the final rate to the end of the chart. */
  endDate: string | null;
}

/**
 * A narrow rate-history panel for the loan detail page: a step chart of the
 * interest rate over the loan's life on top, and a compact table of the change
 * points (date + rate) below. Because the rate changes far less often than
 * payments happen, this is a dozen rows instead of hundreds -- a much faster
 * way to see how the rate moved. Sits beside the overpayment simulator on wide
 * screens and stacks below it on narrow ones.
 */
export function RateHistorySidebar({ points, endDate }: RateHistorySidebarProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatDate } = useDateFormat();

  const chartData = useMemo(() => {
    if (points.length === 0) return [];
    const rows = points.map((p) => ({ dateKey: p.date, rate: p.annualRate }));
    // Extend the last rate to the end of the timeline so the final step is
    // visible rather than collapsing to a single point.
    const last = points[points.length - 1];
    if (endDate && endDate > last.date) {
      rows.push({ dateKey: endDate, rate: last.annualRate });
    }
    return rows.map((r) => ({ ...r, label: formatChartDate(`${r.dateKey}`, 'MMM yyyy') }));
  }, [points, endDate, formatChartDate]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t('loanDetail.rateHistory.title')}
        </h3>
      </div>

      {points.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('loanDetail.rateHistory.empty')}
        </p>
      ) : (
        <>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
              {t('loanDetail.rateHistory.chartTitle')}
            </p>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={chartData} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    width={38}
                    domain={['auto', 'auto']}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <Tooltip
                    content={<ChartTooltip formatValue={(value) => `${value.toFixed(2)}%`} />}
                  />
                  <Line
                    type="stepAfter"
                    dataKey="rate"
                    stroke={chartColors.primary}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    name={t('loanDetail.rateHistory.chartTitle')}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="overflow-y-auto max-h-96">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  <th className="text-left font-medium py-1.5">
                    {t('loanDetail.rateHistory.colDate')}
                  </th>
                  <th className="text-right font-medium py-1.5">
                    {t('loanDetail.rateHistory.colRate')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {points.map((point) => (
                  <tr key={point.date}>
                    <td className="py-1.5 text-gray-900 dark:text-gray-100 whitespace-nowrap">
                      {formatDate(point.date)}
                    </td>
                    <td className="py-1.5 text-right font-medium text-blue-600 dark:text-blue-400 whitespace-nowrap">
                      {t('loanDetail.rateHistory.rateValue', { rate: point.annualRate })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
