'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { GroupedTotal } from '@/types/transaction';
import { transactionsApi } from '@/lib/transactions';
import { CHART_SERIES, chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';
import { aggregateGroupedTotals, DisplayCurrencyStrategy } from './widget-shared';

const logger = createLogger('TagKeyBreakdownChart');

export interface TagKeyBreakdownParams {
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  tagIds?: string[];
  search?: string;
  amountFrom?: number;
  amountTo?: number;
}

interface TagKeyBreakdownChartProps {
  /** The tag key to break spending down by (e.g. "country"). */
  tagKey: string;
  /** Active transaction-list filters so the chart reconciles with the list. */
  params: TagKeyBreakdownParams;
}

const TOP_N = 10;

function ChartTooltip({
  active,
  payload,
  fmt,
}: {
  active?: boolean;
  payload?: Array<{ payload: { name: string; value: number; percentage: number } }>;
  fmt: (v: number) => string;
}) {
  if (active && payload && payload.length) {
    const d = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
        <p className="text-gray-600 dark:text-gray-400">
          {fmt(d.value)} ({d.percentage.toFixed(1)}%)
        </p>
      </div>
    );
  }
  return null;
}

/**
 * A pie of spending grouped by the values of a single KEY:VALUE tag key, for
 * the transactions currently in view. Per-currency rows from the backend are
 * converted to one display currency (native when single-currency, otherwise
 * the user's default). The ten largest values are kept; the rest roll into an
 * "Other" slice. Overlap (a transaction tagged under several values) can push
 * the underlying totals past 100% of the list total -- shares here are of the
 * charted sum, so the pie itself always reads as parts of a whole.
 */
export function TagKeyBreakdownChart({ tagKey, params }: TagKeyBreakdownChartProps) {
  const t = useTranslations('transactions');
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();

  const [rows, setRows] = useState<GroupedTotal[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const paramsKey = JSON.stringify({ tagKey, params });

  useEffect(() => {
    let cancelled = false;
    const { tagKey: key, params: p } = JSON.parse(paramsKey);
    const load = async () => {
      setIsLoading(true);
      try {
        const res = await transactionsApi.getTagKeyBreakdown({ key, ...p });
        if (!cancelled) setRows(res);
      } catch (error) {
        logger.error(error);
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [paramsKey]);

  const { chartData, displayCurrency } = useMemo(() => {
    const currencies = new Set(rows.map((r) => r.currencyCode));
    const strategy: DisplayCurrencyStrategy =
      currencies.size <= 1
        ? {
            displayCurrency: [...currencies][0] ?? defaultCurrency,
            toDisplay: (amount) => amount,
          }
        : {
            displayCurrency: defaultCurrency,
            toDisplay: (amount, from) => convertToDefault(amount, from),
          };

    const aggregated = aggregateGroupedTotals(rows, strategy).map((r) => ({
      name: r.name ?? '',
      value: Math.abs(r.total),
    }));

    const top = aggregated.slice(0, TOP_N);
    const rest = aggregated.slice(TOP_N);
    const otherValue = rest.reduce(
      (sum, r) => sum + Math.round(r.value * 10000),
      0,
    ) / 10000;
    if (otherValue > 0.0001) {
      top.push({ name: t('tagKeyBreakdown.other'), value: otherValue });
    }

    const total = top.reduce((sum, r) => sum + r.value, 0);
    const data = top.map((r, index) => ({
      ...r,
      percentage: total > 0 ? (r.value / total) * 100 : 0,
      color:
        r.name === t('tagKeyBreakdown.other')
          ? chartColors.axis
          : CHART_SERIES[index % CHART_SERIES.length],
    }));

    return { chartData: data, displayCurrency: strategy.displayCurrency };
  }, [rows, convertToDefault, defaultCurrency, t]);

  const fmt = (v: number) => formatCurrency(v, displayCurrency);

  const heading = (
    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
      {t('tagKeyBreakdown.title', { key: tagKey })}
    </h3>
  );

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        {heading}
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        {heading}
        <p className="text-gray-500 dark:text-gray-400">
          {t('tagKeyBreakdown.noData')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
      {heading}
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip fmt={fmt} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
        {chartData.map((item, index) => (
          <div key={index} className="flex items-center gap-2 text-sm">
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-gray-600 dark:text-gray-400 truncate">
              {item.name}
            </span>
            <span className="text-gray-900 dark:text-gray-100 ml-auto">
              {item.percentage.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
