'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { netWorthApi } from '@/lib/net-worth';
import { investmentsApi } from '@/lib/investments';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { gainLossColor } from '@/lib/format';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { usePortfolioRangeWindow } from '@/hooks/usePortfolioRangeWindow';
import { PORTFOLIO_CHART_RANGES } from '@/components/investments/portfolio-range-window';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useIsMobile } from '@/hooks/useIsMobile';
import { usePortfolioPeriodResult } from '@/hooks/usePortfolioPeriodResult';
import type { UsePortfolioPeriodResultsValue } from '@/hooks/usePortfolioPeriodResults';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { createLogger } from '@/lib/logger';
import {
  isIntradayRange,
  buildIntradayCacheKey,
  readIntradayCache,
  writeIntradayCache,
  clearAllIntradayCache,
  computeTightYAxisDomain,
  renderChartFlagDot,
  ChartFlagShadowFilter,
  monthEndAxisTicks,
  sampledPointLabel,
  sampledTickLabel,
} from './portfolio-chart-utils';
import {
  periodResultUnknownReason,
} from './portfolio-period-result';
import {
  openingSessionDate,
  relabelOpeningPoint,
} from './portfolio-change-baseline';
import { EmptyState } from '@/components/ui/EmptyState';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { IncompleteDataDetails } from '@/components/reports/IncompleteDataDetails';
import { preferredCurrency } from '@/lib/default-currency';
import { investedValue } from '@/lib/invested-value';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import {
  foldIncompleteData,
  hasIncompleteData,
  type IncompleteDataCauses,
} from '@/lib/incomplete-data-ranges';

const NO_INCOMPLETE_DATA: IncompleteDataCauses = { prices: [], rates: [], cash: [] };

/**
 * The causes behind the withheld points, folded into runs. A cash account with
 * no balance is left out: the chart plots the securities alone, so it names
 * nothing the reader could repair to bring a point back.
 */
function investedCauses(points: Parameters<typeof foldIncompleteData>[0]): IncompleteDataCauses {
  return { ...foldIncompleteData(points), cash: [] };
}

/**
 * Whether a point's INVESTED value is one the server could work out. The chart
 * plots the securities alone, so a cash account with no balance for the day
 * (`cashComplete`) cannot make it wrong and is not read. Absent flags are no
 * information, which is why both reads are `=== false`.
 */
function isInvestedPointComplete(point: {
  pricesComplete?: boolean;
  fxComplete?: boolean;
}): boolean {
  return point.pricesComplete !== false && point.fxComplete !== false;
}

const logger = createLogger('InvestmentChart');

const DAILY_RANGES = new Set(['1w', 'mtd', '1m', '3m', 'ytd', '1y', '2y']);

/**
 * The page-level Refresh button broadcasts this event so the chart can clear
 * its sessionStorage cache and re-fetch when viewing an intraday range.
 */
export const INVESTMENT_CHART_REFRESH_EVENT = 'monize:investment-chart-refresh';

const RANGE_STORAGE_KEY = 'monize-investments-chart-range';

interface InvestmentValueTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number | null; payload: { name: string } }>;
  portfolioLabel: string;
  formatValue: (value: number) => string;
  unavailableLabel: string;
}

function InvestmentValueTooltip({ active, payload, portfolioLabel, formatValue, unavailableLabel }: InvestmentValueTooltipProps) {
  if (active && payload && payload.length) {
    const data = payload[0]?.payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          {portfolioLabel}{' '}
          {payload[0].value === null ? unavailableLabel : formatValue(payload[0].value)}
        </p>
      </div>
    );
  }
  return null;
}

interface InvestmentValueChartProps {
  accountIds?: string[];
  displayCurrency?: string | null;
  titleSuffix?: string;
  /**
   * Bumped by the surrounding view when a write changed the rows this series is
   * computed from. The chart otherwise fetches on mount and on a range or
   * currency change only, so a cash deposit or a trade moved today's point and
   * left the line -- and the Highest / Lowest / Change figures beside it -- at
   * their pre-write values (issue #1190). A bump also drops the intraday
   * sessionStorage entry, which would serve the pre-write points back to a
   * re-fetch that trusted it.
   */
  refreshKey?: number;
  /**
   * The page's "Portfolio performance" batch for the same accounts, currency
   * and refresh key. A range the batch reports reads its figures from there
   * instead of asking the server to value the same window again (#1888).
   */
  periodResults?: UsePortfolioPeriodResultsValue;
}

