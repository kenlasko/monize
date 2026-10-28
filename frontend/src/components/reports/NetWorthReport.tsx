'use client';

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useReportingBasis } from './ReportingBasis';
import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { netWorthApi } from '@/lib/net-worth';
import { MonthlyNetWorth } from '@/types/net-worth';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { useDateRange } from '@/hooks/useDateRange';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { NetWorthByAccountTypeChart, type NetWorthBarStyle } from '@/components/reports/NetWorthByAccountTypeChart';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { PartialDataNotice } from '@/components/reports/PartialDataNotice';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { isComplete } from '@/lib/currency-total';
import {
  missingCurrenciesFromPairs,
  partialTotalFor,
  unionPairs,
} from '@/lib/net-worth-completeness';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { createLogger } from '@/lib/logger';

const logger = createLogger('NetWorthReport');

type NetWorthSortField = 'name' | 'assets' | 'liabilities' | 'netWorth';

interface NetWorthTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; payload: { name: string } }>;
  formatCurrency: (value: number) => string;
}

function NetWorthTooltip({ active, payload, formatCurrency }: NetWorthTooltipProps) {
  if (active && payload && payload.length) {
    const data = payload[0]?.payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
        {payload.map((entry, index) => (
          <p key={index} className="text-sm" style={{ color: entry.color }}>
            {entry.name}: {formatCurrency(entry.value)}
          </p>
        ))}
      </div>
    );
  }
  return null;
}

interface CompositionTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { name: string; Assets: number | null; Liabilities: number | null } }>;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number, decimals?: number) => string;
  t: ReturnType<typeof useTranslations<'reports'>>;
}

function CompositionTooltip({ active, payload, formatCurrency, formatPercent, t }: CompositionTooltipProps) {
  if (active && payload && payload.length) {
    const data = payload[0]?.payload;
    // A withheld month has no split to print: a subtotal would read as a total.
    if (data?.Assets == null || data?.Liabilities == null) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400 max-w-56">{t('netWorth.partialMonth')}</p>
        </div>
      );
    }
    const assets = data.Assets;
    const liabilities = data.Liabilities;
    const total = assets + liabilities;
    const pct = (value: number) => (total > 0 ? formatPercent(((value / total) * 100), 1) : '0%');
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
        <p className="text-sm" style={{ color: chartColors.income }}>
          {t('netWorth.colAssets')}: {formatCurrency(assets)} ({pct(assets)})
        </p>
        <p className="text-sm" style={{ color: chartColors.expense }}>
          {t('netWorth.colLiabilities')}: {formatCurrency(liabilities)} ({pct(liabilities)})
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 pt-1 border-t border-gray-100 dark:border-gray-700">
          {t('netWorth.seriesNetWorth')}: {formatCurrency(assets - liabilities)}
        </p>
      </div>
    );
  }
  return null;
}

