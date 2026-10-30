'use client';

import { useMemo, useRef } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  LineChart,
  Line,
} from 'recharts';
import { ReportViewType, AggregatedDataPoint, GroupByType, TableColumn, MetricType } from '@/types/custom-report';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { chartColors } from '@/lib/chart-colors';
import { exportToCsv } from '@/lib/csv-export';
import { sumMoney } from '@/lib/format';
import type { ConvertedTotal } from '@/lib/currency-total';
import { usePartialTotalNote } from '@/hooks/usePartialTotalNote';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { LinkifiedText } from '@/components/ui/LinkifiedText';

// Default columns if none specified
const DEFAULT_TABLE_COLUMNS = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT];

interface ReportChartProps {
  viewType: ReportViewType;
  data: AggregatedDataPoint[];
  groupBy: GroupByType;
  onDataPointClick?: (id: string) => void;
  tableColumns?: TableColumn[];
  exportFilename?: string;
  reportTitle?: string;
  reportSubtitle?: string;
  /** The report's metric: a count is a number, every other metric money. */
  metric?: MetricType;
  /** The server's headline for the Total row; absent = the sum of the rows. */
  totalRowValue?: number;
  /** Set when the headline is a subtotal, so the Total row is marked as one. */
  partialTotal?: ConvertedTotal | null;
}

function getColumnMap(
  labelHeader: string,
  total: number,
): Record<TableColumn, { header: string; getValue: (item: AggregatedDataPoint) => string | number }> {
  return {
    [TableColumn.DATE]: { header: 'Date', getValue: (item) => item.date || '' },
    [TableColumn.LABEL]: { header: labelHeader, getValue: (item) => item.label },
    [TableColumn.PAYEE]: { header: 'Payee', getValue: (item) => item.payee || '' },
    [TableColumn.DESCRIPTION]: { header: 'Description', getValue: (item) => item.description || '' },
    [TableColumn.MEMO]: { header: 'Memo', getValue: (item) => item.memo || '' },
    [TableColumn.CATEGORY]: { header: 'Category', getValue: (item) => item.category || '' },
    [TableColumn.ACCOUNT]: { header: 'Account', getValue: (item) => item.account || '' },
    [TableColumn.VALUE]: { header: 'Amount', getValue: (item) => item.value },
    [TableColumn.PERCENTAGE]: { header: '%', getValue: (item) => item.percentage ?? (total > 0 ? Number(((item.value / total) * 100).toFixed(1)) : 0) },
    [TableColumn.COUNT]: { header: 'Count', getValue: (item) => item.count || 0 },
    [TableColumn.TAG]: { header: 'Tag', getValue: (item) => item.label || '' },
  };
}

interface ReportChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: AggregatedDataPoint & { color: string } }>;
  total: number;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number, decimals?: number) => string;
}

function ReportChartTooltip({ active, payload, total, formatCurrency, formatPercent }: ReportChartTooltipProps) {
  if (active && payload && payload.length) {
    const item = payload[0].payload;
    const percentage = total > 0 ? (item.value / total) * 100 : 0;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">{item.label}</p>
        <p className="text-gray-600 dark:text-gray-400">
          {formatCurrency(item.value)} ({formatPercent(percentage, 1)})
        </p>
        {item.count !== undefined && (
          <p className="text-sm text-gray-500 dark:text-gray-500">
            {item.count} transaction{item.count !== 1 ? 's' : ''}
          </p>
        )}
      </div>
    );
  }
  return null;
}