export function InvestmentValueChart({ accountIds, displayCurrency, titleSuffix, refreshKey = 0, periodResults }: InvestmentValueChartProps) {
  const t = useTranslations('investments');
  const tc = useTranslations('common');
  const tReports = useTranslations('reports');
  const { formatCurrency, formatCurrencyCompact, formatCurrencyAxis, formatCurrencyFlag, formatSignedPercent } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { defaultCurrency } = useExchangeRates();
  const isMobile = useIsMobile();
  // `iso` is the point's own date/timestamp, kept beside the display label so
  // the opening point can be dated by its session once the server names it.
  //
  // `Value` is NULL on a point the server could not price or convert: its
  // `value` is then the subtotal of what it could, and a subtotal plotted on a
  // value axis is indistinguishable from a measured dip. The area breaks there
  // (`connectNulls={false}`), and `complete` keeps the fact for the extremes.
  const [loadedPoints, setLoadedPoints] = useState<
    Array<{ name: string; Value: number | null; iso: string; complete: boolean }>
  >([]);
  // What the withheld points are waiting for, folded into ranges per cause. Only
  // the daily and sampled series carry the per-point lists to fold; an intraday
  // series reports completeness without dates, which is no information about
  // WHICH bars, so it names nothing rather than guessing.
  const [incompleteCauses, setIncompleteCauses] =
    useState<IncompleteDataCauses>(NO_INCOMPLETE_DATA);
  const [securityNames, setSecurityNames] = useState<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  // High/low value bubbles the user has temporarily dismissed, keyed by the
  // value they marked so a later data change with a new extreme shows the
  // bubble again. Component-local (not persisted), so it resets on navigation.
  const [dismissedHigh, setDismissedHigh] = useState<number | null>(null);
  const [dismissedLow, setDismissedLow] = useState<number | null>(null);
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

  const intradayRange = isIntradayRange(dateRange) ? dateRange : null;
  const isIntraday = intradayRange !== null;
  const useDaily = !isIntraday && DAILY_RANGES.has(dateRange);

  // A price series opens on the close it is measured from, which is not the
  // period the range names -- see `portfolio-range-window.ts`.
  const chartWindow = usePortfolioRangeWindow({
    range: dateRange,
    base: resolvedRange,
  });

  // Determine the effective currency for display
  const foreignCurrency = displayCurrency && displayCurrency !== defaultCurrency
    ? displayCurrency
    : null;
  const effectiveCurrency = foreignCurrency || preferredCurrency(defaultCurrency);

  const fmtVal = useCallback((value: number) => {
    if (foreignCurrency) return `${formatCurrencyCompact(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrencyCompact(value);
  }, [foreignCurrency, formatCurrencyCompact]);

  // Summary-card values (Highest / Lowest / Change) use the currency's
  // standard fraction digits rather than the rounded compact form, so the
  // user sees the full precision instead of a truncated dollar figure.
  const fmtFull = useCallback((value: number) => {
    if (foreignCurrency) return `${formatCurrency(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrency(value);
  }, [foreignCurrency, formatCurrency]);

  const fmtAxis = useCallback((value: number) => {
    if (foreignCurrency) return formatCurrencyAxis(value, foreignCurrency);
    return formatCurrencyAxis(value);
  }, [foreignCurrency, formatCurrencyAxis]);

  // Flag bubble label: 2-decimal compact notation. Reads more precisely
  // than the 1-decimal axis ticks so the highlighted high/low value can
  // be picked out without squinting at the connector position.
  const fmtFlag = useCallback((value: number) => {
    if (foreignCurrency) return formatCurrencyFlag(value, foreignCurrency);
    return formatCurrencyFlag(value);
  }, [foreignCurrency, formatCurrencyFlag]);

  // Sequence number for the latest in-flight load. Lets us cancel stale
  // results that resolve out-of-order if the user clicks ranges quickly.
  const loadSeqRef = useRef(0);

  const formatIntradayLabel = useCallback(
    (iso: string, range: string) => {
      const d = new Date(iso);
      return range === '1d'
        ? formatChartDate(d, 'HH:mm')
        : formatChartDate(d, 'MMM d HH:mm');
    },
    [formatChartDate],
  );

  const loadDailyOrMonthly = useCallback(
    async (seq: number) => {
      const { start, end } = chartWindow;
      const params = {
        startDate: start,
        endDate: end,
        accountIds: accountIds?.length ? accountIds.join(',') : undefined,
        displayCurrency: foreignCurrency || undefined,
      };
      if (useDaily || isIntraday) {
        // 1W/MTD/1M intraday fallback also uses the daily endpoint.
        const data = await netWorthApi.getInvestmentsDaily(params);
        if (loadSeqRef.current !== seq) return;
        setLoadedPoints(
          data.map((d) => {
            const complete = isInvestedPointComplete(d);
            return {
              name: formatChartDate(d.date, 'MMM d, yyyy'),
              Value: complete ? investedValue(d) : null,
              iso: d.date,
              complete,
            };
          }),
        );
        setIncompleteCauses(investedCauses(data));
      } else {
        // A long range is the same daily valuation sampled at each month-end,
        // opening and closing on the closes the figures beside it are
        // measured between -- never a stored month-end snapshot, whose first
        // point is a month boundary rather than the period's own start.
        const data = await netWorthApi.getInvestmentsDaily({
          ...params,
          sampling: 'monthEnd',
        });
        if (loadSeqRef.current !== seq) return;
        setLoadedPoints(
          data.map((d, index) => {
            const complete = isInvestedPointComplete(d);
            return {
              name: sampledPointLabel(d.date, index, data.length, formatChartDate),
              Value: complete ? investedValue(d) : null,
              iso: d.date,
              complete,
            };
          }),
        );
        setIncompleteCauses(investedCauses(data));
      }
    },
    [chartWindow, accountIds, foreignCurrency, useDaily, isIntraday, formatChartDate],
  );

  // The fetch alone. Whoever starts it has already put the view into its
  // loading state: `loadData` for a refresh, the render below for a change of
  // range, accounts or currency.
  const fetchData = useCallback(
    (opts: { skipCache?: boolean } = {}) => {
      const seq = ++loadSeqRef.current;
      // The writes live in the inner function so they run after the request,
      // not during the effect that starts it.
      const run = async () => {
        try {
          if (intradayRange) {
            const cacheKey = buildIntradayCacheKey(
              dateRange,
              accountIds,
              effectiveCurrency,
            );
            // The cache is read a microtask later, so hydrating from it never
            // sets state synchronously inside the effect that starts the load.
            await Promise.resolve();
            if (loadSeqRef.current !== seq) return;
            const cached = !opts.skipCache ? readIntradayCache(cacheKey) : null;

            // Hydrate from cache immediately so the chart appears even before
            // the network round-trip resolves.
            if (cached && !cached.fallbackToDaily) {
              setLoadedPoints(
                cached.points.map((p) => {
                  const complete = isInvestedPointComplete(p);
                  return {
                    name: formatIntradayLabel(p.timestamp, dateRange),
                    Value: complete ? investedValue(p) : null,
                    iso: p.timestamp,
                    complete,
                  };
                }),
              );
              setIncompleteCauses(NO_INCOMPLETE_DATA);
              setIsLoading(false);
            }

            let response;
            try {
              response = await investmentsApi.getIntradayValue({
                range: intradayRange,
                accountIds: accountIds?.length ? accountIds.join(',') : undefined,
                displayCurrency: foreignCurrency || undefined,
              });
            } catch (error) {
              logger.error('Failed to load intraday data:', error);
              if (loadSeqRef.current !== seq) return;
              // Intraday fetch failed -- silently fall back to the
              // daily-snapshot endpoint so the user still sees a chart.
              await loadDailyOrMonthly(seq);
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
              // Some holdings (typically MSN-tracked) lack intraday support.
              if (dateRange === '1d') {
                // No sensible daily-resolution fallback for a single day.
                setLoadedPoints([]);
                setIncompleteCauses(NO_INCOMPLETE_DATA);
                setIntradayUnavailable({ skipped: response.skippedSymbols });
                setIsLoading(false);
                return;
              }
              // 1W / MTD / 1M: silently fall back to the daily-snapshot endpoint and
              // flag the title with a small warning icon so the user knows the
              // chart is at daily resolution rather than the requested intraday
              // resolution.
              setIntradayUnavailable(null);
              setIntradayFallbackNotice({ skipped: response.skippedSymbols });
              await loadDailyOrMonthly(seq);
              return;
            }

            setLoadedPoints(
              response.points.map((p) => {
                const complete = isInvestedPointComplete(p);
                return {
                  name: formatIntradayLabel(p.timestamp, dateRange),
                  Value: complete ? investedValue(p) : null,
                  iso: p.timestamp,
                  complete,
                };
              }),
            );
            setIncompleteCauses(NO_INCOMPLETE_DATA);
          } else {
            await loadDailyOrMonthly(seq);
          }
        } catch (error) {
          logger.error('Failed to load investment data:', error);
        } finally {
          if (loadSeqRef.current === seq) {
            setIsLoading(false);
          }
        }
      };
      return run();
    },
    [
      intradayRange,
      dateRange,
      accountIds,
      effectiveCurrency,
      foreignCurrency,
      formatIntradayLabel,
      loadDailyOrMonthly,
    ],
  );

  const loadData = useCallback(
    (opts: { skipCache?: boolean } = {}) => {
      setIsLoading(true);
      setIntradayUnavailable(null);
      setIntradayFallbackNotice(null);
      return fetchData(opts);
    },
    [fetchData],
  );

  // A new range, account set or currency is a new request: show it loading
  // from the render that asks for it (the "info from previous render" pattern,
  // not a setState in the effect that fetches it). An invalid range asks for
  // nothing, so it leaves the view as it is.
  const requestKey = isValid
    ? [
        dateRange,
        accountIds?.join(',') ?? '',
        effectiveCurrency,
        foreignCurrency ?? '',
        chartWindow.start,
        chartWindow.end,
      ].join('|')
    : null;
  const [loadingKey, setLoadingKey] = useState(requestKey);
  if (loadingKey !== requestKey) {
    setLoadingKey(requestKey);
    if (requestKey !== null) {
      setIsLoading(true);
      setIntradayUnavailable(null);
      setIntradayFallbackNotice(null);
    }
  }

  useEffect(() => {
    if (isValid) {
      void fetchData();
    }
  }, [isValid, fetchData]);

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

  // Re-fetch when the surrounding view reports a write.
  //
  // The key this chart has already acted on is what gates the fetch, not the
  // effect running: `loadData` changes identity on every range, account and
  // currency change, and the effect above already re-fetches for each of those.
  // Without the comparison this effect would fetch a second time for all of
  // them, and once more on any mount under an already-nonzero key.
  const actedOnRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (actedOnRefreshKey.current === refreshKey) return;
    actedOnRefreshKey.current = refreshKey;
    // The daily and monthly endpoints are uncached, so re-asking is enough; the
    // intraday one is served from sessionStorage until it is dropped.
    if (isIntraday) clearAllIntradayCache();
    void loadData({ skipCache: true });
  }, [refreshKey, isIntraday, loadData]);

  // What the portfolio DID over this window, as the server worked it out: the
  // value change, the money the reader moved in or out, and what is left. A
  // change read off the plotted series counts a deposit as performance
  // (INV-PORTRESULT-001), so nothing here subtracts two points. The window is
  // NAMED, not dated: the one this chart draws opens earlier than the period
  // its button names, and measuring over it reported a week under "1D".
  const { periodResult } = usePortfolioPeriodResult({
    range: dateRange,
    startDate: chartWindow.start,
    periodStartDate: chartWindow.periodStart,
    endDate: chartWindow.end,
    hasSeries: loadedPoints.length > 0,
    accountIds: accountIds?.length ? accountIds.join(',') : undefined,
    displayCurrency: foreignCurrency || undefined,
    reloadKey: refreshKey,
    shared: periodResults,
  });

  // The series as drawn. It was requested from the day the period is measured
  // from, and its opening point is dated by the session that day's close came
  // from -- the same session the caption below names -- rather than by a
  // boundary the market was shut on (`openingSessionDate`).
  const chartPoints = useMemo(
    () =>
      relabelOpeningPoint(
        loadedPoints,
        openingSessionDate(loadedPoints[0]?.iso, periodResult),
        (point, session) => ({
          ...point,
          name: formatChartDate(session, 'MMM d, yyyy'),
        }),
      ),
    [loadedPoints, periodResult, formatChartDate],
  );

  // The three figures the cards print, and the one repair a withheld one points
  // at. `null` is the server's answer that it withheld the figure and said why.
  //
  // The chart plots the INVESTED value, so every figure here is the invested
  // part's: the value change is the line's last point less its first, and it
  // reconciles with the result as change - net invested + income. The same
  // measure the "Portfolio performance" card reports, so the two cannot
  // disagree on one page (INV-PORTRESULT-002,
  // `docs/specs/portfolio-period-result.md` sections 10.7 and 10.9).
  const valueChange = periodResult?.investedValueChange ?? null;
  const netInvested = periodResult?.investmentCapitalFlows ?? null;
  const investmentIncome = periodResult?.investmentIncome ?? null;
  const investmentResult = periodResult?.investmentPnl ?? null;
  const returnPercent = periodResult?.investmentReturnPercent ?? null;
  const unknownReason = periodResultUnknownReason(
    periodResult?.investedReasons ?? [],
  );
  // The session these figures are measured from, under the title rather than
  // behind a marker: it is a fact about every window on this chart, not a
  // caveat about three of them. `startPriceDate` is the trading day the
  // opening value came from, which on a Monday is the Friday before -- the
  // calendar boundary beside it names a day the market was shut.
  const measuredFromLabel = periodResult?.startPriceDate
    ? t('investmentValueChart.measuredFromClose', {
        date: formatChartDate(periodResult.startPriceDate, 'MMM d, yyyy'),
      })
    : null;
  /** A secondary figure's text: the amount, or the words the cards print. */
  const secondaryText = (value: number | null) =>
    value === null
      ? t('investmentValueChart.notAvailable')
      : `${value >= 0 ? '+' : ''}${fmtFull(value)}`;

  // Highest and lowest are claims about EVERY point, and a point the server
  // could not finish is a subtotal that can sit anywhere in the ordering: the
  // real high or low may be the day that is missing a component. One incomplete
  // point therefore leaves BOTH unknown rather than ranking a partial figure
  // against whole ones (the Portfolio Value report's rule). An empty series has
  // nothing to rank, which is unknown too -- never a measured zero.
  const valuesIncomplete = useMemo(
    () => chartPoints.some((p) => p.complete === false),
    [chartPoints],
  );
  const summary = useMemo(() => {
    const values = chartPoints
      .map((p) => p.Value)
      .filter((v): v is number => v !== null);
    if (valuesIncomplete || values.length === 0) {
      return { highest: null as number | null, lowest: null as number | null };
    }
    return {
      highest: Math.max(...values),
      lowest: Math.min(...values),
    };
  }, [chartPoints, valuesIncomplete]);

  // Names for the ids in the diagnostics, loaded only once something is
  // missing and including inactive securities: the holding whose history is
  // missing is often one the reader deactivated after selling it.
  const needsSecurityNames = incompleteCauses.prices.length > 0;
  useEffect(() => {
    if (!needsSecurityNames) return;
    let cancelled = false;
    investmentsApi
      .getSecurities(true)
      .then((securities) => {
        if (cancelled) return;
        setSecurityNames(new Map(securities.map((s) => [s.id, s.symbol || s.name])));
      })
      .catch((error) => {
        // A failed lookup is not an empty portfolio: the fallback label stands in.
        logger.error('Failed to load securities for the incomplete-data list:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [needsSecurityNames]);
  const securityLabel = useCallback(
    (securityId: string) =>
      securityNames.get(securityId) ?? tReports('portfolioValue.incompleteUnknownSecurity'),
    [securityNames, tReports],
  );

  const xAxisTicks = useMemo(() => {
    if (!isIntraday && !useDaily) return monthEndAxisTicks(chartPoints);
    if (chartPoints.length <= 36) return undefined;
    const step = Math.ceil(chartPoints.length / 7);
    return chartPoints.filter((_, i) => i % step === 0).map((d) => d.name);
  }, [chartPoints, isIntraday, useDaily]);

  // A month-end-sampled tick is formatted from its point's own date, found by
  // its label, so the day-dated ends and the month-dated middle each read
  // right in every locale.
  const pointIndexByName = useMemo(
    () => new Map(chartPoints.map((p, index) => [p.name, index])),
    [chartPoints],
  );

  const yAxisDomain = useMemo(
    () => computeTightYAxisDomain(
      chartPoints.map((d) => d.Value).filter((v): v is number => v !== null),
    ),
    [chartPoints],
  );

  // Index of the first point at the highest / lowest value, for the
  // bubble callouts. Suppress when the series is flat (highest === lowest)
  // -- two stacked bubbles at the same point would just be visual noise.
  const highestIndex = useMemo(
    () =>
      chartPoints.length === 0 || summary.highest === null
        ? -1
        : chartPoints.findIndex((p) => p.Value === summary.highest),
    [chartPoints, summary.highest],
  );
  const lowestIndex = useMemo(
    () =>
      chartPoints.length === 0 || summary.lowest === null
        ? -1
        : chartPoints.findIndex((p) => p.Value === summary.lowest),
    [chartPoints, summary.lowest],
  );
  const showFlags =
    summary.highest !== null &&
    summary.lowest !== null &&
    summary.highest !== summary.lowest;

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
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-4">
        <div>
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
          {t('investmentValueChart.title')}{titleSuffix ? ` (${titleSuffix})` : ''}
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
              {t('investmentValueChart.updatingLabel')}
            </span>
          )}
          {intradayFallbackNotice && (
            // The explanation is translated and reachable by tap and keyboard
            // in an InfoTooltip, not an English hover-only title.
            <span
              className="inline-flex items-center text-amber-500 dark:text-amber-400"
              data-testid="intraday-fallback-warning"
            >
              <ExclamationTriangleIcon
                className="h-4 w-4"
                aria-label={t('investmentValueChart.intradayFallbackWarningAriaLabel')}
                role="img"
              />
              <InfoTooltip
                usePortal
                text={t('investmentValueChart.intradayFallbackWarning', {
                  holdings:
                    intradayFallbackNotice.skipped.length > 0
                      ? intradayFallbackNotice.skipped.join(', ')
                      : t('investmentValueChart.intradayFallbackSomeHoldings'),
                })}
              />
            </span>
          )}
        </h3>
        {/* Deep-link to the full Portfolio Value report for the richer view
            (per-security breakdown, table, PDF/CSV export). */}
        <Link
          href="/reports/portfolio-value"
          title={t('investmentValueChart.viewReportTitle')}
          className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
        >
          {t('investmentValueChart.viewReport')}
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </Link>
        </div>
        {measuredFromLabel && (
          <p
            className="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
            data-testid="measured-from-close"
          >
            {measuredFromLabel}
          </p>
        )}
        </div>
        <DateRangeSelector
          ranges={PORTFOLIO_CHART_RANGES}
          value={dateRange}
          onChange={handleRangeChange}
          activeColour="bg-emerald-600"
          size="sm"
        />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-4">
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
            {t('investmentValueChart.highestValue')}
            {valuesIncomplete && (
              <InfoTooltip placement="top" text={t('investmentValueChart.incompleteTooltip')} />
            )}
          </div>
          <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
            {summary.highest === null ? (
              <span className="text-gray-400 dark:text-gray-500 text-sm font-normal">
                {t('investmentValueChart.notAvailable')}
              </span>
            ) : (
              fmtFull(summary.highest)
            )}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
            {t('investmentValueChart.lowestValue')}
            {valuesIncomplete && (
              <InfoTooltip placement="top" text={t('investmentValueChart.incompleteTooltip')} />
            )}
          </div>
          <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
            {summary.lowest === null ? (
              <span className="text-gray-400 dark:text-gray-500 text-sm font-normal">
                {t('investmentValueChart.notAvailable')}
              </span>
            ) : (
              fmtFull(summary.lowest)
            )}
          </div>
        </div>
        {/* The securities line's own change: its last point less its first.
            It includes what was paid into them, which is why it stands beside
            the result rather than under a "Return" caption. */}
        <div className="max-sm:col-start-1">
          <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
            {t('investmentValueChart.valueChange')}
            <InfoTooltip
              placement="top"
              text={t('investmentValueChart.valueChangeTooltip')}
            />
          </div>
          <div
            className={`text-lg font-bold ${valueChange === null ? '' : gainLossColor(valueChange)}`}
            data-testid="period-value-change"
          >
            {valueChange === null ? (
              <UnknownAmount reason={unknownReason} className="text-sm font-normal" />
            ) : (
              <>{valueChange >= 0 ? '+' : ''}{fmtFull(valueChange)}</>
            )}
          </div>
        </div>
        {/* What the holdings earned over the window: the value change beside
            it, less what was paid in, plus what was paid out, both named on
            the secondary lines beneath. */}
        <div className="max-sm:col-start-2 max-sm:row-span-2">
          <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
            {t('investmentValueChart.investmentResult')}
            <InfoTooltip
              placement="top"
              text={t('investmentValueChart.investmentResultTooltip')}
            />
          </div>
          <div className={`text-lg font-bold ${investmentResult === null ? '' : gainLossColor(investmentResult)}`}>
            {investmentResult === null ? (
              <UnknownAmount reason={unknownReason} className="text-sm font-normal" />
            ) : (
              <>{investmentResult >= 0 ? '+' : ''}{fmtFull(investmentResult)}</>
            )}
          </div>
          {/* What separates the result from the value change: what was paid
              into the securities, and what they paid out. Secondary, but
              named: a reader who bought during the window is owed the number
              that explains why the line moved more than the result. */}
          <div
            className="text-xs text-gray-500 dark:text-gray-400"
            data-testid="period-net-invested"
          >
            {t('investmentValueChart.netInvestedLine', {
              amount: secondaryText(netInvested),
            })}
          </div>
          <div
            className="text-xs text-gray-500 dark:text-gray-400"
            data-testid="period-income"
          >
            {t('investmentValueChart.incomeLine', {
              amount: secondaryText(investmentIncome),
            })}
          </div>
        </div>
        <div className="max-sm:col-start-1">
          <div className="text-xs text-gray-500 dark:text-gray-400">{t('investmentValueChart.investmentReturn')}</div>
          <div className={`text-lg font-bold ${returnPercent === null ? '' : gainLossColor(returnPercent)}`}>
            {returnPercent === null ? (
              <UnknownAmount reason={unknownReason} className="text-sm font-normal" />
            ) : (
              formatSignedPercent(returnPercent, 1)
            )}
          </div>
        </div>
      </div>

      {/* What the withheld points are waiting for, named and dated, beside the
          cards rather than inside a tooltip (the report's own treatment). */}
      {hasIncompleteData(incompleteCauses) && (
        <div className="mb-4">
          <IncompleteDataDetails
            causes={incompleteCauses}
            securityLabel={securityLabel}
            accountLabel={() => tReports('portfolioValue.incompleteUnknownAccount')}
          />
        </div>
      )}

      {/* Chart */}
      {intradayUnavailable ? (
        <EmptyState
          className="px-4"
          title={t('investmentValueChart.intradayUnavailableTitle')}
          description={
            <>
              {t('investmentValueChart.intradayUnavailableDescription')}
              {intradayUnavailable.skipped.length > 0
                ? `: ${intradayUnavailable.skipped.join(', ')}`
                : ''}
            </>
          }
        />
      ) : chartPoints.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('investmentValueChart.noDataForPeriod')}
        </p>
      ) : (
        <div
          className={`h-80 transition-opacity duration-200 ${
            isLoading ? 'opacity-60' : 'opacity-100'
          }`}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            {/* Tighter margins on mobile to reclaim wasted space. The desktop
                margins leave generous room around the high/low flag bubbles;
                on a narrow screen those gutters dwarf the plot, so trim them. */}
            <AreaChart
              data={chartPoints}
              margin={
                isMobile
                  ? { top: 16, right: 8, left: 0, bottom: 8 }
                  : { top: 30, right: 30, left: 0, bottom: 30 }
              }
            >
              <defs>
                <linearGradient id="colorInvestments" x1="0" y1="0" x2="0" y2="1">
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
                tickFormatter={(value: string) => {
                  if (isIntraday) {
                    return value;
                  }
                  if (useDaily) {
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
                }}
              />
              <YAxis
                domain={yAxisDomain}
                tickFormatter={fmtAxis}
                tick={{ fontSize: 12 }}
                width={isMobile ? 44 : undefined}
              />
              <Tooltip
                content={
                  <InvestmentValueTooltip
                    portfolioLabel={t('investmentValueChart.portfolioLabel')}
                    formatValue={fmtVal}
                    unavailableLabel={t('investmentValueChart.notAvailable')}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="Value"
                stroke={chartColors.income}
                strokeWidth={2}
                connectNulls={false}
                fillOpacity={1}
                fill="url(#colorInvestments)"
                name="Portfolio Value"
                isAnimationActive={false}
                activeDot={{ r: 4, fill: chartColors.income }}
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
  );
}
