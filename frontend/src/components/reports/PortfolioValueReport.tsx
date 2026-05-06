'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
import { investmentsApi } from '@/lib/investments';
import { PortfolioSummary } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { createLogger } from '@/lib/logger';
import {
  INTRADAY_RANGES,
  buildIntradayCacheKey,
  readIntradayCache,
  writeIntradayCache,
  computeTightYAxisDomain,
  renderChartFlagDot,
  ChartFlagShadowFilter,
} from '@/components/investments/portfolio-chart-utils';

const logger = createLogger('PortfolioValueReport');

const DAILY_RANGES = new Set(['1w', '1m', '3m', 'ytd', '1y']);
const RANGE_STORAGE_KEY = 'monize-reports-portfolio-value-range';

function CustomTooltip({ active, payload, fmtFull }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { name: string } }>;
  fmtFull: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
      <p className="text-sm text-emerald-600 dark:text-emerald-400">
        Portfolio: {fmtFull(payload[0].value)}
      </p>
    </div>
  );
}

export function PortfolioValueReport() {
  const { formatCurrencyCompact, formatCurrencyAxis, formatCurrencyFlag, formatCurrency: formatCurrencyFull } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartPoints, setChartPoints] = useState<Array<{ name: string; Value: number }>>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [intradayUnavailable, setIntradayUnavailable] = useState<{
    skipped: string[];
  } | null>(null);
  // Set when 1W/1M silently fall back to daily snapshots because one or more
  // holdings use a quote provider (MSN Money) without intraday support. We
  // surface a small warning icon next to the title so the user understands
  // why the chart resolution is coarser than the button label suggests.
  const [intradayFallbackNotice, setIntradayFallbackNotice] = useState<{
    skipped: string[];
  } | null>(null);
  const [persistedRange, setPersistedRange] = useLocalStorage<string>(
    RANGE_STORAGE_KEY,
    '2y',
  );
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({
    defaultRange: persistedRange,
    alignment: 'month',
  });
  const handleRangeChange = useCallback(
    (next: string) => {
      setDateRange(next);
      setPersistedRange(next);
    },
    [setDateRange, setPersistedRange],
  );

  const isIntraday = INTRADAY_RANGES.has(dateRange);
  const useDaily = !isIntraday && DAILY_RANGES.has(dateRange);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const foreignCurrency = selectedAccount?.currencyCode && selectedAccount.currencyCode !== defaultCurrency
    ? selectedAccount.currencyCode
    : null;
  const effectiveCurrency = foreignCurrency || defaultCurrency || 'USD';

  const fmtVal = useCallback((value: number) => {
    if (foreignCurrency) return `${formatCurrencyCompact(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrencyCompact(value);
  }, [foreignCurrency, formatCurrencyCompact]);

  const fmtFull = useCallback((value: number) => {
    if (foreignCurrency) return `${formatCurrencyFull(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrencyFull(value);
  }, [foreignCurrency, formatCurrencyFull]);

  const fmtAxis = useCallback((value: number) => {
    if (foreignCurrency) return formatCurrencyAxis(value, foreignCurrency);
    return formatCurrencyAxis(value);
  }, [foreignCurrency, formatCurrencyAxis]);

  // Flag bubble label: 2-decimal compact notation, more precise than the
  // 1-decimal axis tick formatter.
  const fmtFlag = useCallback((value: number) => {
    if (foreignCurrency) return formatCurrencyFlag(value, foreignCurrency);
    return formatCurrencyFlag(value);
  }, [foreignCurrency, formatCurrencyFlag]);

  // Sequence number for the latest in-flight load. Lets us drop stale
  // results so quick range/account switches can't write out-of-order data.
  const loadSeqRef = useRef(0);

  const formatIntradayLabel = useCallback(
    (iso: string, range: string) => {
      const d = new Date(iso);
      return range === '1d' ? format(d, 'HH:mm') : format(d, 'MMM d HH:mm');
    },
    [],
  );

  useEffect(() => {
    if (!isValid) return;
    const seq = ++loadSeqRef.current;

    const accountIds = selectedAccountId ? [selectedAccountId] : undefined;
    const accountIdsCsv = accountIds?.join(',');

    const loadDailyOrMonthly = async () => {
      const { start, end } = resolvedRange;
      const params = {
        startDate: start,
        endDate: end,
        accountIds: accountIdsCsv,
        displayCurrency: foreignCurrency || undefined,
      };
      if (useDaily || isIntraday) {
        const data = await netWorthApi.getInvestmentsDaily(params);
        if (loadSeqRef.current !== seq) return;
        setChartPoints(
          data.map((d) => ({
            name: format(parseLocalDate(d.date), 'MMM d, yyyy'),
            Value: d.value,
          })),
        );
      } else {
        const data = await netWorthApi.getInvestmentsMonthly(params);
        if (loadSeqRef.current !== seq) return;
        setChartPoints(
          data.map((d) => ({
            name: format(parseLocalDate(d.month), 'MMM yyyy'),
            Value: d.value,
          })),
        );
      }
    };

    const loadData = async () => {
      setIsLoading(true);
      setIntradayUnavailable(null);
      setIntradayFallbackNotice(null);

      try {
        // Portfolio summary + accounts list always load in parallel — they
        // drive the breakdown table and the account picker regardless of
        // which chart endpoint we hit. Swallow rejections here so a chart
        // fetch failure below doesn't leave this dangling as an unhandled
        // promise rejection (the outer catch logs the chart error).
        const summaryAndAccounts = Promise.all([
          investmentsApi.getPortfolioSummary(accountIds),
          investmentsApi.getInvestmentAccounts(),
        ]).catch((error) => {
          logger.error('Failed to load portfolio summary/accounts:', error);
          return null;
        });

        if (isIntraday) {
          const cacheKey = buildIntradayCacheKey(
            dateRange,
            accountIds,
            effectiveCurrency,
          );
          const cached = readIntradayCache(cacheKey);
          if (cached && !cached.fallbackToDaily) {
            setChartPoints(
              cached.points.map((p) => ({
                name: formatIntradayLabel(p.timestamp, dateRange),
                Value: p.value,
              })),
            );
            setIsLoading(false);
          }

          let response;
          try {
            response = await investmentsApi.getIntradayValue({
              range: dateRange as '1d' | '1w' | '1m',
              accountIds: accountIdsCsv,
              displayCurrency: foreignCurrency || undefined,
            });
          } catch (error) {
            logger.error('Failed to load intraday data:', error);
            if (loadSeqRef.current !== seq) return;
            // Silently fall back to the daily-snapshot endpoint so the
            // user still sees a chart instead of an empty card.
            await loadDailyOrMonthly();
            return;
          }

          if (loadSeqRef.current !== seq) return;

          writeIntradayCache(cacheKey, {
            fetchedAt: Date.now(),
            points: response.points,
            interval: response.interval,
            currency: response.currency,
            fallbackToDaily: response.fallbackToDaily,
            skippedSymbols: response.skippedSymbols,
            failedSymbols: response.failedSymbols ?? [],
          });

          if (response.fallbackToDaily) {
            if (dateRange === '1d') {
              // No sensible daily fallback for a single-day chart.
              setChartPoints([]);
              setIntradayUnavailable({ skipped: response.skippedSymbols });
            } else {
              // 1W / 1M silently fall back to the daily endpoint, with a
              // small warning icon next to the title so the user knows
              // intraday detail isn't available for this account mix.
              setIntradayFallbackNotice({ skipped: response.skippedSymbols });
              await loadDailyOrMonthly();
            }
          } else {
            setChartPoints(
              response.points.map((p) => ({
                name: formatIntradayLabel(p.timestamp, dateRange),
                Value: p.value,
              })),
            );
          }
        } else {
          await loadDailyOrMonthly();
        }

        const summaryAndAccountsResult = await summaryAndAccounts;
        if (loadSeqRef.current !== seq) return;
        if (summaryAndAccountsResult) {
          const [portfolioResult, accountsResult] = summaryAndAccountsResult;
          setPortfolio(portfolioResult);
          setAccounts(accountsResult);
        }
      } catch (error) {
        logger.error('Failed to load portfolio data:', error);
      } finally {
        if (loadSeqRef.current === seq) {
          setIsLoading(false);
        }
      }
    };

    loadData();
  }, [
    selectedAccountId,
    resolvedRange,
    isValid,
    foreignCurrency,
    effectiveCurrency,
    useDaily,
    isIntraday,
    dateRange,
    formatIntradayLabel,
  ]);

  const summary = useMemo(() => {
    if (chartPoints.length === 0) {
      return { change: 0, changePercent: 0, highest: 0, lowest: 0 };
    }
    const values = chartPoints.map((d) => d.Value);
    const highest = Math.max(...values);
    const lowest = Math.min(...values);
    const current = chartPoints[chartPoints.length - 1]?.Value || 0;
    const initial = chartPoints[0]?.Value || 0;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return { change, changePercent, highest, lowest };
  }, [chartPoints]);

  const xAxisTicks = useMemo(() => {
    if (chartPoints.length <= 36) return undefined;
    if (isIntraday || useDaily) {
      const step = Math.ceil(chartPoints.length / 7);
      return chartPoints.filter((_, i) => i % step === 0).map((d) => d.name);
    }
    return chartPoints
      .filter((d) => d.name.startsWith('Jan '))
      .map((d) => d.name);
  }, [chartPoints, isIntraday, useDaily]);

  const yAxisDomain = useMemo(
    () => computeTightYAxisDomain(chartPoints.map((d) => d.Value)),
    [chartPoints],
  );

  // Index of the first point at the highest / lowest value, for the
  // bubble callouts. Suppress when the series is flat.
  const highestIndex = useMemo(
    () =>
      chartPoints.length === 0
        ? -1
        : chartPoints.findIndex((p) => p.Value === summary.highest),
    [chartPoints, summary.highest],
  );
  const lowestIndex = useMemo(
    () =>
      chartPoints.length === 0
        ? -1
        : chartPoints.findIndex((p) => p.Value === summary.lowest),
    [chartPoints, summary.lowest],
  );
  const showFlags = summary.highest !== summary.lowest;

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const accountLabel = selectedAccount
      ? selectedAccount.name.replace(/ - (Brokerage|Cash)$/, '')
      : 'All Accounts';
    const breakdownHeaders = ['Account', 'Holdings', 'Cash', 'Total', 'Gain/Loss'];
    const breakdownRows = portfolio?.holdingsByAccount.map((acct) => [
      acct.accountName,
      fmtFull(acct.totalMarketValue),
      fmtFull(acct.cashBalance),
      fmtFull(acct.totalMarketValue + acct.cashBalance),
      `${acct.totalGainLoss >= 0 ? '+' : ''}${fmtFull(acct.totalGainLoss)}`,
    ]) || [];
    await exportToPdf({
      title: 'Portfolio Value',
      subtitle: accountLabel,
      summaryCards: [
        { label: 'Highest Value', value: fmtVal(summary.highest), color: '#111827' },
        { label: 'Lowest Value', value: fmtVal(summary.lowest), color: '#111827' },
        { label: 'Period Change', value: `${summary.change >= 0 ? '+' : ''}${fmtVal(summary.change)}`, color: summary.change >= 0 ? '#16a34a' : '#dc2626' },
        { label: 'Period Return', value: `${summary.changePercent >= 0 ? '+' : ''}${summary.changePercent.toFixed(1)}%`, color: summary.changePercent >= 0 ? '#16a34a' : '#dc2626' },
      ],
      chartContainer: chartRef.current,
      additionalTables: breakdownRows.length > 0 ? [{
        title: 'Current Portfolio Breakdown',
        headers: breakdownHeaders,
        rows: breakdownRows,
      }] : undefined,
      filename: 'portfolio-value',
    });
  };

  // Only show the full-card skeleton on the very first paint. Subsequent
  // range/account changes keep the existing chart on screen so Recharts can
  // animate into the new data instead of unmounting and re-drawing.
  if (isLoading && chartPoints.length === 0 && !intradayUnavailable) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Highest Value</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtVal(summary.highest)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Lowest Value</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtVal(summary.lowest)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Period Change</div>
          <div className={`text-xl font-bold ${summary.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {summary.change >= 0 ? '+' : ''}{fmtVal(summary.change)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Period Return</div>
          <div className={`text-xl font-bold ${summary.changePercent >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {summary.changePercent >= 0 ? '+' : ''}{summary.changePercent.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
            >
              <option value="">All Accounts</option>
              {accounts
                .filter((a) => a.accountSubType !== 'INVESTMENT_BROKERAGE')
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name.replace(/ - (Brokerage|Cash)$/, '')}
                  </option>
                ))}
            </select>
            <DateRangeSelector
              ranges={['1d', '1w', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']}
              value={dateRange}
              onChange={handleRangeChange}
              activeColour="bg-emerald-600"
            />
          </div>
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-1.5">
          Portfolio Value Over Time
          {/* Background-load indicator: chart stays on screen during a
              refetch so Recharts can animate into the new data, but a
              portfolio with many securities can take a few seconds. */}
          {isLoading && chartPoints.length > 0 && (
            <span
              className="inline-flex items-center gap-1.5 ml-2 text-xs font-normal text-gray-500 dark:text-gray-400"
              role="status"
              aria-live="polite"
              data-testid="report-chart-loading-indicator"
            >
              <svg
                className="animate-spin h-3.5 w-3.5"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Updating…
            </span>
          )}
          {intradayFallbackNotice && (
            <span
              role="img"
              aria-label="Detailed intraday pricing unavailable"
              title={`Detailed intraday pricing isn't available because ${intradayFallbackNotice.skipped.length > 0 ? intradayFallbackNotice.skipped.join(', ') : 'one or more holdings'} use MSN Money, which doesn't expose intraday quotes. Showing daily snapshots instead.`}
              className="inline-flex text-amber-500 dark:text-amber-400 cursor-help"
              data-testid="report-intraday-fallback-warning"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.345 0-2.188-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
            </span>
          )}
        </h3>
        {intradayUnavailable ? (
          <div className="text-center py-12 px-4">
            <p className="text-sm text-gray-700 dark:text-gray-200 font-medium mb-1">
              Intraday view unavailable for this account mix
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              One or more holdings use a quote provider (MSN Money) that does
              not expose intraday data
              {intradayUnavailable.skipped.length > 0
                ? `: ${intradayUnavailable.skipped.join(', ')}`
                : ''}
              . Switch to a longer range to see daily snapshots.
            </p>
          </div>
        ) : chartPoints.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No investment data for this period.
          </p>
        ) : (
          <div
            className={`h-80 transition-opacity duration-200 ${
              isLoading ? 'opacity-60' : 'opacity-100'
            }`}
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <AreaChart data={chartPoints} margin={{ top: 30, right: 30, left: 0, bottom: 30 }}>
                <defs>
                  <linearGradient id="colorPortfolioValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <ChartFlagShadowFilter />
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                  tickFormatter={(value: string) => {
                    if (isIntraday) {
                      return value;
                    }
                    if (useDaily) {
                      const parts = value.split(', ');
                      return parts[0] || value;
                    }
                    if (chartPoints.length > 36) {
                      return value.split(' ')[1] || value;
                    } else if (chartPoints.length > 18) {
                      const parts = value.split(' ');
                      return parts.length === 2 ? `${parts[0]} '${parts[1].slice(2)}` : value;
                    }
                    return value.split(' ')[0];
                  }}
                />
                <YAxis
                  domain={yAxisDomain}
                  tickFormatter={fmtAxis}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip content={<CustomTooltip fmtFull={fmtFull} />} />
                <Area
                  type="monotone"
                  dataKey="Value"
                  stroke="#10b981"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorPortfolioValue)"
                  name="Portfolio Value"
                  isAnimationActive={false}
                  dot={(props: { cx?: number; cy?: number; index?: number }) => {
                    const { cx, cy, index } = props;
                    if (cx == null || cy == null || index == null) {
                      return <circle cx={0} cy={0} r={0} fill="none" />;
                    }
                    const isHighest = showFlags && index === highestIndex;
                    const isLowest = showFlags && index === lowestIndex;
                    if (!isHighest && !isLowest) {
                      return <circle key={`dot-${index}`} cx={cx} cy={cy} r={0} fill="none" />;
                    }
                    const value = isHighest ? summary.highest : summary.lowest;
                    // Place the bubble to the side of its dot (with a horizontal
                    // connector) instead of above/below. This puts the bubble
                    // in the chart's middle vertical band -- well clear of the
                    // x-axis labels at the bottom and the top edge of the plot.
                    // Side is auto-picked based on the dot's position so the
                    // bubble stays inside the chart's left/right edges.
                    const isLeftHalf = index < chartPoints.length / 2;
                    return renderChartFlagDot({
                      cx,
                      cy,
                      index,
                      color: isHighest ? '#10b981' : '#ef4444',
                      label: fmtFlag(value),
                      side: isLeftHalf ? 'right' : 'left',
                    });
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Portfolio Breakdown */}
      {portfolio && portfolio.holdingsByAccount.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Current Portfolio Breakdown
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Account
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Holdings
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Cash
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Total
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Gain/Loss
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {portfolio.holdingsByAccount.map((acct) => (
                  <tr key={acct.accountId} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                      {acct.accountName}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {fmtFull(acct.totalMarketValue)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {fmtFull(acct.cashBalance)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {fmtFull(acct.totalMarketValue + acct.cashBalance)}
                    </td>
                    <td className={`px-4 py-3 text-right text-sm font-medium ${acct.totalGainLoss >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {acct.totalGainLoss >= 0 ? '+' : ''}{fmtFull(acct.totalGainLoss)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
