'use client';

import { useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
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
import { colourReportRows } from './custom-report-colours';
import { chartColors } from '@/lib/chart-colors';
import { exportToCsv } from '@/lib/csv-export';
import { getDecimalPlacesForCurrency } from '@/lib/format';
import type { ConvertedTotal } from '@/lib/currency-total';
import { usePartialTotalNote } from '@/hooks/usePartialTotalNote';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { CHART_BAR_RADIUS, CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { Th, Td } from '@/components/ui/Table';

/** A row a chart can draw: one whose converted value is known. */
type PlottedDataPoint = AggregatedDataPoint & { value: number; color: string };

// Default columns if none specified
const DEFAULT_TABLE_COLUMNS = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT];

/** The CSV-only column naming the currency of each account-currency amount. */
const ACCOUNT_CURRENCY_CSV_COLUMN = 'ACCOUNT_CURRENCY' as const;
/** The CSV-only column naming the currency of each original-currency amount. */
const ORIGINAL_CURRENCY_CSV_COLUMN = 'ORIGINAL_CURRENCY' as const;
type CsvColumn = TableColumn | typeof ACCOUNT_CURRENCY_CSV_COLUMN | typeof ORIGINAL_CURRENCY_CSV_COLUMN;

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
  /** Unit in which the server calculated this result. */
  currency?: string;
  /**
   * The server's headline for the Total row. Absent leaves the Total row's
   * figure blank: the sum of the rounded rows is not the total, and under an
   * average metric it is a sum of means.
   */
  totalRowValue?: number;
  /** A signed total counts the underlying postings once, even when tags overlap. */
  totalRowCount?: number;
  /** Set when the headline is a subtotal, so the Total row is marked as one. */
  partialTotal?: ConvertedTotal | null;
  /** The Total row's caption when "Total" alone would not say what it sums. */
  totalLabel?: string;
  /**
   * For a signed net measure, leave shares blank in every view and size pie
   * slices by magnitude. Labels and tooltips keep the signed amount.
   */
  signed?: boolean;
}

/** A row's share in percent, or `null` when none can be given for it. */
type ShareOf = (item: AggregatedDataPoint) => number | null;

function getColumnMap(
  header: (col: TableColumn) => string,
  shareOf: ShareOf,
  signed: boolean,
): Record<TableColumn, { header: string; getValue: (item: AggregatedDataPoint) => string | number }> {
  return {
    [TableColumn.DATE]: { header: header(TableColumn.DATE), getValue: (item) => item.date || '' },
    [TableColumn.LABEL]: { header: header(TableColumn.LABEL), getValue: (item) => item.label },
    [TableColumn.PAYEE]: { header: header(TableColumn.PAYEE), getValue: (item) => item.payee || '' },
    [TableColumn.DESCRIPTION]: { header: header(TableColumn.DESCRIPTION), getValue: (item) => item.description || '' },
    [TableColumn.MEMO]: { header: header(TableColumn.MEMO), getValue: (item) => item.memo || '' },
    [TableColumn.CATEGORY]: { header: header(TableColumn.CATEGORY), getValue: (item) => item.category || '' },
    [TableColumn.ACCOUNT]: { header: header(TableColumn.ACCOUNT), getValue: (item) => item.account || '' },
    // A listed row with no rate has no converted figure: a blank cell, never 0.
    [TableColumn.VALUE]: { header: header(TableColumn.VALUE), getValue: (item) => item.value ?? '' },
    [TableColumn.ACCOUNT_AMOUNT]: { header: header(TableColumn.ACCOUNT_AMOUNT), getValue: (item) => item.accountAmount ?? '' },
    [TableColumn.ORIGINAL_AMOUNT]: { header: header(TableColumn.ORIGINAL_AMOUNT), getValue: (item) => item.originalAmount ?? '' },
    [TableColumn.PERCENTAGE]: {
      header: header(TableColumn.PERCENTAGE),
      getValue: (item) => (signed ? null : shareOf(item)) ?? '',
    },
    [TableColumn.COUNT]: { header: header(TableColumn.COUNT), getValue: (item) => item.count ?? '' },
    [TableColumn.TAG]: { header: header(TableColumn.TAG), getValue: (item) => item.tags || '' },
  };
}

