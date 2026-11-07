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
import { PortfolioSummary, AccountHoldings } from '@/types/investment';
import { InvestmentBreakdownSeries } from '@/types/net-worth';
import { Account } from '@/types/account';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { usePortfolioRangeWindow } from '@/hooks/usePortfolioRangeWindow';
import { usePortfolioPeriodResult } from '@/hooks/usePortfolioPeriodResult';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { IncompleteDataDetails } from '@/components/reports/IncompleteDataDetails';
import {
  foldIncompleteData,
  hasIncompleteData,
  type IncompleteDataCauses,
} from '@/lib/incomplete-data-ranges';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CAPTION_CLASS, CellLabel, PHONE_HEADER_CLASS, TH_CLASS } from '@/components/ui/Table';
import type {
  SortColumn as TableSortColumn,
  SortColumnsByField as TableSortColumnsByField,
} from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { exportCsvSections, type CsvValue } from '@/lib/csv-export';
import { createLogger } from '@/lib/logger';
import { EmptyState } from '@/components/ui/EmptyState';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { usePartialTotalNote } from '@/hooks/usePartialTotalNote';
import { portfolioPartialTotal } from '@/lib/net-worth-completeness';

type PortfolioBreakdownSortField = 'account' | 'holdings' | 'cash' | 'total' | 'gainLoss';
type PortfolioChartSortField = 'name' | 'value';

/**
 * One sortable column of the Portfolio Breakdown table. Declared once as a
 * record over the sort-field union and rendered by BOTH header rows -- the
 * column header row (from `sm` up) and the phone sort strip -- so the two can
 * never list different fields, and adding a member to the union fails `tsc`
 * here rather than stranding a phone with no control for it.
 */
type PortfolioBreakdownSortColumn = TableSortColumn<PortfolioBreakdownSortField, 'right'>;

// Normalized per-security breakdown ready to render. Point `name` is already
// the display label (a day, a sampled month-end or an intraday time), so the chart, table
// and CSV render the same way regardless of which endpoint produced it. `kind`
// drives x-axis label shortening.
type SecuritiesBreakdown = {
  series: InvestmentBreakdownSeries[];
  points: Array<{
    name: string;
    /** The point's own date/timestamp, kept beside the display label. */
    iso: string;
    /**
     * The whole value at this point, cash folded in -- the sum of every band,
     * so the stacked chart draws to it. NOT the report's measure.
     */
    total: number;
    /**
     * The report's ONE measure: securities only, the cash band subtracted
     * (`breakdownInvestedValue`). The KPIs, the table's total column and the
     * CSV all read THIS, so the "By security" view and the "Total" view draw
     * the same quantity and switching between them cannot move the high, the
     * low or the exported figure (INV-PORTRESULT-002).
     */
    invested: number;
    values: Record<string, number>;
    /**
     * The server's completeness for this point, absent where the endpoint
     * reports none (intraday). Absent is NO INFORMATION, so every read is
     * `=== false`.
     */
    complete?: boolean;
  }>;
  kind: 'daily' | 'monthEnd' | 'intraday';
};
import {
  type IntradayRange,
  isIntradayRange,
  buildIntradayCacheKey,
  readIntradayCache,
  writeIntradayCache,
  computeTightYAxisDomain,
  renderChartFlagDot,
  ChartFlagShadowFilter,
  monthEndAxisTicks,
  sampledPointLabel,
  sampledTickLabel,
} from '@/components/investments/portfolio-chart-utils';
import {
  periodResultUnknownReason,
} from '@/components/investments/portfolio-period-result';
import {
  openingSessionDate,
  relabelOpeningPoint,
} from '@/components/investments/portfolio-change-baseline';
import {
  investedValue,
  breakdownCashKey,
  breakdownInvestedValue,
} from '@/lib/invested-value';
import { preferredCurrency } from '@/lib/default-currency';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { ChartAreaGradient } from '@/components/ui/ChartAreaGradient';

const logger = createLogger('PortfolioValueReport');

const DAILY_RANGES = new Set(['1w', '1m', '3m', 'ytd', '1y']);

/**
 * The longest custom window drawn from daily closes, matching the longest
 * daily preset (1Y); anything wider is sampled at month-ends, as 2Y and up
 * are, still opening and closing on the window's own closes.
 */
const CUSTOM_DAILY_MAX_DAYS = 366;

/** Whole days from `start` to `end` (YYYY-MM-DD); both parse as UTC midnight. */
function spanInDays(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000;
}

/** Nothing reported missing. A frozen module constant, so the identity is stable. */
const NO_INCOMPLETE_DATA: IncompleteDataCauses = {
  prices: [],
  rates: [],
  cash: [],
};
const RANGE_STORAGE_KEY = 'monize-reports-portfolio-value-range';
const ACCOUNTS_STORAGE_KEY = 'monize-reports-portfolio-value-accounts';

// A money cell inside a wrapped breakdown row: no padding of its own below `sm`
// (the row's grid supplies it), this table's own `px-4 py-3 text-sm` from `sm`
// up, smaller type on phones. Colour and weight stay on each cell.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it is
// the single respect in which the `sm`-and-up cell differs from today's: a
// locale that groups thousands with a space (`1 234 567 zl`) could otherwise
// break a figure in the middle at any width. A number must not break; the
// caption inside takes `whitespace-normal` back for itself (`CellLabel`).
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

