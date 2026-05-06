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
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { createLogger } from '@/lib/logger';
import {
  INTRADAY_RANGES,
  buildIntradayCacheKey,
  readIntradayCache,
  writeIntradayCache,
  clearAllIntradayCache,
  computeTightYAxisDomain,
} from './portfolio-chart-utils';

const logger = createLogger('InvestmentChart');

const DAILY_RANGES = new Set(['1w', '1m', '3m', 'ytd', '1y', '2y']);

/**
 * The page-level Refresh button broadcasts this event so the chart can clear
 * its sessionStorage cache and re-fetch when viewing an intraday range.
 */
export const INVESTMENT_CHART_REFRESH_EVENT = 'monize:investment-chart-refresh';

const RANGE_STORAGE_KEY = 'monize-investments-chart-range';

interface InvestmentValueChartProps {
  accountIds?: string[];
  displayCurrency?: string | null;
  titleSuffix?: string;
}

export function InvestmentValueChart({ accountIds, displayCurrency, titleSuffix }: InvestmentValueChartProps) {
  const { formatCurrencyCompact, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [chartPoints, setChartPoints] = useState<Array<{ name: string; Value: number }>>([]);
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
    '1y',
  );
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({
    defaultRange: persistedRange,
    alignment: 'month',
  });
  // Mirror the active range into localStorage when the user changes it.
  const handleRangeChange = useCallback(
    (next: string) => {
      setDateRange(next);
      setPersistedRange(next);
    },
    [setDateRange, setPersistedRange],
  );

  const isIntraday = INTRADAY_RANGES.has(dateRange);
  const useDaily = !isIntraday && DAILY_RANGES.has(dateRange);

  // Determine the effective currency for display
  const foreignCurrency = displayCurrency && displayCurrency !== defaultCurrency
    ? displayCurrency
    : null;
  const effectiveCurrency = foreignCurrency || defaultCurrency || 'USD';

  const fmtVal = useCallback((value: number) => {
    if (foreignCurrency) return `${formatCurrencyCompact(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrencyCompact(value);
  }, [foreignCurrency, formatCurrencyCompact]);

  const fmtAxis = useCallback((value: number) => {
    if (foreignCurrency) return formatCurrencyAxis(value, foreignCurrency);
    return formatCurrencyAxis(value);
  }, [foreignCurrency, formatCurrencyAxis]);

  // Latest in-flight load token; lets us cancel stale results that resolve
  // out-of-order if the user clicks ranges quickly.
  const loadTokenRef = useRef(0);

  const formatIntradayLabel = useCallback(
    (iso: string, range: string) => {
      const d = new Date(iso);
      return range === '1d'
        ? format(d, 'HH:mm')
        : format(d, 'MMM d HH:mm');
    },
    [],
  );

  const loadDailyOrMonthly = useCallback(
    async (token: number) => {
      const { start, end } = resolvedRange;
      const params = {
        startDate: start,
        endDate: end,
        accountIds: accountIds?.length ? accountIds.join(',') : undefined,
        displayCurrency: foreignCurrency || undefined,
      };
      if (useDaily || isIntraday) {
        // 1W/1M intraday fallback also uses the daily endpoint.
        const data = await netWorthApi.getInvestmentsDaily(params);
        if (loadTokenRef.current !== token) return;
        setChartPoints(
          data.map((d) => ({
            name: format(parseLocalDate(d.date), 'MMM d, yyyy'),
            Value: d.value,
          })),
        );
      } else {
        const data = await netWorthApi.getInvestmentsMonthly(params);
        if (loadTokenRef.current !== token) return;
        setChartPoints(
          data.map((d) => ({
            name: format(parseLocalDate(d.month), 'MMM yyyy'),
            Value: d.value,
          })),
        );
      }
    },
    [resolvedRange, accountIds, foreignCurrency, useDaily, isIntraday],
  );

  const loadData = useCallback(
    async (opts: { skipCache?: boolean } = {}) => {
      const token = ++loadTokenRef.current;
      setIsLoading(true);
      setIntradayUnavailable(null);
      setIntradayFallbackNotice(null);
      try {
        if (isIntraday) {
          const cacheKey = buildIntradayCacheKey(
            dateRange,
            accountIds,
            effectiveCurrency,
          );
          const cached = !opts.skipCache ? readIntradayCache(cacheKey) : null;

          // Hydrate from cache immediately so the chart appears even before
          // the network round-trip resolves.
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
              accountIds: accountIds?.length ? accountIds.join(',') : undefined,
              displayCurrency: foreignCurrency || undefined,
            });
          } catch (error) {
            logger.error('Failed to load intraday data:', error);
            if (loadTokenRef.current !== token) return;
            setChartPoints([]);
            setIsLoading(false);
            return;
          }

          if (loadTokenRef.current !== token) return;

          writeIntradayCache(cacheKey, {
            fetchedAt: Date.now(),
            points: response.points,
            interval: response.interval,
            currency: response.currency,
            fallbackToDaily: response.fallbackToDaily,
            skippedSymbols: response.skippedSymbols,
          });

          if (response.fallbackToDaily) {
            // Some holdings (typically MSN-tracked) lack intraday support.
            if (dateRange === '1d') {
              // No sensible daily-resolution fallback for a single day.
              setChartPoints([]);
              setIntradayUnavailable({ skipped: response.skippedSymbols });
              setIsLoading(false);
              return;
            }
            // 1W / 1M: silently fall back to the daily-snapshot endpoint and
            // flag the title with a small warning icon so the user knows the
            // chart is at daily resolution rather than the requested intraday
            // resolution.
            setIntradayUnavailable(null);
            setIntradayFallbackNotice({ skipped: response.skippedSymbols });
            await loadDailyOrMonthly(token);
            return;
          }

          setChartPoints(
            response.points.map((p) => ({
              name: formatIntradayLabel(p.timestamp, dateRange),
              Value: p.value,
            })),
          );
        } else {
          await loadDailyOrMonthly(token);
        }
      } catch (error) {
        logger.error('Failed to load investment data:', error);
      } finally {
        if (loadTokenRef.current === token) {
          setIsLoading(false);
        }
      }
    },
    [
      isIntraday,
      dateRange,
      accountIds,
      effectiveCurrency,
      foreignCurrency,
      formatIntradayLabel,
      loadDailyOrMonthly,
    ],
  );

  useEffect(() => {
    if (isValid) {
      void loadData();
    }
  }, [isValid, loadData]);

  // Listen for the page-level Refresh button. When the user is on an intraday
  // range, drop the sessionStorage entry and re-fetch only this chart's data.
  useEffect(() => {
    const handler = () => {
      if (isIntraday) {
        clearAllIntradayCache();
        void loadData({ skipCache: true });
      }
    };
    window.addEventListener(INVESTMENT_CHART_REFRESH_EVENT, handler);
    return () => {
      window.removeEventListener(INVESTMENT_CHART_REFRESH_EVENT, handler);
    };
  }, [isIntraday, loadData]);

  const summary = useMemo(() => {
    if (chartPoints.length === 0) return { current: 0, change: 0, changePercent: 0 };
    const current = chartPoints[chartPoints.length - 1]?.Value || 0;
    const initial = chartPoints[0]?.Value || 0;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return { current, change, changePercent };
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

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ value: number; payload: { name: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            Portfolio: {fmtVal(payload[0].value)}
          </p>
        </div>
      );
    }
    return null;
  };

  // Only show the full-card skeleton on the very first load. Subsequent
  // range / filter changes keep the previous chart on screen so Recharts can
  // animate smoothly into the new data instead of unmounting and re-drawing
  // the whole card. The intraday path already does this via the sessionStorage
  // cache; this extends the same behaviour to daily/monthly ranges.
  if (isLoading && chartPoints.length === 0 && !intradayUnavailable) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
          <div className="h-80 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
      {/* Header with title and date range buttons */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
          Portfolio Value Over Time{titleSuffix ? ` (${titleSuffix})` : ''}
          {/* Background-load indicator: chart stays on screen during a refetch
              so Recharts can animate into the new data, but a portfolio with
              many securities can still take a few seconds (the backend pulls
              prices for every holding). Surface a small spinner + label so
              the user knows we're working. */}
          {isLoading && chartPoints.length > 0 && (
            <span
              className="inline-flex items-center gap-1.5 ml-2 text-xs font-normal text-gray-500 dark:text-gray-400"
              role="status"
              aria-live="polite"
              data-testid="chart-loading-indicator"
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
              data-testid="intraday-fallback-warning"
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
        <DateRangeSelector
          ranges={['1d', '1w', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']}
          value={dateRange}
          onChange={handleRangeChange}
          activeColour="bg-emerald-600"
          size="sm"
        />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Current Value</div>
          <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
            {fmtVal(summary.current)}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Change</div>
          <div className={`text-lg font-bold ${
            summary.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {summary.change >= 0 ? '+' : ''}{fmtVal(summary.change)}
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
      {intradayUnavailable ? (
        <div className="text-center py-12 px-4">
          <p className="text-sm text-gray-700 dark:text-gray-200 font-medium mb-1">
            Intraday view unavailable for this account mix
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            One or more holdings use a quote provider (MSN Money) that does not
            expose intraday data
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
            <AreaChart data={chartPoints} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
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