interface ReportChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: PlottedDataPoint }>;
  shareOf: ShareOf;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number, decimals?: number) => string;
  /** Leaves the share out: a signed row is no share of a net total. */
  signed?: boolean;
}

function ReportChartTooltip({ active, payload, shareOf, formatCurrency, formatPercent, signed }: ReportChartTooltipProps) {
  const t = useTranslations('reports');
  if (active && payload && payload.length) {
    const item = payload[0].payload;
    const percentage = signed ? null : shareOf(item);
    return (
      <div className={CHART_TOOLTIP_CLASS}>
        <p className="font-medium text-gray-900 dark:text-gray-100">{item.label}</p>
        <p className="text-gray-600 dark:text-gray-400">
          {formatCurrency(item.value)}
          {percentage !== null && <> ({formatPercent(percentage, 1)})</>}
        </p>
        {/* A transfer-measure group a rate was missing from is a part, said
            here as in the table (docs/specs/transfer-categories.md section 10). */}
        {item.incomplete && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t('customReportViewer.partialRow')}
          </p>
        )}
        {item.count != null && (
          <p className="text-sm text-gray-500 dark:text-gray-500">
            {t('customReportViewer.transactionCount', { count: item.count })}
          </p>
        )}
      </div>
    );
  }
  return null;
}