export function ReportChart({ viewType, data, groupBy, onDataPointClick, tableColumns, exportFilename, reportTitle, reportSubtitle, metric, totalRowValue, partialTotal }: ReportChartProps) {
  const { formatCurrency, formatNumber, formatPercent } = useNumberFormat();
  const { cellFor } = usePartialTotalNote();
  const { formatDate } = useDateFormat();
  const columns = tableColumns && tableColumns.length > 0 ? tableColumns : DEFAULT_TABLE_COLUMNS;
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // Assign colours to data points without one
  const chartData = useMemo(() => {
    let colourIndex = 0;
    return data.map((item) => ({
      ...item,
      color: item.color || CHART_COLOURS[colourIndex++ % CHART_COLOURS.length],
    }));
  }, [data]);

  const total = sumMoney(chartData.map((item) => item.value));
  const formatValue = (value: number) =>
    metric === MetricType.COUNT ? formatNumber(value, 0) : formatCurrency(value);
  // The Total row prints the headline the server settled for the metric (a mean
  // is not the sum of its groups' means), marked when it is a subtotal.
  const totalCell = () => {
    const text = formatValue(totalRowValue ?? total);
    return partialTotal ? cellFor(text, partialTotal) : text;
  };

  const labelHeader = groupBy === GroupByType.CATEGORY ? 'Category' :
                      groupBy === GroupByType.PAYEE ? 'Payee' :
                      groupBy === GroupByType.NONE ? 'Item' : 'Period';

  const handleExportCsv = () => {
    const columnMap = getColumnMap(labelHeader, total);
    const headers = columns.map((col) => columnMap[col]?.header || col);
    const rows = chartData.map((item) =>
      columns.map((col) => columnMap[col]?.getValue(item) ?? '')
    );
    // The same Total row as the PDF: the metric-aware headline (raw number, marked
    // when it is a subtotal), 100% and the summed count.
    const totalCount = chartData.reduce((sum, item) => sum + (item.count || 0), 0);
    const totalRow = columns.map((col) => {
      if (col === TableColumn.LABEL || (col === TableColumn.DATE && !columns.includes(TableColumn.LABEL))) return 'Total';
      if (col === TableColumn.VALUE) {
        const value = totalRowValue ?? total;
        return partialTotal ? cellFor(String(value), partialTotal) : value;
      }
      if (col === TableColumn.PERCENTAGE) return 100;
      if (col === TableColumn.COUNT) return totalCount || '';
      return '';
    });
    exportToCsv(exportFilename || 'report', headers, [...rows, totalRow]);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const columnMap = getColumnMap(labelHeader, total);
    const headers = columns.map((col) => columnMap[col]?.header || col);
    // The PDF prints what the screen prints: formatted figures, never raw numbers.
    const pdfCell = (col: TableColumn, item: AggregatedDataPoint) => {
      const value = columnMap[col]?.getValue(item) ?? '';
      if (typeof value !== 'number') return value;
      if (col === TableColumn.VALUE) return formatValue(value);
      if (col === TableColumn.PERCENTAGE) return formatPercent(value, 1);
      if (col === TableColumn.COUNT) return formatNumber(value, 0);
      return value;
    };
    const rows = chartData.map((item) => columns.map((col) => pdfCell(col, item)));
    const totalCount = chartData.reduce((sum, item) => sum + (item.count || 0), 0);
    const totalRow = columns.map((col) => {
      if (col === TableColumn.LABEL || (col === TableColumn.DATE && !columns.includes(TableColumn.LABEL))) return 'Total';
      if (col === TableColumn.VALUE) return totalCell();
      if (col === TableColumn.PERCENTAGE) return formatPercent(100, 1);
      if (col === TableColumn.COUNT) return totalCount ? formatNumber(totalCount, 0) : '';
      return '';
    });
    await exportToPdf({
      title: reportTitle || exportFilename || 'Report',
      subtitle: reportSubtitle,
      chartContainer: viewType !== ReportViewType.TABLE ? chartContainerRef.current : null,
      tableData: { headers, rows, totalRow },
      filename: exportFilename || 'report',
    });
  };

  const isTimeBased = groupBy === GroupByType.MONTH || groupBy === GroupByType.WEEK || groupBy === GroupByType.DAY;

  const exportBar = (
    <div className="flex px-4 py-2">
      <ReportToolbarActions onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
    </div>
  );

  switch (viewType) {
    case ReportViewType.PIE_CHART:
      return (
        <div>
          {exportBar}
          <div ref={chartContainerRef} className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey="value"
                  cursor={onDataPointClick ? 'pointer' : 'default'}
                  onClick={(entry) => {
                    const { id } = entry as typeof entry & { id?: string };
                    if (id) onDataPointClick?.(id);
                  }}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip content={<ReportChartTooltip total={total} formatCurrency={formatValue} formatPercent={formatPercent} />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      );

    case ReportViewType.BAR_CHART:
      return (
        <div>
          {exportBar}
          <div ref={chartContainerRef} className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={chartData} margin={{ top: 20, right: 10, left: 0, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 12, fill: 'currentColor' }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                  interval={0}
                  className="text-gray-600 dark:text-gray-400"
                />
                <YAxis
                  tick={{ fontSize: 12, fill: 'currentColor' }}
                  tickFormatter={(value) => formatNumber(value, 0)}
                  className="text-gray-600 dark:text-gray-400"
                />
                <Tooltip content={<ReportChartTooltip total={total} formatCurrency={formatValue} formatPercent={formatPercent} />} />
                <Bar
                  dataKey="value"
                  cursor={onDataPointClick ? 'pointer' : 'default'}
                  onClick={(entry) => entry.id && onDataPointClick?.(entry.id)}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      );

    case ReportViewType.LINE_CHART:
      return (
        <div>
          {exportBar}
          <div ref={chartContainerRef} className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={chartData} margin={{ top: 20, right: 10, left: 0, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 12, fill: 'currentColor' }}
                  angle={isTimeBased ? -45 : 0}
                  textAnchor={isTimeBased ? 'end' : 'middle'}
                  height={60}
                  interval={isTimeBased ? 'preserveStartEnd' : 0}
                  className="text-gray-600 dark:text-gray-400"
                />
                <YAxis
                  tick={{ fontSize: 12, fill: 'currentColor' }}
                  tickFormatter={(value) => formatNumber(value, 0)}
                  className="text-gray-600 dark:text-gray-400"
                />
                <Tooltip content={<ReportChartTooltip total={total} formatCurrency={formatValue} formatPercent={formatPercent} />} />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={chartColors.primary}
                  strokeWidth={2}
                  dot={{ fill: chartColors.primary, strokeWidth: 2 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      );

    case ReportViewType.TABLE:
    default: {
      const totalCount = chartData.reduce((sum, item) => sum + (item.count || 0), 0);

      return (
        <div className="overflow-x-auto">
          {exportBar}
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead>
              <tr>
                {columns.includes(TableColumn.DATE) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Date
                  </th>
                )}
                {columns.includes(TableColumn.LABEL) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {labelHeader}
                  </th>
                )}
                {columns.includes(TableColumn.PAYEE) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Payee
                  </th>
                )}
                {columns.includes(TableColumn.DESCRIPTION) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Description
                  </th>
                )}
                {columns.includes(TableColumn.MEMO) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Memo
                  </th>
                )}
                {columns.includes(TableColumn.CATEGORY) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Category
                  </th>
                )}
                {columns.includes(TableColumn.ACCOUNT) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Account
                  </th>
                )}
                {columns.includes(TableColumn.VALUE) && (
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Amount
                  </th>
                )}
                {columns.includes(TableColumn.PERCENTAGE) && (
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    %
                  </th>
                )}
                {columns.includes(TableColumn.COUNT) && (
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Count
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {chartData.map((item, index) => (
                <tr
                  key={index}
                  className={onDataPointClick && item.id ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700' : ''}
                  onClick={() => item.id && onDataPointClick?.(item.id)}
                >
                  {columns.includes(TableColumn.DATE) && (
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {item.date ? formatDate(item.date) : '-'}
                    </td>
                  )}
                  {columns.includes(TableColumn.LABEL) && (
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="text-sm text-gray-900 dark:text-gray-100">
                          {item.label}
                        </span>
                      </div>
                    </td>
                  )}
                  {columns.includes(TableColumn.PAYEE) && (
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {item.payee || '-'}
                    </td>
                  )}
                  {columns.includes(TableColumn.DESCRIPTION) && (
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100 max-w-xs truncate">
                      {item.description ? (
                        <LinkifiedText text={item.description} />
                      ) : (
                        '-'
                      )}
                    </td>
                  )}
                  {columns.includes(TableColumn.MEMO) && (
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
                      {item.memo ? <LinkifiedText text={item.memo} /> : '-'}
                    </td>
                  )}
                  {columns.includes(TableColumn.CATEGORY) && (
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {item.category || '-'}
                    </td>
                  )}
                  {columns.includes(TableColumn.ACCOUNT) && (
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {item.account || '-'}
                    </td>
                  )}
                  {columns.includes(TableColumn.VALUE) && (
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
                      {formatValue(item.value)}
                    </td>
                  )}
                  {columns.includes(TableColumn.PERCENTAGE) && (
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                      {formatPercent(
                        item.percentage ??
                          (total > 0 ? (item.value / total) * 100 : 0),
                        1,
                      )}
                    </td>
                  )}
                  {columns.includes(TableColumn.COUNT) && (
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                      {item.count || '-'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-800">
                {columns.includes(TableColumn.DATE) && (
                  <td className="px-4 py-3 whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
                    Total
                  </td>
                )}
                {columns.includes(TableColumn.LABEL) && !columns.includes(TableColumn.DATE) && (
                  <td className="px-4 py-3 whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
                    Total
                  </td>
                )}
                {columns.includes(TableColumn.LABEL) && columns.includes(TableColumn.DATE) && (
                  <td className="px-4 py-3"></td>
                )}
                {columns.includes(TableColumn.PAYEE) && (
                  <td className="px-4 py-3"></td>
                )}
                {columns.includes(TableColumn.DESCRIPTION) && (
                  <td className="px-4 py-3"></td>
                )}
                {columns.includes(TableColumn.MEMO) && (
                  <td className="px-4 py-3"></td>
                )}
                {columns.includes(TableColumn.CATEGORY) && (
                  <td className="px-4 py-3"></td>
                )}
                {columns.includes(TableColumn.ACCOUNT) && (
                  <td className="px-4 py-3"></td>
                )}
                {columns.includes(TableColumn.VALUE) && (
                  <td className="px-4 py-3 whitespace-nowrap text-right font-medium text-gray-900 dark:text-gray-100">
                    {totalCell()}
                  </td>
                )}
                {columns.includes(TableColumn.PERCENTAGE) && (
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                    100%
                  </td>
                )}
                {columns.includes(TableColumn.COUNT) && (
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                    {totalCount || '-'}
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      );
    }
  }
}
