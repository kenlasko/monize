'use client';

import { useState, useMemo, useRef } from 'react';
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
  LabelList,
} from 'recharts';
import { format } from 'date-fns';
import { netWorthApi } from '@/lib/net-worth';
import { MonthlyNetWorth } from '@/types/net-worth';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { useDateRange } from '@/hooks/useDateRange';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { exportToCsv } from '@/lib/csv-export';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { createLogger } from '@/lib/logger';

const logger = createLogger('NetWorthReport');

type NetWorthSortField = 'name' | 'assets' | 'liabilities' | 'netWorth';

export function NetWorthReport() {
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatCurrencyLabel, formatSignedPercent } = useNumberFormat();
  const isMobile = useIsMobile();
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [chartType, setChartType] = useState<'line' | 'bar' | 'table'>('bar');
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
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd],
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

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: 'Net Worth Report',
      subtitle: `${chartData[0]?.name || ''} - ${chartData[chartData.length - 1]?.name || ''}`,
      summaryCards: [
        { label: 'Current Net Worth', value: formatCurrency(summary.current), color: summary.current >= 0 ? '#16a34a' : '#dc2626' },
        { label: 'Change', value: `${summary.change >= 0 ? '+' : ''}${formatCurrency(summary.change)}`, color: summary.change >= 0 ? '#16a34a' : '#dc2626' },
        { label: 'Change %', value: formatSignedPercent(summary.changePercent, 1), color: summary.changePercent >= 0 ? '#16a34a' : '#dc2626' },
      ],
      chartContainer: chartRef.current,
      filename: 'net-worth-report',
    });
  };

  const handleExportCsv = () => {
    const headers = ['Month', 'Assets', 'Liabilities', 'Net Worth'];
    const rows = sortedTableData.map((d) => [d.name, d.Assets, d.Liabilities, d.NetWorth]);
    exportToCsv('net-worth-report', headers, rows);
  };

  const chartData = useMemo(() =>
    monthlyData.map((d) => ({
      // `name` is the formatted display label; `sortKey` is the ISO month
      // (YYYY-MM) so the table can sort chronologically rather than
      // alphabetically by month-name ("Apr 2021" < "Aug 2020" lexically).
      name: format(parseLocalDate(d.month), 'MMM yyyy'),
      sortKey: d.month,
      Assets: Math.round(d.assets),
      Liabilities: Math.round(d.liabilities),
      NetWorth: Math.round(d.netWorth),
    })),
  [monthlyData]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return { current: 0, change: 0, changePercent: 0 };
    const current = chartData[chartData.length - 1]?.NetWorth || 0;
    const initial = chartData[0]?.NetWorth || 0;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return { current, change, changePercent };
  }, [chartData]);

  const sortedTableData = useMemo(() => {
    const sorted = [...chartData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.sortKey, b.sortKey);
          break;
        case 'assets':
          comparison = compareValues(a.Assets, b.Assets);
          break;
        case 'liabilities':
          comparison = compareValues(a.Liabilities, b.Liabilities);
          break;
        case 'netWorth':
          comparison = compareValues(a.NetWorth, b.NetWorth);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection]);

  // For long ranges, explicitly specify which ticks to show so years don't repeat
  const xAxisTicks = useMemo(() => {
    if (chartData.length <= 36) return undefined; // let Recharts auto-decide for shorter ranges
    // Only show ticks on January of each year
    return chartData
      .filter(d => d.name.startsWith('Jan '))
      .map(d => d.name);
  }, [chartData]);

  // Calculate Y-axis domain to avoid starting at 0 when values are significantly higher
  const yAxisDomain = useMemo(() => {
    if (chartData.length === 0) return [0, 'auto'] as [number, 'auto'];

    const values = chartData.map(d => d.NetWorth);
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

  const minMax = useMemo(() => {
    if (chartData.length < 2) return null;
    let minIdx = 0, maxIdx = 0;
    for (let i = 1; i < chartData.length; i++) {
      if (chartData[i].NetWorth < chartData[minIdx].NetWorth) minIdx = i;
      if (chartData[i].NetWorth > chartData[maxIdx].NetWorth) maxIdx = i;
    }
    if (minIdx === maxIdx) return null;
    return {
      min: chartData[minIdx],
      max: chartData[maxIdx],
    };
  }, [chartData]);

  // Per-bar value labels are only legible on the shorter (1y/2y) ranges; longer
  // ranges pack too many bars together. Beyond ~14 bars the labels are rotated
  // vertical so the 2-year view doesn't overlap. On mobile the bars are narrow
  // enough that even the 12-bar 1-year view needs vertical labels.
  const showBarLabels = dateRange === '1y' || dateRange === '2y';
  const barLabelsVertical = showBarLabels && (chartData.length > 14 || isMobile);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; payload: { name: string } }> }) => {
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
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Current Net Worth</div>
          <div className={`text-2xl font-bold ${
            gainLossColor(summary.current)
          }`}>
            {formatCurrency(summary.current)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Change</div>
          <div className={`text-2xl font-bold ${gainLossColor(summary.change)}`}>
            {summary.change >= 0 ? '+' : ''}{formatCurrency(summary.change)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Change %</div>
          <div className={`text-2xl font-bold ${gainLossColor(summary.changePercent)}`}>
            {formatSignedPercent(summary.changePercent, 1)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['1y', '2y', '5y', 'all']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <div className="flex items-center gap-3">
            <ChartViewToggle
              value={chartType}
              onChange={(v) => setChartType(v as 'line' | 'bar' | 'table')}
              options={['bar', 'line', 'table']}
            />
            <button
              onClick={handleRecalculate}
              disabled={isRecalculating}
              className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50"
            >
              {isRecalculating ? 'Recalculating...' : 'Recalculate'}
            </button>
            <ExportDropdown onExportPdf={handleExportPdf} onExportCsv={handleExportCsv} disabled={chartData.length === 0} />
          </div>
        </div>
      </div>

      {/* Chart or Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No data for this period.
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
                    Month
                  </SortableHeader>
                  <SortableHeader<NetWorthSortField>
                    field="assets"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Assets
                  </SortableHeader>
                  <SortableHeader<NetWorthSortField>
                    field="liabilities"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Liabilities
                  </SortableHeader>
                  <SortableHeader<NetWorthSortField>
                    field="netWorth"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Net Worth
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
                      {formatCurrency(row.Assets)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-red-600 dark:text-red-400">
                      {formatCurrency(row.Liabilities)}
                    </td>
                    <td className={`px-4 py-3 text-right text-sm font-medium ${row.NetWorth >= 0 ? 'text-gray-900 dark:text-gray-100' : 'text-red-600 dark:text-red-400'}`}>
                      {formatCurrency(row.NetWorth)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div ref={chartRef} className="h-96">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              {chartType === 'line' ? (
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorNetWorth" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
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
                <Legend />
                <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="3 3" />
                <Area
                  type="monotone"
                  dataKey="NetWorth"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorNetWorth)"
                  name="Net Worth"
                />
                {minMax && (
                  <ReferenceDot
                    x={minMax.max.name}
                    y={minMax.max.NetWorth}
                    r={6}
                    fill="#16a34a"
                    stroke="#fff"
                    strokeWidth={2}
                    label={{ value: formatCurrencyLabel(minMax.max.NetWorth), position: 'bottom', fontSize: 12, fill: '#16a34a', fontWeight: 600, offset: 8 }}
                  />
                )}
                {minMax && (
                  <ReferenceDot
                    x={minMax.min.name}
                    y={minMax.min.NetWorth}
                    r={6}
                    fill="#dc2626"
                    stroke="#fff"
                    strokeWidth={2}
                    label={{ value: formatCurrencyLabel(minMax.min.NetWorth), position: 'top', fontSize: 12, fill: '#dc2626', fontWeight: 600, offset: 8 }}
                  />
                )}
              </AreaChart>
              ) : (
              <BarChart data={chartData} margin={{ top: showBarLabels ? (barLabelsVertical ? 52 : 22) : 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
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
                <Legend />
                <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="3 3" />
                <Bar dataKey="NetWorth" fill="#3b82f6" name="Net Worth" radius={[4, 4, 0, 0]}>
                  {showBarLabels && (
                    <LabelList
                      dataKey="NetWorth"
                      position="top"
                      angle={barLabelsVertical ? -90 : 0}
                      offset={barLabelsVertical ? 6 : 5}
                      textAnchor={barLabelsVertical ? 'start' : 'middle'}
                      formatter={(value: unknown) => formatCurrencyLabel(Number(value))}
                      style={{
                        fill: '#6b7280',
                        fontSize: 11,
                        fontWeight: 600,
                        ...(barLabelsVertical && { dominantBaseline: 'central' as const }),
                      }}
                    />
                  )}
                </Bar>
              </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