export function ReportChart({ viewType, data, groupBy, onDataPointClick, tableColumns, exportFilename, reportTitle, reportSubtitle, metric, currency, totalRowValue, totalRowCount, partialTotal, totalLabel: caption, signed = false }: ReportChartProps) {
  const t = useTranslations('reports');
  const totalLabel = caption ?? t('spendingByCategory.total');
  const { formatCurrency, formatNumber, formatPercent } = useNumberFormat();
  const { cellFor } = usePartialTotalNote();
  const { formatDate } = useDateFormat();
  const columns = tableColumns && tableColumns.length > 0 ? tableColumns : DEFAULT_TABLE_COLUMNS;
  const chartContainerRef = useRef<HTMLDivElement>(null);

  const chartData = useMemo(
    () => colourReportRows(data, signed && viewType === ReportViewType.PIE_CHART),
    [data, signed, viewType],
  );
  // A listed row with no rate stays in the table and the exports under its own
  // amount (issue #2342), but a chart has nothing to draw for it, and it is in
  // no total or share.
  const plottedData = useMemo(
    () =>
      chartData
        .filter((item): item is PlottedDataPoint => item.value !== null)
        .map((item) => ({ ...item, magnitude: Math.abs(item.value) })),
    [chartData],
  );

  // A row's share is the server's (`percentage`, divided from the unrounded
  // aggregates), a listed transaction's included. A row the server gave none
  // (an average or a budget variance, whose headline is not a sum of the rows)
  // has no share, never one divided here from rounded figures
  // (docs/specs/report-rounding-and-aggregation.md rule 8).
  const shareOf: ShareOf = (item) =>
    item.value === null ? null : (item.percentage ?? null);
  // The Total row's 100% only over rows that carry a share.
  const showsShares = !signed && chartData.some((item) => shareOf(item) !== null);
  const counts = chartData.flatMap(item => item.count == null ? [] : [item.count]);
  const totalCount = totalRowCount ?? (counts.length ? counts.reduce((sum, count) => sum + count, 0) : null);
  const formatValue = (value: number) =>
    metric === MetricType.COUNT ? formatNumber(value, 0) : formatCurrency(value, currency);
  // The Total row prints the headline the server settled for the metric (a mean
  // is not the sum of its groups' means), marked when it is a subtotal.
  const totalCell = () => {
    if (totalRowValue === undefined) return '';
    const text = formatValue(totalRowValue);
    return partialTotal ? cellFor(text, partialTotal) : text;
  };
  // An unconverted amount reads as its number and its code, exactly once on
  // every row, as the CSV writes it in two columns (issue #2342): a symbol
  // beside the code named it twice where the symbol is the code ("CHF 100.00
  // CHF"), and a row in the reader's own currency carried no code at all.
  const formatInItsCurrency = (amount: number, currencyCode: string) =>
    `${formatNumber(amount, getDecimalPlacesForCurrency(currencyCode))} ${currencyCode}`;
  // A row's own amount, unconverted: a column of these mixes currencies, so it
  // has no total.
  const formatAccountAmount = (item: AggregatedDataPoint) =>
    item.accountAmount === undefined || !item.accountCurrency
      ? ''
      : formatInItsCurrency(item.accountAmount, item.accountCurrency);
  const accountAmountHeader = t('customReportLabels.tableColumn.ACCOUNT_AMOUNT');
  // What a row entered in a foreign currency was entered as; blank on any other
  // row. It mixes currencies too, so it has no total either.
  const formatOriginalAmount = (item: AggregatedDataPoint) =>
    item.originalAmount === undefined || !item.originalCurrency
      ? ''
      : formatInItsCurrency(item.originalAmount, item.originalCurrency);
  const originalAmountHeader = t('customReportLabels.tableColumn.ORIGINAL_AMOUNT');

  const labelHeader = groupBy === GroupByType.NONE
    ? t('statement.item')
    : groupBy === GroupByType.CATEGORY || groupBy === GroupByType.PAYEE || groupBy === GroupByType.TAG
      ? t(`customReportLabels.groupBy.${groupBy}`)
      : t('monthlyComparison.pdfPeriod');
  const header = (col: TableColumn) => {
    if (col === TableColumn.LABEL) return labelHeader;
    if (col === TableColumn.VALUE) return t('statement.amount');
    if (col === TableColumn.PERCENTAGE) return t('portfolioValue.csvUnitPercent');
    return t(`customReportLabels.tableColumn.${col}`);
  };
  // A value an export prints as the table does: a withheld one as unknown with
  // its known part, a partial one with its mark, so neither leaves the report
  // reading as a whole figure.
  const incompleteValueText = (
    item: AggregatedDataPoint,
    format: (value: number) => string,
    blank: string,
  ): string => {
    const text =
      item.value === null
        ? item.knownValue !== undefined
          ? t('customReportViewer.unknownKnownPart', { amount: format(item.knownValue) })
          : blank
        : format(item.value);
    return item.incomplete ? `${text} ${t('customReportViewer.partialRow')}`.trim() : text;
  };
  const handleExportCsv = () => {
    const columnMap = getColumnMap(header, shareOf, signed);
    // An account- or original-currency amount is a raw number in a
    // spreadsheet, so its currency travels in a column of its own beside it.
    const csvColumns = columns.flatMap((col): CsvColumn[] => {
      if (col === TableColumn.ACCOUNT_AMOUNT) return [col, ACCOUNT_CURRENCY_CSV_COLUMN];
      if (col === TableColumn.ORIGINAL_AMOUNT) return [col, ORIGINAL_CURRENCY_CSV_COLUMN];
      return [col];
    });
    const headers = csvColumns.map((col) => {
      if (col === ACCOUNT_CURRENCY_CSV_COLUMN) return t('customReportLabels.accountCurrency');
      if (col === ORIGINAL_CURRENCY_CSV_COLUMN) return t('customReportLabels.originalCurrency');
      return columnMap[col]?.header || col;
    });
    const rows = chartData.map((item) =>
      csvColumns.map((col) => {
        if (col === ACCOUNT_CURRENCY_CSV_COLUMN) return item.accountCurrency ?? '';
        if (col === ORIGINAL_CURRENCY_CSV_COLUMN) return item.originalCurrency ?? '';
        if (col === TableColumn.VALUE && (item.incomplete || item.value === null)) {
          return incompleteValueText(item, (v) => String(v), '');
        }
        return columnMap[col]?.getValue(item) ?? '';
      }),
    );
    // CSV keeps the same headline, share and count as the table and PDF.
    const totalRow = csvColumns.map((col) => {
      if (col === TableColumn.LABEL || (col === TableColumn.DATE && !columns.includes(TableColumn.LABEL))) return totalLabel;
      if (col === TableColumn.VALUE) {
        if (totalRowValue === undefined) return '';
        return partialTotal ? cellFor(String(totalRowValue), partialTotal) : totalRowValue;
      }
      if (col === TableColumn.PERCENTAGE) return showsShares ? 100 : '';
      if (col === TableColumn.COUNT) return totalCount ?? '';
      return '';
    });
    exportToCsv(exportFilename || 'report', headers, [...rows, totalRow]);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const columnMap = getColumnMap(header, shareOf, signed);
    const headers = columns.map((col) => columnMap[col]?.header || col);
    // The PDF prints what the screen prints: formatted figures, never raw numbers.
    const pdfCell = (col: TableColumn, item: AggregatedDataPoint) => {
      if (col === TableColumn.ACCOUNT_AMOUNT) return formatAccountAmount(item);
      if (col === TableColumn.ORIGINAL_AMOUNT) return formatOriginalAmount(item);
      if (col === TableColumn.VALUE && (item.incomplete || item.value === null)) {
        return incompleteValueText(item, formatValue, '-');
      }
      const value = columnMap[col]?.getValue(item) ?? '';
      if (typeof value !== 'number') return value;
      if (col === TableColumn.VALUE) return formatValue(value);
      if (col === TableColumn.PERCENTAGE) return formatPercent(value, 1);
      if (col === TableColumn.COUNT) return formatNumber(value, 0);
      return value;
    };
    const rows = chartData.map((item) => columns.map((col) => pdfCell(col, item)));
    const totalRow = columns.map((col) => {
      if (col === TableColumn.LABEL || (col === TableColumn.DATE && !columns.includes(TableColumn.LABEL))) return totalLabel;
      if (col === TableColumn.VALUE) return totalCell();
      if (col === TableColumn.PERCENTAGE) return showsShares ? formatPercent(100, 1) : '';
      if (col === TableColumn.COUNT) return totalCount === null ? '' : formatNumber(totalCount, 0);
      return '';
    });
    await exportToPdf({
      title: reportTitle || exportFilename || t('page.tableReport'),
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
                  data={plottedData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey={signed ? 'magnitude' : 'value'}
                  cursor={onDataPointClick ? 'pointer' : 'default'}
                  onClick={(entry) => {
                    const { id } = entry as typeof entry & { id?: string };
                    if (id) onDataPointClick?.(id);
                  }}
                >
                  {plottedData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip content={<ReportChartTooltip shareOf={shareOf} formatCurrency={formatValue} formatPercent={formatPercent} signed={signed} />} />
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
              <BarChart data={plottedData} margin={{ top: 20, right: 10, left: 0, bottom: 60 }}>
                <CartesianGrid {...CHART_GRID_PROPS} />
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
                <Tooltip content={<ReportChartTooltip shareOf={shareOf} formatCurrency={formatValue} formatPercent={formatPercent} signed={signed} />} />
                <Bar radius={CHART_BAR_RADIUS}
                  dataKey="value"
                  cursor={onDataPointClick ? 'pointer' : 'default'}
                  onClick={(entry) => entry.id && onDataPointClick?.(entry.id)}
                >
                  {plottedData.map((entry, index) => (
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
              <LineChart data={plottedData} margin={{ top: 20, right: 10, left: 0, bottom: 60 }}>
                <CartesianGrid {...CHART_GRID_PROPS} />
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
                <Tooltip content={<ReportChartTooltip shareOf={shareOf} formatCurrency={formatValue} formatPercent={formatPercent} signed={signed} />} />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={chartColors.primary}
                  strokeWidth={2}
                  dot={{ fill: chartColors.primary, strokeWidth: 2 }}
                  activeDot={ChartActiveDot}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      );

    case ReportViewType.TABLE:
    default: {
      return (
        <div className="overflow-x-auto">
          {exportBar}
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead>
              <tr>
                {columns.includes(TableColumn.DATE) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.DATE)}
                  </th>
                )}
                {columns.includes(TableColumn.LABEL) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {labelHeader}
                  </th>
                )}
                {columns.includes(TableColumn.PAYEE) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.PAYEE)}
                  </th>
                )}
                {columns.includes(TableColumn.DESCRIPTION) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.DESCRIPTION)}
                  </th>
                )}
                {columns.includes(TableColumn.MEMO) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.MEMO)}
                  </th>
                )}
                {columns.includes(TableColumn.CATEGORY) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.CATEGORY)}
                  </th>
                )}
                {columns.includes(TableColumn.ACCOUNT) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.ACCOUNT)}
                  </th>
                )}
                {columns.includes(TableColumn.VALUE) && (
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.VALUE)}
                  </th>
                )}
                {columns.includes(TableColumn.ACCOUNT_AMOUNT) && <Th align="right">{accountAmountHeader}</Th>}
                {columns.includes(TableColumn.ORIGINAL_AMOUNT) && <Th align="right">{originalAmountHeader}</Th>}
                {columns.includes(TableColumn.PERCENTAGE) && (
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.PERCENTAGE)}
                  </th>
                )}
                {columns.includes(TableColumn.COUNT) && (
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.COUNT)}
                  </th>
                )}
                {columns.includes(TableColumn.TAG) && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {header(TableColumn.TAG)}
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
                      {item.value === null
                        ? item.knownValue !== undefined
                          ? t('customReportViewer.unknownKnownPart', { amount: formatValue(item.knownValue) })
                          : '-'
                        : formatValue(item.value)}
                      {item.incomplete && (
                        <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                          {t('customReportViewer.partialRow')}
                        </span>
                      )}
                    </td>
                  )}
                  {columns.includes(TableColumn.ACCOUNT_AMOUNT) && (
                    <Td align="right" className="whitespace-nowrap">
                      {formatAccountAmount(item) || '-'}
                    </Td>
                  )}
                  {columns.includes(TableColumn.ORIGINAL_AMOUNT) && (
                    <Td align="right" className="whitespace-nowrap">
                      {formatOriginalAmount(item) || '-'}
                    </Td>
                  )}
                  {columns.includes(TableColumn.PERCENTAGE) && (
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                      {(() => {
                        const share = signed ? null : shareOf(item);
                        return share === null ? '-' : formatPercent(share, 1);
                      })()}
                    </td>
                  )}
                  {columns.includes(TableColumn.COUNT) && (
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                      {item.count == null ? '-' : formatNumber(item.count, 0)}
                    </td>
                  )}
                  {columns.includes(TableColumn.TAG) && (
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {item.tags || '-'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-800">
                {columns.includes(TableColumn.DATE) && (
                  <td className="px-4 py-3 whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
                    {totalLabel}
                  </td>
                )}
                {columns.includes(TableColumn.LABEL) && !columns.includes(TableColumn.DATE) && (
                  <td className="px-4 py-3 whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
                    {totalLabel}
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
                {columns.includes(TableColumn.ACCOUNT_AMOUNT) && (
                  <td className="px-4 py-3"></td>
                )}
                {columns.includes(TableColumn.ORIGINAL_AMOUNT) && (
                  <td className="px-4 py-3"></td>
                )}
                {columns.includes(TableColumn.PERCENTAGE) && (
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                    {showsShares ? formatPercent(100, 1) : ''}
                  </td>
                )}
                {columns.includes(TableColumn.COUNT) && (
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                    {totalCount === null ? '-' : formatNumber(totalCount, 0)}
                  </td>
                )}
                {columns.includes(TableColumn.TAG) && (
                  <td className="px-4 py-3"></td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      );
    }
  }
}
