'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { chartColors, chartSeriesColor } from '@/lib/chart-colors';
import { netWorthApi } from '@/lib/net-worth';
import { investmentsApi } from '@/lib/investments';
import { PortfolioSummary } from '@/types/investment';
import { InvestmentBreakdown, InvestmentBreakdownSeries } from '@/types/net-worth';
import { Account } from '@/types/account';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { exportToCsv } from '@/lib/csv-export';
import { createLogger } from '@/lib/logger';

type PortfolioBreakdownSortField = 'account' | 'holdings' | 'cash' | 'total' | 'gainLoss';
type PortfolioChartSortField = 'name' | 'value';
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

function CustomTooltip({ active, payload, fmtFull, portfolioLabel }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { name: string } }>;
  fmtFull: (v: number) => string;
  portfolioLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
      <p className="text-sm text-emerald-600 dark:text-emerald-400">
        {portfolioLabel} {fmtFull(payload[0].value)}
      </p>
    </div>
  );
}

function SecuritiesTooltip({ active, payload, fmtFull, totalLabel }: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload?: { name: string } }>;
  fmtFull: (v: number) => string;
  totalLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const name = payload[0]?.payload?.name;
  // Largest contribution first, so the tooltip reads top-down like the stack.
  const entries = payload
    .filter((e) => typeof e.value === 'number' && e.value !== 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = payload.reduce((sum, e) => sum + (e.value ?? 0), 0);
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 max-h-72 overflow-y-auto">
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{name}</p>
      {entries.map((e, i) => (
        <p key={i} className="text-sm flex items-center gap-2" style={{ color: e.color }}>
          <span className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: e.color }} />
          <span className="text-gray-600 dark:text-gray-300">{e.name}</span>
          <span className="ml-auto text-gray-900 dark:text-gray-100 whitespace-nowrap">{fmtFull(e.value ?? 0)}</span>
        </p>
      ))}
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mt-1 pt-1 border-t border-gray-100 dark:border-gray-700 flex items-center gap-2">
        <span>{totalLabel}</span>
        <span className="ml-auto whitespace-nowrap">{fmtFull(total)}</span>
      </p>
    </div>
  );
}

