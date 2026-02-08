'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import { netWorthApi } from '@/lib/net-worth';
import { MonthlyInvestmentValue } from '@/types/net-worth';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { createLogger } from '@/lib/logger';

const logger = createLogger('InvestmentChart');

interface InvestmentValueChartProps {
  accountIds?: string[];
}

export function InvestmentValueChart({ accountIds }: InvestmentValueChartProps) {
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const [monthlyData, setMonthlyData] = useState<MonthlyInvestmentValue[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end } = resolvedRange;
      const data = await netWorthApi.getInvestmentsMonthly({
        startDate: start,
        endDate: end,
        accountIds: accountIds?.length ? accountIds.join(',') : undefined,
      });
      setMonthlyData(data);
    } catch (error) {
      logger.error('Failed to load investment data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [resolvedRange, accountIds]);

  useEffect(() => {
    if (isValid) {
      loadData();
    }
  }, [isValid, loadData]);

  const chartData = useMemo(() =>
    monthlyData.map((d) => ({
      name: format(parseLocalDate(d.month), 'MMM yyyy'),
      Value: d.value,
    })),
  [monthlyData]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return { current: 0, change: 0, changePercent: 0 };
    const current = chartData[chartData.length - 1]?.Value || 0;
    const initial = chartData[0]?.Value || 0;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return { current, change, changePercent };
  }, [chartData]);

  const xAxisTicks = useMemo(() => {
    if (chartData.length <= 36) return undefined;
    return chartData
      .filter(d => d.name.startsWith('Jan '))
      .map(d => d.name);
  }, [chartData]);

  const yAxisDomain = useMemo(() => {
    if (chartData.length === 0) return [0, 'auto'] as [number, 'auto'];

    const values = chartData.map(d => d.Value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue;

    if (minValue > 0 && minValue > range * 0.2) {
      const padding = range * 0.1;
      const rawMin = minValue - padding;
      const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawMin))));
      const niceMin = Math.floor(rawMin / magnitude) * magnitude;
      return [niceMin, 'auto'] as [number, 'auto'];
    }

    return [Math.min(0, minValue), 'auto'] as [number, 'auto'];
  }, [chartData]);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ value: number; payload: { name: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            Portfolio: {formatCurrency(payload[0].value)}
          </p>
        </div>
      );
    }
    return null;
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
          <div className="h-80 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      {/* Header with title and date range buttons */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Portfolio Value Over Time
        </h3>
        <DateRangeSelector
          ranges={['1y', '2y', '5y', 'all']}
          value={dateRange}
          onChange={setDateRange}
          activeColour="bg-emerald-600"
          size="sm"
        />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Current Value</div>
          <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(summary.current)}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Change</div>
          <div className={`text-lg font-bold ${
            summary.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {summary.change >= 0 ? '+' : ''}{formatCurrency(summary.change)}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Change %</div>
          <div className={`text-lg font-bold ${
            summary.changePercent >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {summary.changePercent >= 0 ? '+' : ''}{summary.changePercent.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Chart */}
      {chartData.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          No investment data for this period.
        </p>
      ) : (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorInvestments" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12 }}
                {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                tickFormatter={(value: string) => {
                  if (chartData.length > 36) {
                    return value.split(' ')[1] || value;
                  } else if (chartData.length > 18) {
                    const parts = value.split(' ');
                    return parts.length === 2 ? `${parts[0]} '${parts[1].slice(2)}` : value;
                  }
                  return value.split(' ')[0];
                }}
              />
              <YAxis
                domain={yAxisDomain}
                tickFormatter={formatCurrencyAxis}
                tick={{ fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="Value"
                stroke="#10b981"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorInvestments)"
                name="Portfolio Value"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