export function NetWorthReport() {
  const { exportCsvWithBasis, withPdfBasis } = useReportExportMetadata();
  const basis = useReportingBasis();
  const t = useTranslations('reports');
  const formatChartDate = useChartDateFormat();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatCurrencyLabel, formatSignedPercent, formatPercent, formatPercentTrimmed, defaultCurrency } = useNumberFormat();
  const isMobile = useIsMobile();
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [chartType, setChartType] = useLocalStorage<'line' | 'bar' | 'stacked' | 'table'>(
    'reports.net-worth.chartType',
    'bar',
  );
  const [barStyle, setBarStyle] = useLocalStorage<NetWorthBarStyle>(
    'reports.net-worth.barStyle',
    'accountType',
  );
  const chartRef = useRef<HTMLDivElement>(null);
  const { dateRange, setDateRange, startDate, setStartDate, endDate, setEndDate, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });
  const { sortField, sortDirection, handleSort } = useSortableTable<NetWorthSortField>(
    'reports.net-worth.table.sort',
    { field: 'name', direction: 'asc' },
  );

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      isValid && rangeEnd
        ? netWorthApi.getMonthly({
            ...(basis ? { basis } : {}),
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd, basis],
    { requestKey: JSON.stringify([isValid, rangeStart, rangeEnd, basis]), maskStaleData: true },
  );

  const monthlyData = useMemo<MonthlyNetWorth[]>(
    () => response ?? [],
    [response],
  );

  const handleRecalculate = async () => {
    setIsRecalculating(true);
    try {
      await netWorthApi.recalculate();
      reload();
    } catch (error) {
      logger.error('Failed to recalculate:', error);
    } finally {
      setIsRecalculating(false);
    }
  };

  // A month with `fxComplete === false` holds SUBTOTALS: a component that could
  // not be converted is missing from all three figures. It is drawn as `null`
  // (a gap), never as a measured dip, and the line and area never bridge it.
  const chartData = useMemo(() =>
    monthlyData.map((d) => {
      const partial = d.fxComplete === false;
      return {
      // `name` is the formatted display label; `sortKey` is the ISO month
      // (YYYY-MM) so the table can sort chronologically rather than
      // alphabetically by month-name ("Apr 2021" < "Aug 2020" lexically) and
      // so the chart axis can format month markers locale-aware from the raw
      // value rather than splitting the localized label.
      name: formatChartDate(d.month, 'MMM yyyy'),
      sortKey: d.month,
      partial,
      // What the table prints: the subtotal, marked, where the chart has a gap.
      assetsValue: Math.round(d.assets),
      liabilitiesValue: Math.round(d.liabilities),
      netWorthValue: Math.round(d.netWorth),
      pairs: d.missingRatePairs ?? [],
      Assets: partial ? null : Math.round(d.assets),
      Liabilities: partial ? null : Math.round(d.liabilities),
      NetWorth: partial ? null : Math.round(d.netWorth),
    };
    }),
  [monthlyData, formatChartDate]);

  // The bar view's points: the same months, keyed by the raw ISO month the
  // axis formats, with the server's per-account-type split.
  const accountTypeData = useMemo(
    () =>
      monthlyData.map((d, i) => ({
        key: d.month,
        name: chartData[i].name,
        netWorth: chartData[i].NetWorth,
        // A withheld month carries no breakdown either: its types are subtotals.
        byAccountType: chartData[i].partial ? undefined : d.byAccountType,
      })),
    [monthlyData, chartData],
  );

  // The headline and the change read the END months of the window. Either end
  // being a subtotal makes the change unknown (the other end cannot vouch for
  // it); the current figure is the latest month's, marked when it is partial.
  const summary = useMemo(() => {
    if (monthlyData.length === 0) {
      return { current: 0, change: 0, changePercent: 0, currentTotal: partialTotalFor(0, undefined), pairs: [] as string[], currentPairs: [] as string[], anyPartial: false, changeKnown: true };
    }
    const last = monthlyData[monthlyData.length - 1];
    const first = monthlyData[0];
    const current = Math.round(last.netWorth);
    const initial = Math.round(first.netWorth);
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    const changeKnown = last.fxComplete !== false && first.fxComplete !== false;
    return {
      current,
      change,
      changePercent,
      currentTotal: partialTotalFor(current, last.fxComplete, last.missingRatePairs),
      currentPairs: last.missingRatePairs ?? [],
      // Every pair either end month could not convert, for the notice.
      pairs: unionPairs(monthlyData.filter((m) => m.fxComplete === false)),
      anyPartial: monthlyData.some((m) => m.fxComplete === false),
      changeKnown,
    };
  }, [monthlyData]);

  const sortedTableData = useMemo(() => {
    const sorted = [...chartData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.sortKey, b.sortKey);
          break;
        case 'assets':
          comparison = compareValues(a.assetsValue, b.assetsValue);
          break;
        case 'liabilities':
          comparison = compareValues(a.liabilitiesValue, b.liabilitiesValue);
          break;
        case 'netWorth':
          comparison = compareValues(a.netWorthValue, b.netWorthValue);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection]);

  // For long ranges, explicitly specify which ticks to show so years don't repeat.
  // Ticks are keyed off the raw ISO month (sortKey, YYYY-MM-DD) so the January
  // filter and axis formatting stay locale-independent.
  const xAxisTicks = useMemo(() => {
    if (chartData.length <= 36) return undefined; // let Recharts auto-decide for shorter ranges
    // Only show ticks on January of each year
    return chartData
      .filter(d => d.sortKey.slice(5, 7) === '01')
      .map(d => d.sortKey);
  }, [chartData]);

  // Calculate Y-axis domain to avoid starting at 0 when values are significantly higher
  const yAxisDomain = useMemo(() => {
    if (chartData.length === 0) return [0, 'auto'] as [number, 'auto'];

    // A withheld (null) month is not a value of zero: it sets no bound.
    const values = chartData.flatMap(d => (d.NetWorth === null ? [] : [d.NetWorth]));
    if (values.length === 0) return [0, 'auto'] as [number, 'auto'];
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue;

    // If min is significantly above 0 (more than 20% of the range), don't start at 0
    // Also check that all values are positive
    if (minValue > 0 && minValue > range * 0.2) {
      // Round down to a nice number for the axis minimum
      const padding = range * 0.1; // 10% padding below minimum
      const rawMin = minValue - padding;

      // Round to a nice number based on magnitude
      const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawMin))));
      const niceMin = Math.floor(rawMin / magnitude) * magnitude;

      return [niceMin, 'auto'] as [number, 'auto'];
    }

    // If values cross 0 or start near 0, include 0 in the domain
    return [Math.min(0, minValue), 'auto'] as [number, 'auto'];
  }, [chartData]);

  // The extremes are ranked over complete months only; a withheld month is
  // neither the high nor the low.
  const minMax = useMemo(() => {
    const known = chartData.flatMap((d) =>
      d.NetWorth === null ? [] : [{ ...d, NetWorth: d.NetWorth }],
    );
    if (known.length < 2) return null;
    let minIdx = 0, maxIdx = 0;
    for (let i = 1; i < known.length; i++) {
      if (known[i].NetWorth < known[minIdx].NetWorth) minIdx = i;
      if (known[i].NetWorth > known[maxIdx].NetWorth) maxIdx = i;
    }
    if (minIdx === maxIdx) return null;
    return {
      min: known[minIdx],
      max: known[maxIdx],
    };
  }, [chartData]);

  // Pairs as the server names them, or a plain word when the flag came without any.
  const partialPairsLabel = (pairs: readonly string[]) =>
    pairs.length > 0 ? pairs.join(', ') : t('netWorth.notAvailable');

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const currentIsPartial = !isComplete(summary.currentTotal);
    const unknown = t('netWorth.notAvailable');
    await exportToPdf(withPdfBasis({
      title: t('netWorth.pdfTitle'),
      subtitle: `${chartData[0]?.name || ''} - ${chartData[chartData.length - 1]?.name || ''}`,
      summaryCards: [
        {
          label: t('netWorth.currentNetWorth'),
          value: formatCurrency(summary.current),
          color: summary.current >= 0 ? '#16a34a' : '#dc2626',
          // A subtotal leaves the application labelled as one.
          ...(currentIsPartial && {
            note: t('netWorth.pdfPartialNote', { pairs: partialPairsLabel(summary.currentPairs) }),
          }),
        },
        summary.changeKnown
          ? { label: t('netWorth.change'), value: `${summary.change >= 0 ? '+' : ''}${formatCurrency(summary.change)}`, color: summary.change >= 0 ? '#16a34a' : '#dc2626' }
          : { label: t('netWorth.change'), value: unknown },
        summary.changeKnown
          ? { label: t('netWorth.changePct'), value: formatSignedPercent(summary.changePercent, 1), color: summary.changePercent >= 0 ? '#16a34a' : '#dc2626' }
          : { label: t('netWorth.changePct'), value: unknown },
      ],
      chartContainer: chartRef.current,
      filename: 'net-worth-report',
    }));
  };

  const handleExportCsv = () => {
    const headers = [t('netWorth.colMonth'), t('netWorth.colAssets'), t('netWorth.colLiabilities'), t('netWorth.colNetWorth'), t('netWorth.colNote')];
    // A partial month's three figures are subtotals; the Note column says so,
    // naming the pairs, so a spreadsheet never holds one unmarked.
    const rows = sortedTableData.map((d) => [
      d.name,
      d.assetsValue,
      d.liabilitiesValue,
      d.netWorthValue,
      d.partial ? t('netWorth.partialMonthNote', { pairs: partialPairsLabel(d.pairs) }) : '',
    ]);
    exportCsvWithBasis('net-worth-report', headers, rows);
  };

  // Per-bar value labels are only legible on the shorter (1y/2y) ranges; longer
  // ranges pack too many bars together. Beyond ~14 bars the labels are rotated
  // vertical so the 2-year view doesn't overlap. On mobile the bars are narrow
  // enough that even the 12-bar 1-year view needs vertical labels.
  const showBarLabels = dateRange === '1y' || dateRange === '2y';
  const barLabelsVertical = showBarLabels && (chartData.length > 14 || isMobile);

  // Shared between the area, bar and stacked charts so the month labels stay
  // consistent as the range widens. `value` is the raw ISO month (sortKey,
  // YYYY-MM-DD) so the markers are formatted locale-aware rather than by
  // splitting an already-localized label string.
  const formatXAxisTick = (value: string) => {
    if (chartData.length > 36) {
      // Long ranges show January ticks only, labelled with the year alone.
      // Read the year straight off the raw ISO value so it is exact and
      // locale-independent.
      return value.slice(0, 4);
    } else if (chartData.length > 18) {
      return formatChartDate(value, 'MMM yy');
    }
    return formatChartDate(value, 'MMM');
  };

  // The 100% stacked view normalises each bar to its assets/liabilities split,
  // so the Y axis reads as a percentage rather than a currency amount.
  const formatPercentAxis = (value: number) => `${formatPercentTrimmed(Math.round(value * 100))}`;

  // Loading and error states are rendered *inside* this tree, never as an
  // early return. Returning a different tree unmounts the controls block, and
  // with it the date field the user is typing into -- which is what made this
  // report impossible to type a custom range into (issue #1201).
  const dataUnavailable = isLoading || !!error;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      {dataUnavailable ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('netWorth.currentNetWorth')}</div>
          <div className={`text-2xl font-bold ${
            gainLossColor(summary.current)
          }`}>
            <PartialTotal total={summary.currentTotal} displayCurrency={defaultCurrency}>
              {formatCurrency(summary.current)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('netWorth.change')}</div>
          {summary.changeKnown ? (
            <div className={`text-2xl font-bold ${gainLossColor(summary.change)}`}>
              {summary.change >= 0 ? '+' : ''}{formatCurrency(summary.change)}
            </div>
          ) : (
            // A change between a subtotal and anything is not a change.
            <div className="text-2xl font-bold text-gray-500 dark:text-gray-400">
              <UnknownAmount reason="displayFx" />
            </div>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('netWorth.changePct')}</div>
          {summary.changeKnown ? (
            <div className={`text-2xl font-bold ${gainLossColor(summary.changePercent)}`}>
              {formatSignedPercent(summary.changePercent, 1)}
            </div>
          ) : (
            <div className="text-2xl font-bold text-gray-500 dark:text-gray-400">
              <UnknownAmount reason="displayFx" />
            </div>
          )}
        </div>
      </div>
      )}
      {!dataUnavailable && summary.anyPartial && (
        <PartialDataNotice
          missingCurrencies={missingCurrenciesFromPairs(summary.pairs)}
          excludedCount={Math.max(summary.pairs.length, 1)}
          displayCurrency={defaultCurrency}
        />
      )}

      {/* Controls -- always rendered so focus inside DateInput survives reloads */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['1y', '2y', '5y', '10y', 'all']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          {/* The row did not wrap, so the export sat past the right edge of a
              phone. It takes the full width below `sm`, which puts it on a
              line of its own under the view toggle and the recalculate
              button, and goes back beside them from `sm` up. */}
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <ChartViewToggle
              value={chartType}
              onChange={(v) => setChartType(v as 'line' | 'bar' | 'stacked' | 'table')}
              options={['bar', 'stacked', 'line', 'table']}
            />
            {chartType === 'bar' && (
              <div className={SEGMENTED_GROUP_CLASS} role="group" aria-label={t('netWorth.barStyle')}>
                {(['netWorth', 'accountType'] as const).map((style) => (
                  <button
                    key={style}
                    type="button"
                    aria-pressed={barStyle === style}
                    className={segmentClass(barStyle === style)}
                    onClick={() => setBarStyle(style)}
                  >
                    {style === 'netWorth' ? t('netWorth.barStyleNetWorth') : t('netWorth.barStyleAccountType')}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={handleRecalculate}
              disabled={isRecalculating}
              className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50"
            >
              {isRecalculating ? t('netWorth.recalculating') : t('netWorth.recalculate')}
            </button>
          </div>
          <ReportToolbarActions
            onExportPdf={handleExportPdf}
            onExportCsv={handleExportCsv}
            disabled={dataUnavailable || chartData.length === 0}
          />
        </div>
      </div>

      {/* Chart or Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {error ? (
          <ReportError onRetry={reload} />
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-96 w-full" />
          </div>
        ) : chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('netWorth.noData')}
          </p>
        ) : chartType === 'table' ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<NetWorthSortField>
                    field="name"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('netWorth.colMonth')}
                  </SortableHeader>
                  <SortableHeader<NetWorthSortField>
                    field="assets"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('netWorth.colAssets')}
                  </SortableHeader>
                  <SortableHeader<NetWorthSortField>
                    field="liabilities"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('netWorth.colLiabilities')}
                  </SortableHeader>
                  <SortableHeader<NetWorthSortField>
                    field="netWorth"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('netWorth.colNetWorth')}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedTableData.map((row) => (
                  <tr key={row.name} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {row.name}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                      <PartialTotal total={partialTotalFor(row.assetsValue, row.partial ? false : undefined, row.pairs)} displayCurrency={defaultCurrency}>
                        {formatCurrency(row.assetsValue)}
                      </PartialTotal>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-red-600 dark:text-red-400">
                      <PartialTotal total={partialTotalFor(row.liabilitiesValue, row.partial ? false : undefined, row.pairs)} displayCurrency={defaultCurrency}>
                        {formatCurrency(row.liabilitiesValue)}
                      </PartialTotal>
                    </td>
                    <td className={`px-4 py-3 text-right text-sm font-medium ${row.netWorthValue >= 0 ? 'text-gray-900 dark:text-gray-100' : 'text-red-600 dark:text-red-400'}`}>
                      <PartialTotal total={partialTotalFor(row.netWorthValue, row.partial ? false : undefined, row.pairs)} displayCurrency={defaultCurrency}>
                        {formatCurrency(row.netWorthValue)}
                      </PartialTotal>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div ref={chartRef} className="h-96">
            {chartType === 'bar' ? (
              // One solid bar of net worth a month, or stacked by account
              // type: what each type adds to (or, owed, takes from) net worth,
              // with net worth itself as the line.
              <NetWorthByAccountTypeChart
                data={accountTypeData}
                barStyle={barStyle}
                formatCurrency={formatCurrency}
                formatXTick={formatXAxisTick}
                xTicks={xAxisTicks}
                formatYTick={formatCurrencyAxis}
                valueLabels={showBarLabels ? (barLabelsVertical ? 'vertical' : 'horizontal') : undefined}
                formatValueLabel={formatCurrencyLabel}
                margin={{ top: showBarLabels ? (barLabelsVertical ? 52 : 22) : 10, right: 10, left: 0, bottom: 0 }}
              />
            ) : (
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              {chartType === 'line' ? (
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorNetWorth" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColors.primary} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartColors.primary} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis
                  dataKey="sortKey"
                  tick={{ fontSize: 12 }}
                  {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                  tickFormatter={formatXAxisTick}
                />
                <YAxis
                  domain={yAxisDomain}
                  tickFormatter={formatCurrencyAxis}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip content={<NetWorthTooltip formatCurrency={formatCurrency} />} />
                <Legend />
                <ReferenceLine y={0} stroke={chartColors.axis} strokeDasharray="3 3" />
                <Area
                  type="monotone"
                  // A withheld month is a gap, never a segment drawn through it.
                  connectNulls={false}
                  dataKey="NetWorth"
                  stroke={chartColors.primary}
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorNetWorth)"
                  name={t('netWorth.seriesNetWorth')}
                />
                {minMax && (
                  <ReferenceDot
                    x={minMax.max.sortKey}
                    y={minMax.max.NetWorth}
                    r={6}
                    fill={chartColors.income}
                    stroke={chartColors.surface}
                    strokeWidth={2}
                    label={{ value: formatCurrencyLabel(minMax.max.NetWorth), position: 'bottom', fontSize: 12, fill: chartColors.income, fontWeight: 600, offset: 8 }}
                  />
                )}
                {minMax && (
                  <ReferenceDot
                    x={minMax.min.sortKey}
                    y={minMax.min.NetWorth}
                    r={6}
                    fill={chartColors.expense}
                    stroke={chartColors.surface}
                    strokeWidth={2}
                    label={{ value: formatCurrencyLabel(minMax.min.NetWorth), position: 'top', fontSize: 12, fill: chartColors.expense, fontWeight: 600, offset: 8 }}
                  />
                )}
              </AreaChart>
              ) : (
              <BarChart data={chartData} stackOffset="expand" margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical={false} />
                <XAxis
                  dataKey="sortKey"
                  tick={{ fontSize: 12 }}
                  {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                  tickFormatter={formatXAxisTick}
                />
                <YAxis
                  domain={[0, 1]}
                  tickFormatter={formatPercentAxis}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip content={<CompositionTooltip formatCurrency={formatCurrency} formatPercent={formatPercent} t={t} />} />
                <Legend />
                <Bar dataKey="Assets" stackId="networth" fill={chartColors.income} name={t('netWorth.colAssets')} />
                <Bar dataKey="Liabilities" stackId="networth" fill={chartColors.expense} name={t('netWorth.colLiabilities')} radius={[4, 4, 0, 0]} />
              </BarChart>
              )}
            </ResponsiveContainer>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