export function PortfolioValueReport() {
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const mainAccountName = useMainAccountName();
  const formatChartDate = useChartDateFormat();
  const { formatCurrencyCompact, formatCurrencyAxis, formatCurrencyFlag, formatCurrency: formatCurrencyFull, formatSignedPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartPoints, setChartPoints] = useState<Array<{ name: string; Value: number }>>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [chartViewType, setChartViewType] = useState<'area' | 'table'>('area');
  // Whether the chart stacks per-security contribution bands instead of a
  // single portfolio-total area. Persisted so the choice survives navigation.
  const [seriesMode, setSeriesMode] = useLocalStorage<'total' | 'securities'>(
    'monize-reports-portfolio-value-series-mode',
    'total',
  );
  const [breakdown, setBreakdown] = useState<InvestmentBreakdown | null>(null);
  // High/low value bubbles the user has temporarily dismissed, keyed by the
  // value they marked so a later data change with a new extreme shows the
  // bubble again. Component-local (not persisted), so it resets on navigation.
  const [dismissedHigh, setDismissedHigh] = useState<number | null>(null);
  const [dismissedLow, setDismissedLow] = useState<number | null>(null);
  const isSingleAccount = selectedAccountIds.length === 1;
  const { sortField, sortDirection, handleSort } = useSortableTable<PortfolioBreakdownSortField>(
    'reports.portfolio-value.breakdown.sort',
    { field: 'total', direction: 'desc' },
  );
  const chartTableSort = useSortableTable<PortfolioChartSortField>(
    'reports.portfolio-value.chart-table.sort',
    { field: 'name', direction: 'asc' },
  );
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

  // Per-security stacked view. Not offered for the single-day (1D) range, which
  // would collapse to a single point. It always reads the daily/monthly
  // breakdown endpoint (never intraday), so pick the point resolution to match
  // the selected range: daily for the shorter ranges, monthly for 2y/5y/all.
  const securitiesActive = seriesMode === 'securities' && dateRange !== '1d';
  const breakdownGranularity: 'daily' | 'monthly' =
    isIntraday || useDaily ? 'daily' : 'monthly';
  // X-axis label formatting must follow the data actually plotted. The
  // securities view never plots intraday bars, so drive the axis off the
  // breakdown granularity rather than the range's intraday/daily flags.
  const axisIntraday = securitiesActive ? false : isIntraday;
  const axisDaily = securitiesActive ? breakdownGranularity === 'daily' : useDaily;

  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
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
      return range === '1d' ? formatChartDate(d, 'HH:mm') : formatChartDate(d, 'MMM d HH:mm');
    },
    [formatChartDate],
  );

  useEffect(() => {
    if (!isValid) return;
    const seq = ++loadSeqRef.current;

    const accountIds = selectedAccountIds.length > 0 ? selectedAccountIds : undefined;
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
            name: formatChartDate(d.date, 'MMM d, yyyy'),
            Value: d.value,
          })),
        );
      } else {
        const data = await netWorthApi.getInvestmentsMonthly(params);
        if (loadSeqRef.current !== seq) return;
        setChartPoints(
          data.map((d) => ({
            name: formatChartDate(d.month, 'MMM yyyy'),
            Value: d.value,
          })),
        );
      }
    };

    const loadBreakdown = async () => {
      const { start, end } = resolvedRange;
      const data = await netWorthApi.getInvestmentsBreakdown({
        granularity: breakdownGranularity,
        startDate: start,
        endDate: end,
        accountIds: accountIdsCsv,
        displayCurrency: foreignCurrency || undefined,
      });
      if (loadSeqRef.current !== seq) return;
      setBreakdown(data);
      setChartPoints(
        data.points.map((p) => ({
          name:
            breakdownGranularity === 'monthly'
              ? formatChartDate(p.date, 'MMM yyyy')
              : formatChartDate(p.date, 'MMM d, yyyy'),
          Value: p.total,
        })),
      );
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

        if (securitiesActive) {
          await loadBreakdown();
        } else if (isIntraday) {
          setBreakdown(null);
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
          setBreakdown(null);
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
    selectedAccountIds,
    reloadKey,
    resolvedRange,
    isValid,
    foreignCurrency,
    effectiveCurrency,
    useDaily,
    isIntraday,
    dateRange,
    securitiesActive,
    breakdownGranularity,
    formatIntradayLabel,
    formatChartDate,
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

  const sortedChartTableData = useMemo(() => {
    const sorted = chartPoints.map((p, idx) => ({ ...p, index: idx }));
    sorted.sort((a, b) => {
      let comparison = 0;
      if (chartTableSort.sortField === 'name') {
        comparison = compareValues(a.index, b.index);
      } else {
        comparison = compareValues(a.Value, b.Value);
      }
      return chartTableSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartPoints, chartTableSort.sortField, chartTableSort.sortDirection]);

  const xAxisTicks = useMemo(() => {
    if (chartPoints.length <= 36) return undefined;
    if (axisIntraday || axisDaily) {
      const step = Math.ceil(chartPoints.length / 7);
      return chartPoints.filter((_, i) => i % step === 0).map((d) => d.name);
    }
    return chartPoints
      .filter((d) => d.name.startsWith('Jan '))
      .map((d) => d.name);
  }, [chartPoints, axisIntraday, axisDaily]);

  const yAxisDomain = useMemo(
    () =>
      // A stacked area builds up from zero, so anchor its axis at 0 rather than
      // zooming to the total's min/max (which would clip the lower bands).
      securitiesActive
        ? ([0, 'auto'] as [number, 'auto'])
        : computeTightYAxisDomain(chartPoints.map((d) => d.Value)),
    [chartPoints, securitiesActive],
  );

  // Localized label + stacking colour for each per-security band. Securities
  // cycle the categorical palette in stack order; cash and the rolled-up
  // "other" bucket get fixed, distinct tokens so they read consistently.
  const securitiesSeries = useMemo(() => {
    if (!breakdown) return [] as Array<InvestmentBreakdownSeries & { label: string; color: string }>;
    return breakdown.series.map((s, index) => ({
      ...s,
      label:
        s.type === 'cash'
          ? t('portfolioValue.seriesCash')
          : s.type === 'other'
            ? t('portfolioValue.seriesOther')
            : s.symbol || s.name,
      color:
        s.type === 'cash'
          ? chartColors.primary
          : s.type === 'other'
            ? chartColors.warning
            : chartSeriesColor(index),
    }));
  }, [breakdown, t]);

  const stackedChartData = useMemo(() => {
    if (!breakdown) return [] as Array<Record<string, number | string>>;
    return breakdown.points.map((p) => ({
      name:
        breakdownGranularity === 'monthly'
          ? formatChartDate(p.date, 'MMM yyyy')
          : formatChartDate(p.date, 'MMM d, yyyy'),
      total: p.total,
      ...p.values,
    }));
  }, [breakdown, breakdownGranularity, formatChartDate]);

  const sortedBreakdownRows = useMemo(() => {
    if (!breakdown) return [];
    const rows = breakdown.points.map((p, idx) => ({
      index: idx,
      name:
        breakdownGranularity === 'monthly'
          ? formatChartDate(p.date, 'MMM yyyy')
          : formatChartDate(p.date, 'MMM d, yyyy'),
      total: p.total,
      values: p.values,
    }));
    rows.sort((a, b) => {
      const comparison =
        chartTableSort.sortField === 'name'
          ? compareValues(a.index, b.index)
          : compareValues(a.total, b.total);
      return chartTableSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return rows;
  }, [breakdown, breakdownGranularity, formatChartDate, chartTableSort.sortField, chartTableSort.sortDirection]);

  // Shared x-axis label formatter for the total and stacked charts. Driven by
  // the axis granularity flags so the securities view (which never plots
  // intraday bars) labels correctly regardless of the range's intraday flag.
  const formatXAxisTick = useCallback(
    (value: string) => {
      if (axisIntraday) return value;
      if (axisDaily) {
        const parts = value.split(', ');
        return parts[0] || value;
      }
      if (chartPoints.length > 36) {
        return value.split(' ')[1] || value;
      }
      if (chartPoints.length > 18) {
        const parts = value.split(' ');
        return parts.length === 2 ? `${parts[0]} '${parts[1].slice(2)}` : value;
      }
      return value.split(' ')[0];
    },
    [axisIntraday, axisDaily, chartPoints.length],
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
      ? mainAccountName(selectedAccount.name)
      : t('portfolioValue.allAccounts');
    const breakdownHeaders = [t('portfolioValue.pdfColAccount'), t('portfolioValue.pdfColHoldings'), t('portfolioValue.pdfColCash'), t('portfolioValue.pdfColTotal'), t('portfolioValue.pdfColGainLoss')];
    const breakdownRows = portfolio?.holdingsByAccount.map((acct) => [
      acct.accountName,
      fmtFull(acct.totalMarketValue),
      fmtFull(acct.cashBalance),
      fmtFull(acct.totalMarketValue + acct.cashBalance),
      `${acct.totalGainLoss >= 0 ? '+' : ''}${fmtFull(acct.totalGainLoss)}`,
    ]) || [];
    await exportToPdf({
      title: t('portfolioValue.pdfTitle'),
      subtitle: accountLabel,
      summaryCards: [
        { label: t('portfolioValue.highestValue'), value: fmtVal(summary.highest), color: '#111827' },
        { label: t('portfolioValue.lowestValue'), value: fmtVal(summary.lowest), color: '#111827' },
        { label: t('portfolioValue.periodChange'), value: `${summary.change >= 0 ? '+' : ''}${fmtVal(summary.change)}`, color: summary.change >= 0 ? '#16a34a' : '#dc2626' },
        { label: t('portfolioValue.periodReturn'), value: formatSignedPercent(summary.changePercent, 1), color: summary.changePercent >= 0 ? '#16a34a' : '#dc2626' },
      ],
      chartContainer: chartRef.current,
      additionalTables: breakdownRows.length > 0 ? [{
        title: t('portfolioValue.pdfBreakdownTitle'),
        headers: breakdownHeaders,
        rows: breakdownRows,
      }] : undefined,
      filename: 'portfolio-value',
    });
  };

  const handleExportCsv = () => {
    if (securitiesActive && breakdown) {
      const headers = [
        t('portfolioValue.csvColDate'),
        ...securitiesSeries.map((s) => s.label),
        t('portfolioValue.colTotal'),
      ];
      const rows = sortedBreakdownRows.map((row) => [
        row.name,
        ...securitiesSeries.map((s) => row.values[s.key] ?? 0),
        row.total,
      ]);
      exportToCsv('portfolio-value-by-security', headers, rows);
      return;
    }
    const headers = [t('portfolioValue.csvColDate'), t('portfolioValue.csvColValue')];
    const rows = sortedChartTableData.map((p) => [p.name, p.Value]);
    exportToCsv('portfolio-value', headers, rows);
  };

  // Only show the full-card skeleton on the very first paint. Subsequent
  // range/account changes keep the existing chart on screen so Recharts can
  // animate into the new data instead of unmounting and re-drawing.
  if (isLoading && chartPoints.length === 0 && !intradayUnavailable) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('portfolioValue.highestValue')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtVal(summary.highest)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('portfolioValue.lowestValue')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtVal(summary.lowest)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('portfolioValue.periodChange')}</div>
          <div className={`text-xl font-bold ${gainLossColor(summary.change)}`}>
            {summary.change >= 0 ? '+' : ''}{fmtVal(summary.change)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('portfolioValue.periodReturn')}</div>
          <div className={`text-xl font-bold ${gainLossColor(summary.changePercent)}`}>
            {formatSignedPercent(summary.changePercent, 1)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2 items-center">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
            />
            <DateRangeSelector
              ranges={['1d', '1w', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']}
              value={dateRange}
              onChange={handleRangeChange}
              activeColour="bg-emerald-600"
            />
          </div>
          <div className="flex items-center gap-3">
            {/* Total vs. per-security stacked view. Disabled for the 1D range,
                which has too few points for a meaningful breakdown. */}
            <div className="inline-flex rounded-md overflow-hidden border border-gray-200 dark:border-gray-600">
              {(['total', 'securities'] as const).map((mode) => {
                const isActive = (securitiesActive ? 'securities' : 'total') === mode;
                const disabled = mode === 'securities' && dateRange === '1d';
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSeriesMode(mode)}
                    disabled={disabled}
                    aria-pressed={isActive}
                    title={disabled ? t('portfolioValue.securitiesRangeHint') : undefined}
                    className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-emerald-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {mode === 'total'
                      ? t('portfolioValue.viewTotal')
                      : t('portfolioValue.viewSecurities')}
                  </button>
                );
              })}
            </div>
            <ChartViewToggle
              value={chartViewType}
              onChange={(v) => setChartViewType(v as 'area' | 'table')}
              options={['area', 'table']}
              activeColour="bg-emerald-600"
            />
            <RefreshPricesButton onRefreshComplete={() => setReloadKey((k) => k + 1)} />
            <ExportDropdown
              onExportPdf={handleExportPdf}
              onExportCsv={handleExportCsv}
              disabled={chartPoints.length === 0}
            />
          </div>
        </div>
      </div>

      {/* Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-1.5">
          {t('portfolioValue.chartTitle')}
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
              {t('portfolioValue.updating')}
            </span>
          )}
          {intradayFallbackNotice && (
            <span
              role="img"
              aria-label={t('portfolioValue.intradayUnavailable')}
              title={intradayFallbackNotice.skipped.length > 0
                ? t('portfolioValue.intradayFallbackTitle', { symbols: intradayFallbackNotice.skipped.join(', ') })
                : t('portfolioValue.intradayFallbackTitleGeneric')}
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
              {t('portfolioValue.intradayUnavailableTitle')}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('portfolioValue.intradayUnavailableDesc', {
                skipped: intradayUnavailable.skipped.length > 0
                  ? t('portfolioValue.intradayUnavailableSkipped', { symbols: intradayUnavailable.skipped.join(', ') })
                  : '',
              })}
            </p>
          </div>
        ) : chartPoints.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('portfolioValue.noData')}
          </p>
        ) : securitiesActive && breakdown ? (
          chartViewType === 'table' ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <SortableHeader<PortfolioChartSortField>
                      field="name"
                      sortField={chartTableSort.sortField}
                      sortDirection={chartTableSort.sortDirection}
                      onSort={chartTableSort.handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap"
                    >
                      {t('portfolioValue.colDate')}
                    </SortableHeader>
                    {securitiesSeries.map((s) => (
                      <th
                        key={s.key}
                        className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap"
                      >
                        <span className="inline-flex items-center gap-1.5 justify-end">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                          {s.label}
                        </span>
                      </th>
                    ))}
                    <SortableHeader<PortfolioChartSortField>
                      field="value"
                      sortField={chartTableSort.sortField}
                      sortDirection={chartTableSort.sortDirection}
                      onSort={chartTableSort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap"
                    >
                      {t('portfolioValue.colTotal')}
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {sortedBreakdownRows.map((row) => (
                    <tr key={`${row.index}-${row.name}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">{row.name}</td>
                      {securitiesSeries.map((s) => (
                        <td key={s.key} className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">
                          {fmtFull(row.values[s.key] ?? 0)}
                        </td>
                      ))}
                      <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {fmtFull(row.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div
              className={`h-80 transition-opacity duration-200 ${
                isLoading ? 'opacity-60' : 'opacity-100'
              }`}
            >
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <AreaChart data={stackedChartData} margin={{ top: 20, right: 30, left: 0, bottom: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                    tickFormatter={formatXAxisTick}
                  />
                  <YAxis domain={yAxisDomain} tickFormatter={fmtAxis} tick={{ fontSize: 12 }} />
                  <Tooltip content={<SecuritiesTooltip fmtFull={fmtFull} totalLabel={t('portfolioValue.colTotal')} />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {securitiesSeries.map((s) => (
                    <Area
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      stackId="pf"
                      stroke={s.color}
                      strokeWidth={1}
                      fill={s.color}
                      fillOpacity={0.85}
                      name={s.label}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )
        ) : chartViewType === 'table' ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<PortfolioChartSortField>
                    field="name"
                    sortField={chartTableSort.sortField}
                    sortDirection={chartTableSort.sortDirection}
                    onSort={chartTableSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('portfolioValue.colDate')}
                  </SortableHeader>
                  <SortableHeader<PortfolioChartSortField>
                    field="value"
                    sortField={chartTableSort.sortField}
                    sortDirection={chartTableSort.sortDirection}
                    onSort={chartTableSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('portfolioValue.colPortfolioValue')}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedChartTableData.map((row) => (
                  <tr key={`${row.index}-${row.name}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">{row.name}</td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {fmtFull(row.Value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                    <stop offset="5%" stopColor={chartColors.income} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartColors.income} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <ChartFlagShadowFilter />
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                  tickFormatter={formatXAxisTick}
                />
                <YAxis
                  domain={yAxisDomain}
                  tickFormatter={fmtAxis}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip content={<CustomTooltip fmtFull={fmtFull} portfolioLabel={t('portfolioValue.tooltipPortfolio')} />} />
                <Area
                  type="monotone"
                  dataKey="Value"
                  stroke={chartColors.income}
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorPortfolioValue)"
                  name={t('portfolioValue.colPortfolioValue')}
                  isAnimationActive={false}
                  dot={(props: { cx?: number; cy?: number; index?: number }) => {
                    const { cx, cy, index } = props;
                    if (cx == null || cy == null || index == null) {
                      return <circle cx={0} cy={0} r={0} fill="none" />;
                    }
                    const isHighest = showFlags && index === highestIndex && summary.highest !== dismissedHigh;
                    const isLowest = showFlags && index === lowestIndex && summary.lowest !== dismissedLow;
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
                      color: isHighest ? chartColors.income : chartColors.expense,
                      label: fmtFlag(value),
                      side: isLeftHalf ? 'right' : 'left',
                      onDismiss: isHighest
                        ? () => setDismissedHigh(summary.highest)
                        : () => setDismissedLow(summary.lowest),
                      dismissLabel: tc('chartFlag.dismiss'),
                    });
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Portfolio Breakdown */}
      {portfolio && portfolio.holdingsByAccount.length > 0 && (() => {
        const sortedBreakdown = [...portfolio.holdingsByAccount].sort((a, b) => {
          let comparison = 0;
          switch (sortField) {
            case 'account':
              comparison = compareValues(a.accountName, b.accountName);
              break;
            case 'holdings':
              comparison = compareValues(a.totalMarketValue, b.totalMarketValue);
              break;
            case 'cash':
              comparison = compareValues(a.cashBalance, b.cashBalance);
              break;
            case 'total':
              comparison = compareValues(
                a.totalMarketValue + a.cashBalance,
                b.totalMarketValue + b.cashBalance,
              );
              break;
            case 'gainLoss':
              comparison = compareValues(a.totalGainLoss, b.totalGainLoss);
              break;
          }
          return sortDirection === 'asc' ? comparison : -comparison;
        });
        return (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('portfolioValue.breakdownTitle')}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<PortfolioBreakdownSortField>
                    field="account"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('portfolioValue.colAccount')}
                  </SortableHeader>
                  <SortableHeader<PortfolioBreakdownSortField>
                    field="holdings"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('portfolioValue.colHoldings')}
                  </SortableHeader>
                  <SortableHeader<PortfolioBreakdownSortField>
                    field="cash"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('portfolioValue.colCash')}
                  </SortableHeader>
                  <SortableHeader<PortfolioBreakdownSortField>
                    field="total"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('portfolioValue.colTotal')}
                  </SortableHeader>
                  <SortableHeader<PortfolioBreakdownSortField>
                    field="gainLoss"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('portfolioValue.colGainLoss')}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedBreakdown.map((acct) => (
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
                    <td className={`px-4 py-3 text-right text-sm font-medium ${gainLossColor(acct.totalGainLoss)}`}>
                      {acct.totalGainLoss >= 0 ? '+' : ''}{fmtFull(acct.totalGainLoss)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        );
      })()}
    </div>
  );
}