function CustomTooltip({ active, payload, fmtFull, portfolioLabel }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { name: string } }>;
  fmtFull: (v: number) => string;
  portfolioLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  return (
    <div className={CHART_TOOLTIP_CLASS}>
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
    <div className={`${CHART_TOOLTIP_CLASS} max-h-72 overflow-y-auto`}>
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
  // `iso` is the point's own date/timestamp, kept beside the display label so
  // the prior-close baseline can be looked up for the data actually on screen.
  // `complete` is the server's completeness for that point, absent where the
  // endpoint reports none (intraday, by-security) -- absent is NO INFORMATION,
  // so every read of it is `=== false`.
  //
  // `Value` is NULL on a point the server could not finish. The server's
  // `value` there is the subtotal of what it could price and convert, and a
  // subtotal plotted on a value axis is indistinguishable from a measured one
  // -- a whole holding period of unpriced securities drew as a flat line near
  // zero (#1389). The chart breaks instead (`connectNulls={false}`), the table
  // and the CSV print it as unavailable, and `IncompleteDataDetails` names the
  // cause beside the withheld KPIs.
  const [loadedPoints, setLoadedPoints] = useState<
    Array<{ name: string; Value: number | null; iso: string; complete?: boolean }>
  >([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // What the withheld figures are waiting for, folded into ranges per cause.
  // Set by whichever loader produced the points on screen, and empty for the
  // endpoints that report no completeness (intraday, monthly aggregates) --
  // which is no information, not a claim that everything is known (#1389).
  const [incompleteCauses, setIncompleteCauses] =
    useState<IncompleteDataCauses>(NO_INCOMPLETE_DATA);
  // symbol / name per security id, so a missing price names the instrument
  // rather than a UUID. Inactive ones included: a security sold out of the
  // portfolio is exactly the one whose history the reader is missing.
  const [securityNames, setSecurityNames] = useState<Map<string, string>>(
    new Map(),
  );
  // Account filter is persisted so the report opens on the same set of accounts
  // the user last looked at, matching the investments page.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    accounts,
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  // The last load failed (the chart request, or the summary and accounts that
  // sit beside it). The loader keeps the previous window's points through a
  // failure, so an export must not read them as this selection's answer.
  const [loadFailed, setLoadFailed] = useState(false);
  const [chartViewType, setChartViewType] = useState<'area' | 'table'>('area');
  // Whether the chart stacks per-security contribution bands instead of a
  // single portfolio-total area. Persisted so the choice survives navigation.
  const [seriesMode, setSeriesMode] = useLocalStorage<'total' | 'securities'>(
    'monize-reports-portfolio-value-series-mode',
    'total',
  );
  const [loadedBreakdown, setBreakdown] = useState<SecuritiesBreakdown | null>(null);
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
  // Set when 1W/MTD/1M silently fall back to daily snapshots because one or more
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
  const {
    dateRange,
    setDateRange,
    startDate: customStartDate,
    setStartDate: setCustomStartDate,
    endDate: customEndDate,
    setEndDate: setCustomEndDate,
    resolvedRange,
    isValid: datesEntered,
  } = useDateRange({
    defaultRange: persistedRange,
    alignment: 'month',
  });
  const today = useFinancialToday();
  const handleRangeChange = useCallback(
    (next: string) => {
      setDateRange(next);
      if (next === 'custom') {
        // The To date opens on today; the From date is the reader's to pick.
        if (!customEndDate) setCustomEndDate(today);
        // Only the presets are remembered: the custom dates are not stored, so
        // a remembered "custom" would reopen on a window with no dates.
        return;
      }
      setPersistedRange(next);
    },
    [setDateRange, setPersistedRange, customEndDate, setCustomEndDate, today],
  );

  const isCustom = dateRange === 'custom';
  // A custom window with its dates reversed is not a window: nothing loads
  // until the reader corrects it.
  const isValid = datesEntered && (!isCustom || customStartDate <= customEndDate);
  const intradayRange = isIntradayRange(dateRange) ? dateRange : null;
  const isIntraday = intradayRange !== null;
  const useDaily =
    !isIntraday &&
    (isCustom
      ? isValid && spanInDays(customStartDate, customEndDate) <= CUSTOM_DAILY_MAX_DAYS
      : DAILY_RANGES.has(dateRange));

  // The window this chart requests is not the period the range names: a price
  // series opens on the close it is measured from. See
  // `portfolio-range-window.ts` for the per-range rules.
  const chartWindow = usePortfolioRangeWindow({
    range: dateRange,
    base: resolvedRange,
  });

  // Per-security stacked view. Available on every range: intraday ranges pull
  // the live per-security intraday series, the rest use the daily breakdown
  // (every day for the shorter ranges, sampled at month-ends for the longer).
  const securitiesActive = seriesMode === 'securities';
  const breakdownGranularity: 'daily' | 'monthEnd' =
    isIntraday || useDaily ? 'daily' : 'monthEnd';
  // X-axis label formatting must follow the data actually plotted. In the
  // securities view drive it off the loaded breakdown's kind (which reflects
  // any intraday->daily fallback) rather than the range's own flags.
  const axisIntraday = securitiesActive
    ? loadedBreakdown?.kind === 'intraday'
    : isIntraday;
  const axisDaily = securitiesActive
    ? loadedBreakdown?.kind === 'daily'
    : useDaily;

  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const foreignCurrency = selectedAccount?.currencyCode && selectedAccount.currencyCode !== defaultCurrency
    ? selectedAccount.currencyCode
    : null;
  const effectiveCurrency = foreignCurrency || preferredCurrency(defaultCurrency);

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
      const { start, end } = chartWindow;
      // A long range is the SAME daily valuation sampled at each month-end, so
      // its first point is the close the figures are measured from and its
      // last the one they are measured to -- never a stored month-end
      // snapshot, which opens on a month boundary instead.
      const sampled = !(useDaily || isIntraday);
      const data = await netWorthApi.getInvestmentsDaily({
        startDate: start,
        endDate: end,
        accountIds: accountIdsCsv,
        displayCurrency: foreignCurrency || undefined,
        ...(sampled ? { sampling: 'monthEnd' as const } : {}),
      });
      if (loadSeqRef.current !== seq) return;
      setLoadedPoints(
        data.map((d, index) => {
          // A day short of a price or a rate is a subtotal; the KPIs below
          // refuse to name it a high, a low or a change, and the chart
          // refuses to plot it at all. `cashComplete` is NOT read here: the
          // chart plots the INVESTED value, which holds no cash, so a cash
          // account with no balance for a day cannot make this point wrong.
          // It is still reported in the incomplete-data details below.
          const complete =
            d.pricesComplete !== false && d.fxComplete !== false;
          return {
            name: sampled
              ? sampledPointLabel(d.date, index, data.length, formatChartDate)
              : formatChartDate(d.date, 'MMM d, yyyy'),
            Value: complete ? investedValue(d) : null,
            iso: d.date,
            complete,
          };
        }),
      );
      setIncompleteCauses(foldIncompleteData(data));
    };

    // Daily or month-end-sampled per-security breakdown. Also the fallback
    // target when a 1W/MTD/1M intraday breakdown has no intraday data for the
    // account mix.
    const loadDailyMonthlyBreakdown = async (
      granularity: 'daily' | 'monthEnd',
    ) => {
      const { start, end } = chartWindow;
      const data = await netWorthApi.getInvestmentsBreakdown({
        granularity,
        startDate: start,
        endDate: end,
        accountIds: accountIdsCsv,
        displayCurrency: foreignCurrency || undefined,
      });
      if (loadSeqRef.current !== seq) return;
      const cashKey = breakdownCashKey(data.series);
      const points = data.points.map((p, index) => ({
        name:
          granularity === 'monthEnd'
            ? sampledPointLabel(p.date, index, data.points.length, formatChartDate)
            : formatChartDate(p.date, 'MMM d, yyyy'),
        iso: p.date,
        total: p.total,
        invested: breakdownInvestedValue(p, cashKey),
        values: p.values,
        // A point missing a price or a rate is a subtotal of the INVESTED
        // value: the KPI cards refuse to call it a high or a low and the chart
        // draws no band for it. Read as `=== false` -- an older backend sends
        // neither flag (#1389).
        //
        // `cashComplete` is NOT read here, exactly as on the daily sum path:
        // the report's measure is the invested value, which holds no cash, so
        // a cash account with no balance for a point cannot make the invested
        // figure wrong. It is still folded into the incomplete-data details
        // below so the reader learns of the cash gap.
        //
        // The rate read is the POINT's own list where the response carries one,
        // because the response-level `fxComplete` is the union over the window
        // and would withhold every point over one unconvertible day. A response
        // without per-point lists is an older backend, and then the union is
        // all there is.
        complete:
          p.pricesComplete !== false &&
          (p.missingRatePairs
            ? p.missingRatePairs.length === 0
            : data.fxComplete !== false),
      }));
      setBreakdown({ series: data.series, points, kind: granularity });
      setIncompleteCauses(
        foldIncompleteData(
          data.points.map((p) => ({
            date: p.date,
            unpricedSecurityIds: p.unpricedSecurityIds,
            missingRatePairs: p.missingRatePairs,
            unknownCashAccountIds: p.unknownCashAccountIds,
          })),
        ),
      );
      setLoadedPoints(
        points.map((p) => ({
          name: p.name,
          Value: p.complete ? p.invested : null,
          iso: p.iso,
          complete: p.complete,
        })),
      );
    };

    // Per-security intraday breakdown (1D/1W/MTD/1M). Mirrors the total intraday
    // chart's fallback handling: 1D shows an "unavailable" note, the rest silently
    // fall back to the daily-snapshot breakdown with a small warning icon.
    const loadIntradayBreakdown = async (range: IntradayRange) => {
      let data;
      try {
        data = await investmentsApi.getIntradayBreakdown({
          range,
          accountIds: accountIdsCsv,
          displayCurrency: foreignCurrency || undefined,
        });
      } catch (error) {
        logger.error('Failed to load intraday breakdown:', error);
        if (loadSeqRef.current !== seq) return;
        await loadDailyMonthlyBreakdown('daily');
        return;
      }
      if (loadSeqRef.current !== seq) return;

      if (data.fallbackToDaily) {
        if (dateRange === '1d') {
          setBreakdown(null);
          setLoadedPoints([]);
          setIntradayUnavailable({ skipped: data.skippedSymbols });
        } else {
          setIntradayFallbackNotice({ skipped: data.skippedSymbols });
          await loadDailyMonthlyBreakdown('daily');
        }
        return;
      }

      const cashKey = breakdownCashKey(data.series);
      const points = data.points.map((p) => ({
        name: formatIntradayLabel(p.timestamp, dateRange),
        iso: p.timestamp,
        total: p.total,
        invested: breakdownInvestedValue(p, cashKey),
        values: p.values,
        // A bar short of a price or a rate is a subtotal of the INVESTED
        // value, exactly as on the daily path; `cashComplete` is not read for
        // the same reason. An older backend sends neither flag, which is no
        // information.
        complete: p.pricesComplete !== false && p.fxComplete !== false,
      }));
      setBreakdown({ series: data.series, points, kind: 'intraday' });
      // An intraday series reports completeness without dates, so there is no
      // per-bar list to fold into ranges.
      setIncompleteCauses(NO_INCOMPLETE_DATA);
      setLoadedPoints(
        points.map((p) => ({
          name: p.name,
          Value: p.complete ? p.invested : null,
          iso: p.iso,
          complete: p.complete,
        })),
      );
    };

    const loadData = async () => {
      setIsLoading(true);
      setLoadFailed(false);
      setIntradayUnavailable(null);
      setIntradayFallbackNotice(null);
      // The previous window's causes describe the previous window. Each loader
      // below fills this in for the points it produced.
      setIncompleteCauses(NO_INCOMPLETE_DATA);

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
          if (intradayRange) {
            await loadIntradayBreakdown(intradayRange);
          } else {
            await loadDailyMonthlyBreakdown(breakdownGranularity);
          }
        } else if (intradayRange) {
          setBreakdown(null);
          const cacheKey = buildIntradayCacheKey(
            dateRange,
            accountIds,
            effectiveCurrency,
          );
          const cached = readIntradayCache(cacheKey);
          if (cached && !cached.fallbackToDaily) {
            setLoadedPoints(
              cached.points.map((p) => {
                const complete = p.pricesComplete !== false && p.fxComplete !== false;
                return {
                  name: formatIntradayLabel(p.timestamp, dateRange),
                  Value: complete ? investedValue(p) : null,
                  iso: p.timestamp,
                  complete,
                };
              }),
            );
            setIsLoading(false);
          }

          let response;
          try {
            response = await investmentsApi.getIntradayValue({
              range: intradayRange,
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
              setLoadedPoints([]);
              setIntradayUnavailable({ skipped: response.skippedSymbols });
            } else {
              // 1W / MTD / 1M silently fall back to the daily endpoint, with a
              // small warning icon next to the title so the user knows
              // intraday detail isn't available for this account mix.
              setIntradayFallbackNotice({ skipped: response.skippedSymbols });
              await loadDailyOrMonthly();
            }
          } else {
            setLoadedPoints(
              response.points.map((p) => {
                // The same per-point rule as the daily path: a bar the server
                // could not price or convert is a subtotal, plotted as nothing.
                const complete = p.pricesComplete !== false && p.fxComplete !== false;
                return {
                  name: formatIntradayLabel(p.timestamp, dateRange),
                  Value: complete ? investedValue(p) : null,
                  iso: p.timestamp,
                  complete,
                };
              }),
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
        } else {
          setLoadFailed(true);
        }
      } catch (error) {
        logger.error('Failed to load portfolio data:', error);
        if (loadSeqRef.current === seq) setLoadFailed(true);
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
    chartWindow,
    isValid,
    foreignCurrency,
    effectiveCurrency,
    useDaily,
    intradayRange,
    isIntraday,
    dateRange,
    securitiesActive,
    breakdownGranularity,
    formatIntradayLabel,
    formatChartDate,
  ]);

  // What the portfolio DID over the window, as the server worked it out: the
  // value change, the money the reader moved in or out, and what is left. Null
  // until it answers, and never re-derived here -- deriving a change from the
  // plotted series is exactly what reported a deposit as a gain (#1392).
  //
  // Through the same hook the Investments page's chart reads, and the window
  // is NAMED rather than dated, so this report, that chart and the performance
  // card beside it resolve one window from one file. The window this report
  // DRAWS opens earlier than the period its button names, and measuring over
  // it reported a week under "1D" and nothing at all under "All".
  const periodAccountIdsCsv =
    selectedAccountIds.length > 0 ? selectedAccountIds.join(',') : undefined;
  const { periodResult } = usePortfolioPeriodResult({
    range: dateRange,
    startDate: isValid ? chartWindow.start : '',
    periodStartDate: isValid ? chartWindow.periodStart : '',
    endDate: chartWindow.end,
    hasSeries: loadedPoints.length > 0,
    accountIds: periodAccountIdsCsv,
    displayCurrency: foreignCurrency || undefined,
    reloadKey,
  });

  // The series as drawn, in both views. It was requested from the day the
  // period is measured from, and its opening point is dated by the session
  // that day's close came from -- the session the caption under the chart
  // names -- rather than by a boundary the market was shut on
  // (`openingSessionDate`). The stacked view's points open on the same day.
  const openingSession = openingSessionDate(loadedPoints[0]?.iso, periodResult);
  const labelBySession = useCallback(
    <T extends { name: string }>(point: T, session: string): T => ({
      ...point,
      name: formatChartDate(session, 'MMM d, yyyy'),
    }),
    [formatChartDate],
  );
  const chartPoints = useMemo(
    () => relabelOpeningPoint(loadedPoints, openingSession, labelBySession),
    [loadedPoints, openingSession, labelBySession],
  );
  const breakdown = useMemo(() => {
    if (!openingSession || !loadedBreakdown) return loadedBreakdown;
    return {
      ...loadedBreakdown,
      points: relabelOpeningPoint(
        loadedBreakdown.points,
        openingSession,
        labelBySession,
      ),
    };
  }, [loadedBreakdown, openingSession, labelBySession]);

  const summary = useMemo(() => {
    if (chartPoints.length === 0) {
      return { highest: null as number | null, lowest: null as number | null };
    }
    // A point the server could not finish is a subtotal, and a subtotal can sit
    // anywhere in the ordering: the real high or low may be the day that is
    // missing a component. One incomplete point therefore leaves BOTH extremes
    // unknown rather than quietly ranking a partial figure against whole ones.
    const extremesKnown = chartPoints.every((p) => p.complete !== false);
    const values = chartPoints
      .map((d) => d.Value)
      .filter((v): v is number => v !== null);
    if (!extremesKnown || values.length === 0) {
      return { highest: null as number | null, lowest: null as number | null };
    }
    return {
      highest: Math.max(...values),
      lowest: Math.min(...values),
    };
  }, [chartPoints]);

  // The three figures the cards print, and the one repair a withheld one points
  // at. Every completeness read is the server's: `null` means it withheld the
  // figure and said why, and nothing here recomputes it from the chart.
  //
  // The report plots the INVESTED value, so every figure is the invested
  // part's: the same measure the Investments page's performance card and the
  // dashboard widget report (section 10.7). The value change is the line's
  // last point less its first, and the three reconcile exactly:
  // value change - net invested + dividends and interest = investment result.
  // The account's own change, cash and deposits included, is a different
  // question and is not asked here (section 10.9).
  const valueChange = periodResult?.investedValueChange ?? null;
  const netInvested = periodResult?.investmentCapitalFlows ?? null;
  const investmentIncome = periodResult?.investmentIncome ?? null;
  const investmentResult = periodResult?.investmentPnl ?? null;
  const returnPercent = periodResult?.investmentReturnPercent ?? null;
  const unknownReason = periodResultUnknownReason(
    periodResult?.investedReasons ?? [],
  );
  // The session these figures are measured from, under the chart's title
  // rather than behind a marker: it is a fact about every window here, not a
  // caveat about three of them. `startPriceDate` is the trading day the
  // opening value came from -- on a Monday, the Friday before, where the
  // calendar boundary beside it names a day the market was shut.
  const measuredFromLabel = periodResult?.startPriceDate
    ? t('portfolioValue.measuredFromClose', {
        date: formatChartDate(periodResult.startPriceDate, 'MMM d, yyyy'),
      })
    : null;

  // Which KPI captions the window cannot stand behind, so the cards say so
  // rather than printing a partial figure under a total's caption.
  const valuesIncomplete = useMemo(
    () => chartPoints.some((p) => p.complete === false),
    [chartPoints],
  );

  // Names for the ids in the diagnostics. Loaded only once something is
  // actually missing, and including inactive securities: a holding sold out of
  // the portfolio is exactly the one whose price history is missing (#1389).
  const needsSecurityNames = incompleteCauses.prices.length > 0;
  useEffect(() => {
    if (!needsSecurityNames) return;
    let cancelled = false;
    investmentsApi
      .getSecurities(true)
      .then((securities) => {
        if (cancelled) return;
        setSecurityNames(
          new Map(securities.map((s) => [s.id, s.symbol || s.name])),
        );
      })
      .catch((error) => {
        // A failed lookup is not an empty portfolio: the list simply keeps the
        // names it already has and the fallback label stands in.
        logger.error('Failed to load securities for the incomplete-data list:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [needsSecurityNames]);

  const securityLabel = useCallback(
    (securityId: string) =>
      securityNames.get(securityId) ??
      t('portfolioValue.incompleteUnknownSecurity'),
    [securityNames, t],
  );
  const accountLabel = useCallback(
    (accountId: string) => {
      const account = accounts.find((a) => a.id === accountId);
      return account
        ? mainAccountName(account.name)
        : t('portfolioValue.incompleteUnknownAccount');
    },
    [accounts, mainAccountName, t],
  );
  const showIncompleteDetails = hasIncompleteData(incompleteCauses);

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
    if (!axisIntraday && !axisDaily) return monthEndAxisTicks(chartPoints);
    if (chartPoints.length <= 36) return undefined;
    const step = Math.ceil(chartPoints.length / 7);
    return chartPoints.filter((_, i) => i % step === 0).map((d) => d.name);
  }, [chartPoints, axisIntraday, axisDaily]);

  // A month-end-sampled tick is formatted from its point's own date, found by
  // its label, so the day-dated ends and the month-dated middle each read
  // right in every locale.
  const pointIndexByName = useMemo(
    () => new Map(chartPoints.map((p, index) => [p.name, index])),
    [chartPoints],
  );

  const yAxisDomain = useMemo(
    () =>
      // A stacked area builds up from zero, so anchor its axis at 0 rather than
      // zooming to the total's min/max (which would clip the lower bands).
      securitiesActive
        ? ([0, 'auto'] as [number, 'auto'])
        : computeTightYAxisDomain(
            chartPoints
              .map((d) => d.Value)
              .filter((v): v is number => v !== null),
          ),
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
    if (!breakdown) return [] as Array<Record<string, number | string | null>>;
    // Point names are pre-formatted at load time (date or intraday time).
    //
    // An incomplete point draws no band at all. A stack whose height is short a
    // component is the same lie as a line drawn through a subtotal, and it is
    // worse here: the missing band is exactly the security the reader is
    // looking for (#1389). Every band goes null together so the stack breaks
    // rather than settling onto a shorter total.
    return breakdown.points.map((p) => {
      const known = p.complete !== false;
      const bands = Object.fromEntries(
        Object.entries(p.values).map(([key, value]) => [
          key,
          known ? value : null,
        ]),
      );
      return {
        name: p.name,
        total: known ? p.total : null,
        ...bands,
      };
    });
  }, [breakdown]);

  const sortedBreakdownRows = useMemo(() => {
    if (!breakdown) return [];
    const rows = breakdown.points.map((p, idx) => ({
      index: idx,
      name: p.name,
      // The report's measure: securities, no cash. The cash band still has its
      // own column, but the total column is the invested value.
      total: p.invested,
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
  }, [breakdown, chartTableSort.sortField, chartTableSort.sortDirection]);

  // Shared x-axis label formatter for the total and stacked charts. Driven by
  // the axis granularity flags so the securities view labels correctly whether
  // it loaded intraday, daily or month-end-sampled data.
  const formatXAxisTick = useCallback(
    (value: string) => {
      if (axisIntraday) return value;
      if (axisDaily) {
        const parts = value.split(', ');
        return parts[0] || value;
      }
      const index = pointIndexByName.get(value);
      if (index === undefined) return value;
      return sampledTickLabel(
        chartPoints[index].iso,
        index,
        chartPoints.length,
        formatChartDate,
      );
    },
    [axisIntraday, axisDaily, chartPoints, pointIndexByName, formatChartDate],
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
  const showFlags =
    summary.highest !== null &&
    summary.lowest !== null &&
    summary.highest !== summary.lowest;

  // The Portfolio Breakdown table's five sortable columns, keyed by field so the
  // record is exhaustive: adding a member to `PortfolioBreakdownSortField` is a
  // compile error here rather than a header with no control. Their declaration
  // order is the column (and cell DOM) order, rendered by BOTH the column header
  // row and the phone sort strip from the derived `Object.values`.
  const breakdownColumns: TableSortColumnsByField<PortfolioBreakdownSortField, PortfolioBreakdownSortColumn> = {
    account: { field: 'account', label: t('portfolioValue.colAccount') },
    holdings: { field: 'holdings', label: t('portfolioValue.colHoldings'), align: 'right' },
    cash: { field: 'cash', label: t('portfolioValue.colCash'), align: 'right' },
    total: { field: 'total', label: t('portfolioValue.colTotal'), align: 'right' },
    gainLoss: { field: 'gainLoss', label: t('portfolioValue.colGainLoss'), align: 'right' },
  };
  const breakdownSortColumns: readonly PortfolioBreakdownSortColumn[] = Object.values(breakdownColumns);

  // A withheld figure prints as unavailable and in grey wherever the export
  // formats cannot carry the marker the cards use. Never a zero, and never the
  // gain colour over nothing.
  const signedMoneyText = (value: number | null) =>
    value === null
      ? t('portfolioValue.notAvailable')
      : `${value >= 0 ? '+' : ''}${fmtVal(value)}`;
  const signedColour = (value: number | null) =>
    value === null ? '#6b7280' : value >= 0 ? '#16a34a' : '#dc2626';

  // The per-account breakdown reads each ACCOUNT's own flags: its totals are in
  // the account's currency, a different conversion from the summary's, so the
  // portfolio can be complete while one account is not.
  const { cellFor } = usePartialTotalNote();
  const accountPartial = (acct: AccountHoldings, value: number) =>
    portfolioPartialTotal(value, acct);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const accountLabel = selectedAccount
      ? mainAccountName(selectedAccount.name)
      : t('portfolioValue.allAccounts');
    const breakdownHeaders = [t('portfolioValue.pdfColAccount'), t('portfolioValue.pdfColHoldings'), t('portfolioValue.pdfColCash'), t('portfolioValue.pdfColTotal'), t('portfolioValue.pdfColGainLoss')];
    // An account the server could not fully value exports what the table shows:
    // its holdings, total and gain (over the priced holdings only) are subtotals,
    // suffixed as such. A bare subtotal in a document that leaves the application is
    // the same defect as one on screen.
    const breakdownRows = portfolio?.holdingsByAccount.map((acct) => [
      acct.accountName,
      cellFor(fmtFull(acct.totalMarketValue), accountPartial(acct, acct.totalMarketValue)),
      fmtFull(acct.cashBalance),
      cellFor(
        fmtFull(acct.totalMarketValue + acct.cashBalance),
        accountPartial(acct, acct.totalMarketValue + acct.cashBalance),
      ),
      cellFor(
        `${acct.totalGainLoss >= 0 ? '+' : ''}${fmtFull(acct.totalGainLoss)}`,
        accountPartial(acct, acct.totalGainLoss),
      ),
    ]) || [];
    await exportToPdf({
      title: t('portfolioValue.pdfTitle'),
      subtitle: accountLabel,
      summaryCards: [
        {
          label: t('portfolioValue.highestValue'),
          value:
            summary.highest === null
              ? t('portfolioValue.notAvailable')
              : fmtVal(summary.highest),
          color: summary.highest === null ? '#6b7280' : '#111827',
        },
        {
          label: t('portfolioValue.lowestValue'),
          value:
            summary.lowest === null
              ? t('portfolioValue.notAvailable')
              : fmtVal(summary.lowest),
          color: summary.lowest === null ? '#6b7280' : '#111827',
        },
        {
          label: t('portfolioValue.valueChange'),
          value: signedMoneyText(valueChange),
          color: signedColour(valueChange),
        },
        {
          label: t('portfolioValue.netInvested'),
          value: signedMoneyText(netInvested),
          // Money paid in is neither a gain nor a loss, so it is not painted as one.
          color: netInvested === null ? '#6b7280' : '#111827',
        },
        {
          label: t('portfolioValue.investmentIncome'),
          value: signedMoneyText(investmentIncome),
          color: investmentIncome === null ? '#6b7280' : '#111827',
        },
        {
          label: t('portfolioValue.investmentResult'),
          value: signedMoneyText(investmentResult),
          color: signedColour(investmentResult),
        },
        {
          label: t('portfolioValue.investmentReturn'),
          value:
            returnPercent === null
              ? t('portfolioValue.notAvailable')
              : formatSignedPercent(returnPercent, 1),
          color: signedColour(returnPercent),
        },
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

  // The period's figures, as their own CSV section above the series, and the
  // same five the PDF prints: a reader exporting the chart was previously given
  // the dates and values and left to work the period out themselves, which is
  // the arithmetic this change exists to stop anybody doing (#1392).
  //
  // The amount column holds the RAW number and the unit is its own column, so a
  // spreadsheet adds the cells up instead of reading a formatted string as text
  // and a foreign-currency export cannot be mistaken for the reader's own
  // currency. A figure the server withheld is the explicit marker, never an
  // empty cell (indistinguishable from zero once a column is totalled).
  const periodSummarySection = () => {
    const money = (value: number | null): CsvValue[] =>
      value === null
        ? [t('portfolioValue.notAvailable'), '']
        : [value, effectiveCurrency];
    return {
      title: t('portfolioValue.csvSummaryTitle'),
      headers: [
        t('portfolioValue.csvColFigure'),
        t('portfolioValue.csvColAmount'),
        t('portfolioValue.csvColCurrency'),
      ],
      rows: [
        [t('portfolioValue.highestValue'), ...money(summary.highest)],
        [t('portfolioValue.lowestValue'), ...money(summary.lowest)],
        [t('portfolioValue.valueChange'), ...money(valueChange)],
        [t('portfolioValue.netInvested'), ...money(netInvested)],
        [t('portfolioValue.investmentIncome'), ...money(investmentIncome)],
        [t('portfolioValue.investmentResult'), ...money(investmentResult)],
        [
          t('portfolioValue.investmentReturn'),
          ...(returnPercent === null
            ? [t('portfolioValue.notAvailable'), '']
            : [returnPercent, t('portfolioValue.csvUnitPercent')]),
        ],
      ] as CsvValue[][],
    };
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
      exportCsvSections('portfolio-value-by-security', [
        periodSummarySection(),
        { headers, rows },
      ]);
      return;
    }
    const headers = [t('portfolioValue.csvColDate'), t('portfolioValue.csvColValue')];
    // A CSV cell cannot carry the grey marker the table uses, so a withheld
    // point exports the same words the card prints -- never an empty cell a
    // spreadsheet reads as zero.
    const rows = sortedChartTableData.map((p) => [
      p.name,
      p.Value === null ? t('portfolioValue.notAvailable') : p.Value,
    ]);
    exportCsvSections('portfolio-value', [
      periodSummarySection(),
      { headers, rows },
    ]);
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
            {t('portfolioValue.highestValue')}
            {valuesIncomplete && (
              <InfoTooltip placement="top" text={t('portfolioValue.incompleteTooltip')} />
            )}
          </div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {summary.highest === null ? (
              <span className="text-gray-400 dark:text-gray-500 text-base font-normal">
                {t('portfolioValue.notAvailable')}
              </span>
            ) : (
              fmtVal(summary.highest)
            )}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
            {t('portfolioValue.lowestValue')}
            {valuesIncomplete && (
              <InfoTooltip placement="top" text={t('portfolioValue.incompleteTooltip')} />
            )}
          </div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {summary.lowest === null ? (
              <span className="text-gray-400 dark:text-gray-500 text-base font-normal">
                {t('portfolioValue.notAvailable')}
              </span>
            ) : (
              fmtVal(summary.lowest)
            )}
          </div>
        </div>
        {/* Value change: what the securities are worth now against then --
            the chart's last point less its first. It includes what was paid
            into them, which is why it is captioned as a value change and never
            as a return. */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
            {t('portfolioValue.valueChange')}
            <InfoTooltip placement="top" text={t('portfolioValue.investedValueChangeTooltip')} />
          </div>
          <div className={`text-xl font-bold ${valueChange === null ? '' : gainLossColor(valueChange)}`}>
            {valueChange === null ? (
              <UnknownAmount reason={unknownReason} className="text-base font-normal" />
            ) : (
              <>{valueChange >= 0 ? '+' : ''}{fmtVal(valueChange)}</>
            )}
          </div>
        </div>
        {/* What was paid into the securities, less what came out of them, and
            beneath it what they paid out: the two parts of the value change
            that are not performance. */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
            {t('portfolioValue.netInvested')}
            <InfoTooltip placement="top" text={t('portfolioValue.netInvestedTooltip')} />
          </div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {netInvested === null ? (
              <UnknownAmount reason={unknownReason} className="text-base font-normal" />
            ) : (
              <>{netInvested >= 0 ? '+' : ''}{fmtVal(netInvested)}</>
            )}
          </div>
          <div
            className="text-sm text-gray-500 dark:text-gray-400 flex items-center"
            data-testid="period-income"
          >
            {t('portfolioValue.investmentIncomeLine', {
              amount:
                investmentIncome === null
                  ? t('portfolioValue.notAvailable')
                  : `${investmentIncome >= 0 ? '+' : ''}${fmtVal(investmentIncome)}`,
            })}
            <InfoTooltip placement="top" text={t('portfolioValue.investmentIncomeTooltip')} />
          </div>
        </div>
        {/* What is left once the money paid in is taken out and the money
            paid out counted: the only figure a percentage belongs over. */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
            {t('portfolioValue.investmentResult')}
            <InfoTooltip placement="top" text={t('portfolioValue.investmentResultTooltip')} />
          </div>
          <div className={`text-xl font-bold ${investmentResult === null ? '' : gainLossColor(investmentResult)}`}>
            {investmentResult === null ? (
              <UnknownAmount reason={unknownReason} className="text-base font-normal" />
            ) : (
              <>{investmentResult >= 0 ? '+' : ''}{fmtVal(investmentResult)}</>
            )}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
            <span className={returnPercent === null ? '' : gainLossColor(returnPercent)}>
              {returnPercent === null
                ? t('portfolioValue.notAvailable')
                : formatSignedPercent(returnPercent, 1)}
            </span>
            <InfoTooltip placement="top" text={t('portfolioValue.investmentReturnTooltip')} />
            <span className="sr-only">{t('portfolioValue.investmentReturn')}</span>
          </div>
        </div>
      </div>

      {/* What the withheld figures above are waiting for, named and dated.
          Beside the cards rather than inside a tooltip: a repair the reader
          cannot find is the same dead end as no explanation at all (#1389). */}
      {showIncompleteDetails && (
        <IncompleteDataDetails
          causes={incompleteCauses}
          securityLabel={securityLabel}
          accountLabel={accountLabel}
        />
      )}

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {/* Both rows align on the first line's text rather than centring, so
            the custom range's date fields open below the controls without
            moving the picker, the switches or the actions down with them. */}
        <div className="flex flex-wrap gap-4 items-baseline">
          <div className="flex w-full flex-wrap gap-2 items-baseline sm:w-auto">
            {/* Full width on a phone: at `w-48` the picker and the ten range
                buttons beside it are wider than the screen. */}
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
              className="w-full sm:w-48"
            />
            <DateRangeSelector
              ranges={['1d', '1w', 'mtd', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']}
              value={dateRange}
              onChange={handleRangeChange}
              showCustom
              customStartDate={customStartDate}
              onCustomStartDateChange={setCustomStartDate}
              customEndDate={customEndDate}
              onCustomEndDateChange={setCustomEndDate}
              activeColour="bg-emerald-600"
            />
          </div>
          {/* The view switches and the actions are one trailing group, so the
              switches sit against Refresh/Export at the right edge. They wrap
              on a phone rather than carrying the export off the card, and the
              actions take a line of their own there. */}
          <div className="flex w-full flex-wrap items-center gap-3 sm:ml-auto sm:w-auto">
            {/* Total vs. per-security stacked view, available on every range. */}
            <div className="inline-flex rounded-md overflow-hidden border border-gray-200 dark:border-gray-600">
              {(['total', 'securities'] as const).map((mode) => {
                const isActive = (securitiesActive ? 'securities' : 'total') === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSeriesMode(mode)}
                    aria-pressed={isActive}
                    className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-emerald-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
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
            <ReportToolbarActions
              onRefreshComplete={() => setReloadKey((k) => k + 1)}
              onExportPdf={handleExportPdf}
              onExportCsv={handleExportCsv}
              disabled={isLoading || loadFailed || chartPoints.length === 0}
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
              className="inline-flex items-center text-amber-500 dark:text-amber-400"
              data-testid="report-intraday-fallback-warning"
            >
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.515 2.625H3.72c-1.345 0-2.188-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              {/* The explanation is the tooltip's, not a `title`: a phone has
                  no hover to read it by. */}
              <InfoTooltip
                text={intradayFallbackNotice.skipped.length > 0
                  ? t('portfolioValue.intradayFallbackTitle', { symbols: intradayFallbackNotice.skipped.join(', ') })
                  : t('portfolioValue.intradayFallbackTitleGeneric')}
                usePortal
              />
            </span>
          )}
        </h3>
        {measuredFromLabel && (
          <p
            className="-mt-3 mb-4 text-xs text-gray-500 dark:text-gray-400"
            data-testid="report-measured-from-close"
          >
            {measuredFromLabel}
          </p>
        )}
        {intradayUnavailable ? (
          <EmptyState
            className="px-4"
            title={t('portfolioValue.intradayUnavailableTitle')}
            description={t('portfolioValue.intradayUnavailableDesc', {
              skipped: intradayUnavailable.skipped.length > 0
                ? t('portfolioValue.intradayUnavailableSkipped', { symbols: intradayUnavailable.skipped.join(', ') })
                : '',
            })}
          />
        ) : chartPoints.length === 0 ? (
          <EmptyState title={t('portfolioValue.noData')} />
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
                      className={`${TH_CLASS} whitespace-nowrap`}
                    >
                      {t('portfolioValue.colDate')}
                    </SortableHeader>
                    {securitiesSeries.map((s) => (
                      <th
                        key={s.key}
                        className={`${TH_CLASS} text-right whitespace-nowrap`}
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
                      className={`${TH_CLASS} whitespace-nowrap`}
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
                  <CartesianGrid {...CHART_GRID_PROPS} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                    tickFormatter={formatXAxisTick}
                  />
                  <YAxis domain={yAxisDomain} tickFormatter={fmtAxis} tick={{ fontSize: 12 }} />
                  <Tooltip content={<SecuritiesTooltip fmtFull={fmtFull} totalLabel={t('portfolioValue.colTotal')} />} />
                  <Legend />
                  {securitiesSeries.map((s) => (
                    <Area
                      activeDot={ChartActiveDot}
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      stackId="pf"
                      connectNulls={false}
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
                    className={TH_CLASS}
                  >
                    {t('portfolioValue.colDate')}
                  </SortableHeader>
                  <SortableHeader<PortfolioChartSortField>
                    field="value"
                    sortField={chartTableSort.sortField}
                    sortDirection={chartTableSort.sortDirection}
                    onSort={chartTableSort.handleSort}
                    align="right"
                    className={TH_CLASS}
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
                      {row.Value === null ? (
                        <span className="text-gray-400 dark:text-gray-500 font-normal">
                          {t('portfolioValue.notAvailable')}
                        </span>
                      ) : (
                        fmtFull(row.Value)
                      )}
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
                  <ChartAreaGradient id="colorPortfolioValue" color={chartColors.income} />
                </defs>
                <ChartFlagShadowFilter />
                <CartesianGrid {...CHART_GRID_PROPS} />
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
                  activeDot={ChartActiveDot}
                  type="monotone"
                  dataKey="Value"
                  connectNulls={false}
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
                    if (value === null) {
                      return <circle key={`dot-${index}`} cx={cx} cy={cy} r={0} fill="none" />;
                    }
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
          {/* Below `sm` the table becomes a block and each row wraps into a
              three-column, two-line grid card so all five columns fit a phone
              without a horizontal scroll: line 1 is the account (the row
              identity) and the total (the headline); line 2 is holdings, cash
              and the gain/loss. Nothing is dropped, and no figure is truncated
              -- a money value never wraps (`MONEY_CELL`). From `sm` up it is the
              ordinary table, resolving to today's output in every respect but
              one (each cell restores its own `sm:px-4 sm:py-3`, the four figure
              cells `sm:text-sm` and the account cell `sm:text-base` -- that one
              carried NO size class before the conversion, so 16px inherited is
              what it has to hand back; `MONEY_CELL`'s `whitespace-nowrap` is
              unprefixed, so it applies at 640px+ too, where the base cell
              carried no `white-space` class -- deliberate, and the constant
              says why), and the sort controls
              survive as their own phone-only header row because the column
              header row that carries them on desktop is hidden there. Restyling
              `display` strips the implicit table semantics below `sm`, so the
              roles are restated and every bare figure carries a `CellLabel`
              naming its column; the account name names itself. */}
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                {/* Phone sort strip: the same five controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                  {breakdownSortColumns.map((col) => (
                    <SortableHeader<PortfolioBreakdownSortField>
                      key={col.field}
                      field={col.field}
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className={PHONE_HEADER_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
                <tr role="row" className="hidden sm:table-row">
                  {breakdownSortColumns.map((col) => (
                    <SortableHeader<PortfolioBreakdownSortField>
                      key={col.field}
                      field={col.field}
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align={col.align}
                      className={TH_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedBreakdown.map((acct) => (
                  <tr
                    key={acct.accountId}
                    role="row"
                    className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                  >
                    {/* Account: the row identity. The name wraps unclamped. */}
                    <td role="cell" className="col-start-1 row-start-1 p-0 text-xs break-words font-medium text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3 sm:text-base sm:break-normal">
                      {acct.accountName}
                    </td>
                    <td role="cell" className={`col-start-1 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{breakdownColumns.holdings.label}</CellLabel>
                      <PartialTotal total={accountPartial(acct, acct.totalMarketValue)} displayCurrency={acct.currencyCode}>
                        {fmtFull(acct.totalMarketValue)}
                      </PartialTotal>
                    </td>
                    <td role="cell" className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{breakdownColumns.cash.label}</CellLabel>
                      {fmtFull(acct.cashBalance)}
                    </td>
                    {/* Total: the headline figure, beside the account. */}
                    <td role="cell" className={`col-start-3 row-start-1 font-medium text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{breakdownColumns.total.label}</CellLabel>
                      <PartialTotal total={accountPartial(acct, acct.totalMarketValue + acct.cashBalance)} displayCurrency={acct.currencyCode}>
                        {fmtFull(acct.totalMarketValue + acct.cashBalance)}
                      </PartialTotal>
                    </td>
                    <td role="cell" className={`col-start-3 row-start-2 font-medium ${gainLossColor(acct.totalGainLoss)} ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{breakdownColumns.gainLoss.label}</CellLabel>
                      {/* The server's gain is over the holdings that have a value
                          (A26-M38), so an incomplete account shows it as a
                          partial figure, marked like its neighbours. */}
                      <PartialTotal total={accountPartial(acct, acct.totalGainLoss)} displayCurrency={acct.currencyCode}>
                        {acct.totalGainLoss >= 0 ? '+' : ''}{fmtFull(acct.totalGainLoss)}
                      </PartialTotal>
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
