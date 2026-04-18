'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
  Cell,
} from 'recharts';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ChartDownloadButton } from '@/components/ui/ChartDownloadButton';

const CHART_TITLE = 'Account Balances';

// When the largest bar is at least this many times taller than the smallest,
// the "auto" mode switches to a log scale so small bars remain visible.
const AUTO_LOG_RATIO = 50;

type ScaleMode = 'auto' | 'linear' | 'log';
type EffectiveScale = 'linear' | 'log';

interface AccountBalancesBarChartProps {
  data: Array<{ accountId: string; accountName: string; balance: number }>;
  isLoading: boolean;
  currencyCode?: string;
  onAccountClick?: (accountId: string) => void;
}

interface ChartDataPoint {
  accountId: string;
  accountName: string;
  balance: number;
  absBalance: number;
}

function AccountBalanceTooltip({
  active,
  payload,
  formatCurrency,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDataPoint }>;
  formatCurrency: (v: number) => string;
}) {
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {data.accountName}
        </p>
        <p
          className={`text-lg font-semibold ${
            data.balance >= 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          {formatCurrency(data.balance)}
        </p>
      </div>
    );
  }
  return null;
}

export function AccountBalancesBarChart({
  data,
  isLoading,
  currencyCode,
  onAccountClick,
}: AccountBalancesBarChartProps) {
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [scaleMode, setScaleMode] = useState<ScaleMode>('auto');

  const formatCurrency = useCallback(
    (value: number) => formatCurrencyFull(value, currencyCode),
    [formatCurrencyFull, currencyCode],
  );

  const formatAxis = useCallback(
    (value: number) => formatCurrencyAxis(value, currencyCode),
    [formatCurrencyAxis, currencyCode],
  );

  const chartData = useMemo<ChartDataPoint[]>(() => {
    return data.map((d) => ({
      accountId: d.accountId,
      accountName: d.accountName,
      balance: d.balance,
      absBalance: Math.abs(d.balance),
    }));
  }, [data]);

  // A log scale is preferred whenever the largest bar dwarfs the smallest,
  // otherwise the small bars collapse to zero-height. The threshold is chosen
  // to leave similar-magnitude datasets alone.
  const autoPrefersLog = useMemo(() => {
    if (chartData.length < 2) return false;
    let max = 0;
    let min = Infinity;
    for (const d of chartData) {
      if (d.absBalance <= 0) continue;
      if (d.absBalance > max) max = d.absBalance;
      if (d.absBalance < min) min = d.absBalance;
    }
    if (min === Infinity || min <= 0) return false;
    return max / min >= AUTO_LOG_RATIO;
  }, [chartData]);

  const effectiveScale: EffectiveScale =
    scaleMode === 'auto' ? (autoPrefersLog ? 'log' : 'linear') : scaleMode;

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const totalCents = chartData.reduce(
      (sum, d) => sum + Math.round(d.balance * 10000),
      0,
    );
    const total = totalCents / 10000;
    const avgBalance = total / chartData.length;
    return { total, avgBalance, accountsCount: chartData.length };
  }, [chartData]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {CHART_TITLE}
        </h3>
        <div className="h-72 flex items-center justify-center">
          <div className="animate-pulse w-full h-full bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {CHART_TITLE}
        </h3>
        <div className="h-72 flex items-center justify-center text-gray-500 dark:text-gray-400">
          <p>No account balance data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
      <div className="flex items-center justify-between mb-4 gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {CHART_TITLE}
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Y-axis scale">
            {(['auto', 'linear', 'log'] as const).map((mode) => {
              const isActive = scaleMode === mode;
              const label = mode[0].toUpperCase() + mode.slice(1);
              const title = mode === 'auto' ? `Auto (${effectiveScale})` : `${label} scale`;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setScaleMode(mode)}
                  aria-pressed={isActive}
                  title={title}
                  className={
                    isActive
                      ? 'px-2 py-1 text-xs rounded-md bg-blue-600 text-white transition-colors'
                      : 'px-2 py-1 text-xs rounded-md bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors'
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
          <ChartDownloadButton chartRef={chartRef} filename={CHART_TITLE} />
        </div>
      </div>

      <div ref={chartRef} className="h-72" style={{ minHeight: 288 }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={chartData}
            margin={{ top: 20, right: 5, left: -10, bottom: 0 }}
            onClick={onAccountClick ? (state: any) => {
              const accountId = state?.activePayload?.[0]?.payload?.accountId;
              if (!accountId) return;
              onAccountClick(accountId);
            } : undefined}
            style={onAccountClick ? { cursor: 'pointer' } : undefined}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#e5e7eb"
              className="dark:stroke-gray-700"
            />
            <XAxis
              dataKey="accountName"
              tick={{ fill: '#6b7280', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
              interval={0}
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatAxis}
              width={45}
              scale={effectiveScale}
              domain={effectiveScale === 'log' ? ['auto', 'auto'] : undefined}
              allowDataOverflow={false}
            />
            <Tooltip content={<AccountBalanceTooltip formatCurrency={formatCurrency} />} />
            <Bar
              dataKey="absBalance"
              radius={[4, 4, 0, 0]}
              maxBarSize={50}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.balance >= 0 ? '#22c55e' : '#ef4444'}
                />
              ))}
              <LabelList
                dataKey="balance"
                position="top"
                formatter={(value: unknown) => formatCurrency(Number(value))}
                style={{ fill: '#6b7280', fontSize: 11, fontWeight: 500 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Summary footer */}
      {summary && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Average</div>
            <div
              className={`font-semibold ${
                summary.avgBalance >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(summary.avgBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Total</div>
            <div
              className={`font-semibold ${
                summary.total >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(summary.total)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Accounts</div>
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              {summary.accountsCount.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
