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

const logger = createLogger('InvestmentChart');

// Ranges that pull intraday bars from the live quote provider. 1W/1M move
// from daily-snapshot data to intraday bars when every holding's provider
// supports it; otherwise the backend signals fallbackToDaily=true and we
// switch back to the existing daily endpoint.
const INTRADAY_RANGES = new Set(['1d', '1w', '1m']);
const DAILY_RANGES = new Set(['1w', '1m', '3m', 'ytd', '1y', '2y']);

/**
 * Frontend caches intraday responses in sessionStorage (per-tab). The
 * page-level Refresh button broadcasts this event so the chart can clear its
 * matching entry and re-fetch when the user is viewing an intraday range.
 */
export const INVESTMENT_CHART_REFRESH_EVENT = 'monize:investment-chart-refresh';

const RANGE_STORAGE_KEY = 'monize-investments-chart-range';
const INTRADAY_CACHE_PREFIX = 'monize-intraday|';

interface IntradayCachePayload {
  fetchedAt: number;
  points: Array<{ timestamp: string; value: number }>;
  interval: '1m' | '5m' | '15m';
  currency: string;
  fallbackToDaily: boolean;
  skippedSymbols: string[];
}

function buildIntradayCacheKey(
  range: string,
  accountIds: string[] | undefined,
  currency: string,
): string {
  const accts = (accountIds ?? []).slice().sort().join(',');
  return `${INTRADAY_CACHE_PREFIX}${range}|${accts}|${currency}`;
}

function readIntradayCache(key: string): IntradayCachePayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as IntradayCachePayload;
  } catch {
    return null;
  }
}

function writeIntradayCache(key: string, payload: IntradayCachePayload): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    logger.warn('Failed to write intraday cache:', error);
  }
}

function clearAllIntradayCache(): void {
  if (typeof window === 'undefined') return;
  try {
    const ss = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < ss.length; i++) {
      const k = ss.key(i);
      if (k && k.startsWith(INTRADAY_CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => ss.removeItem(k));
  } catch (error) {
    logger.warn('Failed to clear intraday cache:', error);
  }
}

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
            // 1W / 1M: silently fall back to the daily-snapshot endpoint.
            setIntradayUnavailable(null);
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

  const yAxisDomain = useMemo(() => {
    if (chartPoints.length === 0) return [0, 'auto'] as [number, 'auto'];

    const values = chartPoints.map(d => d.Value);
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
  }, [chartPoints]);

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

  if (isLoading) {
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
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Portfolio Value Over Time{titleSuffix ? ` (${titleSuffix})` : ''}
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
        <div className="h-80">
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
