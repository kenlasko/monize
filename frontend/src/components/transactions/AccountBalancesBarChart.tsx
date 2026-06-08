'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
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
import { useIsMobile } from '@/hooks/useIsMobile';
import { ChartDownloadButton } from '@/components/ui/ChartDownloadButton';


// When the largest bar is at least this many times taller than the smallest,
// the "auto" mode switches to a log scale so small bars remain visible.
const AUTO_LOG_RATIO = 50;

// Past this many bars on desktop, x-axis account names are rotated vertical
// so they stop overlapping each other along the axis.
const DESKTOP_VERTICAL_AXIS_THRESHOLD = 10;

// Cap vertical x-axis labels at this many characters so an extra-long account
// name can't eat the whole chart height.
const VERTICAL_LABEL_MAX_LEN = 15;

function truncateAccountName(name: string): string {
  return name.length > VERTICAL_LABEL_MAX_LEN
    ? `${name.slice(0, VERTICAL_LABEL_MAX_LEN)}...`
    : name;
}

// Custom tick used when the x-axis is rotated vertical. textAnchor='start'
// combined with the 90deg rotation anchors the first character at the tick
// so the label's visual left edge sits flush with the x-axis line, rather
// than the label straddling the axis as the default centered tick does.
function VerticalAccountTick({
  x,
  y,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
}) {
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text
        textAnchor="start"
        fill="#6b7280"
        fontSize={12}
        transform="rotate(90)"
      >
        {truncateAccountName(String(payload?.value ?? ''))}
      </text>
    </g>
  );
}

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
            gainLossColor(data.balance)
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
  const t = useTranslations('transactions');
  const chartTitle = t('charts.accountBalances.title');
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [scaleMode, setScaleMode] = useState<ScaleMode>('auto');
  const isMobile = useIsMobile();

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

  // Mobile always uses fully vertical labels (matching desktop's dense view);
  // desktop switches to vertical once the bar count crosses the crowding threshold.
  const verticalXAxis = isMobile || chartData.length > DESKTOP_VERTICAL_AXIS_THRESHOLD;

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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {chartTitle}
        </h3>
        <div className="h-72 flex items-center justify-center">
          <Skeleton className="w-full h-full" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {chartTitle}
        </h3>
        <div className="h-72 flex items-center justify-center text-gray-500 dark:text-gray-400">
          <p>{t('charts.accountBalances.noData')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 min-h-[420px]">
      <div className="flex items-center justify-between mb-4 gap-2">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {chartTitle}
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex gap-1" role="group" aria-label={t('charts.accountBalances.scaleLabel')}>
            {(['auto', 'linear', 'log'] as const).map((mode) => {
              const isActive = scaleMode === mode;
              const label = t(`charts.accountBalances.${mode}`);
              const title = mode === 'auto' ? t('charts.accountBalances.autoTitle', { scale: effectiveScale }) : t('charts.accountBalances.scaleTitle', { label });
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
          <ChartDownloadButton chartRef={chartRef} filename={chartTitle} />
        </div>
      </div>

      <div
        ref={chartRef}
        className="h-72"
        style={{ minHeight: 288 }}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={chartData}
            margin={{ top: 20, right: isMobile ? 16 : 5, left: -10, bottom: 0 }}
            // Fire on clicks anywhere in the tooltip-highlighted column (not
            // just the bar rect). Prefer state.activeLabel -- which Recharts
            // sets to the active category whenever the cursor is in an
            // active column -- and fall back to activePayload for the direct
            // bar hit case.
            onClick={onAccountClick ? (state: any) => {
              const activeName: string | undefined = state?.activeLabel;
              const fromLabel = activeName
                ? chartData.find((d) => d.accountName === activeName)?.accountId
                : undefined;
              const accountId =
                fromLabel ?? state?.activePayload?.[0]?.payload?.accountId;
              if (accountId) onAccountClick(accountId);
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
              tick={
                verticalXAxis
                  ? <VerticalAccountTick />
                  : { fill: '#6b7280', fontSize: 12 }
              }
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
              interval={0}
              angle={0}
              textAnchor="middle"
              tickMargin={verticalXAxis ? 8 : 0}
              height={verticalXAxis ? 120 : 30}
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
            <Tooltip
              content={<AccountBalanceTooltip formatCurrency={formatCurrency} />}
              // Keep the highlight rect visually present but transparent to
              // pointer events so clicks fall through to BarChart's onClick.
              cursor={{ fill: '#e5e7eb', fillOpacity: 0.35, style: { pointerEvents: 'none' } }}
            />
            <Bar
              dataKey="absBalance"
              radius={[4, 4, 0, 0]}
              maxBarSize={50}
              onClick={onAccountClick ? (entry: any) => {
                // Recharts passes the data point as the first arg. With Cell
                // children the BarChart-level onClick can fail to populate
                // activePayload, so we read accountId straight off the bar.
                const accountId = entry?.accountId ?? entry?.payload?.accountId;
                if (accountId) onAccountClick(accountId);
              } : undefined}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.balance >= 0 ? '#22c55e' : '#ef4444'}
                />
              ))}
              {!isMobile && (
                <LabelList
                  dataKey="balance"
                  position="top"
                  formatter={(value: unknown) => formatCurrency(Number(value))}
                  style={{ fill: '#6b7280', fontSize: 11, fontWeight: 500 }}
                />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Summary footer */}
      {summary && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.accountBalances.average')}</div>
            <div
              className={`font-semibold ${
                gainLossColor(summary.avgBalance)
              }`}
            >
              {formatCurrency(summary.avgBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.accountBalances.total')}</div>
            <div
              className={`font-semibold ${
                gainLossColor(summary.total)
              }`}
            >
              {formatCurrency(summary.total)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('charts.accountBalances.accounts')}</div>
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              {summary.accountsCount.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
