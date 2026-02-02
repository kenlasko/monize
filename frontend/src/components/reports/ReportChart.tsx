'use client';

import { useMemo } from 'react';
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
import { ReportViewType, AggregatedDataPoint, GroupByType, TableColumn } from '@/types/custom-report';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';

// Default colours for data without a colour
const DEFAULT_COLOURS = [
  '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
  '#84cc16', '#f43f5e', '#a855f7', '#10b981', '#f59e0b',
  '#64748b', '#78716c', '#71717a', '#737373', '#6b7280',
];

// Default columns if none specified
const DEFAULT_TABLE_COLUMNS = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT];

interface ReportChartProps {
  viewType: ReportViewType;
  data: AggregatedDataPoint[];
  groupBy: GroupByType;
  onDataPointClick?: (id: string) => void;
  tableColumns?: TableColumn[];
}

export function ReportChart({ viewType, data, groupBy, onDataPointClick, tableColumns }: ReportChartProps) {
  const { formatCurrency, formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const columns = tableColumns && tableColumns.length > 0 ? tableColumns : DEFAULT_TABLE_COLUMNS;

  // Assign colours to data points without one
  const chartData = useMemo(() => {
    let colourIndex = 0;
    return data.map((item) => ({
      ...item,
      color: item.color || DEFAULT_COLOURS[colourIndex++ % DEFAULT_COLOURS.length],
    }));
  }, [data]);

  const total = chartData.reduce((sum, item) => sum + item.value, 0);

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{ payload: AggregatedDataPoint & { color: string } }>;
  }) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload;
      const percentage = total > 0 ? ((item.value / total) * 100).toFixed(1) : '0';
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{item.label}</p>
          <p className="text-gray-600 dark:text-gray-400">
            {formatCurrency(item.value)} ({percentage}%)
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
  };

  const isTimeBased = groupBy === GroupByType.MONTH || groupBy === GroupByType.WEEK || groupBy === GroupByType.DAY;

  switch (viewType) {
    case ReportViewType.PIE_CHART:
      return (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
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
                onClick={(entry) => entry.id && onDataPointClick?.(entry.id)}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      );

    case ReportViewType.BAR_CHART:
      return (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
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
              <Tooltip content={<CustomTooltip />} />
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
      );

    case ReportViewType.LINE_CHART:
      return (
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
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
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ fill: '#3b82f6', strokeWidth: 2 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      );

    case ReportViewType.TABLE:
    default: {
      const labelHeader = groupBy === GroupByType.CATEGORY ? 'Category' :
                          groupBy === GroupByType.PAYEE ? 'Payee' :
                          groupBy === GroupByType.NONE ? 'Item' : 'Period';
      const totalCount = chartData.reduce((sum, item) => sum + (item.count || 0), 0);

      return (
        <div className="overflow-x-auto">
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
                      {item.description || '-'}
                    </td>
                  )}
                  {columns.includes(TableColumn.MEMO) && (
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
                      {item.memo || '-'}
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
                      {formatCurrency(item.value)}
                    </td>
                  )}
                  {columns.includes(TableColumn.PERCENTAGE) && (
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                      {item.percentage?.toFixed(1) || (total > 0 ? ((item.value / total) * 100).toFixed(1) : '0')}%
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
                    {formatCurrency(total)}
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
