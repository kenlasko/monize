'use client';

import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { chartColors, CHART_SERIES } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';

// Weekend purple vs weekday blue, drawn from the categorical theme palette.
const WEEKEND_COLOR = CHART_SERIES[4];
const WEEKDAY_COLOR = CHART_SERIES[0];

interface DaySpendingDisplay {
  day: string;
  dayIndex: number;
  total: number;
  count: number;
  average: number;
  isWeekend: boolean;
}

export function WeekendVsWeekdayReport() {
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const DAY_NAMES = tc.raw('weekdaysShort') as string[];
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const { dateRange, setDateRange, resolvedRange } = useDateRange({ defaultRange: '3m', alignment: 'day' });
  const [viewType, setViewType] = useState<'comparison' | 'byDay' | 'categories'>('comparison');

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: reportData, isLoading, error, reload } = useReportData(
    () =>
      builtInReportsApi.getWeekendVsWeekday({
        startDate: rangeStart,
        endDate: rangeEnd,
      }),
    [rangeStart, rangeEnd],
  );

  const { weekendTotal, weekdayTotal, weekendCount, weekdayCount, dayData } = useMemo(() => {
    if (!reportData) {
      return {
        weekendTotal: 0,
        weekdayTotal: 0,
        weekendCount: 0,
        weekdayCount: 0,
        dayData: [] as DaySpendingDisplay[],
      };
    }

    const { summary, byDay } = reportData;

    const dayData: DaySpendingDisplay[] = DAY_NAMES.map((dayName, index) => {
      const dayInfo = byDay.find((d) => d.dayOfWeek === index);
      const total = dayInfo?.total || 0;
      const count = dayInfo?.count || 0;
      return {
        day: dayName,
        dayIndex: index,
        total,
        count,
        average: count > 0 ? total / count : 0,
        isWeekend: index === 0 || index === 6,
      };
    });

    return {
      weekendTotal: summary.weekendTotal,
      weekdayTotal: summary.weekdayTotal,
      weekendCount: summary.weekendCount,
      weekdayCount: summary.weekdayCount,
      dayData,
    };
  }, [reportData, DAY_NAMES]);

  const categoryComparison = useMemo(() => {
    if (!reportData) {
      return [];
    }

    return reportData.byCategory
      .map((cat) => ({
        categoryId: cat.categoryId,
        name: cat.categoryName,
        weekendTotal: cat.weekendTotal,
        weekdayTotal: cat.weekdayTotal,
        difference: cat.weekendTotal - cat.weekdayTotal,
      }))
      .sort((a, b) => (b.weekendTotal + b.weekdayTotal) - (a.weekendTotal + a.weekdayTotal))
      .slice(0, 10);
  }, [reportData]);

  const weekendAvg = weekendCount > 0 ? weekendTotal / weekendCount : 0;
  const weekdayAvg = weekdayCount > 0 ? weekdayTotal / weekdayCount : 0;
  const totalSpending = weekendTotal + weekdayTotal;
  const weekendPercent = totalSpending > 0 ? (weekendTotal / totalSpending) * 100 : 0;

  const pieData = [
    { name: t('weekendVsWeekday.weekendLabel'), value: weekendTotal, color: WEEKEND_COLOR },
    { name: t('weekendVsWeekday.weekdayLabel'), value: weekdayTotal, color: WEEKDAY_COLOR },
  ];

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
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

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const weekdayPercent = totalSpending > 0 ? (weekdayTotal / totalSpending) * 100 : 0;
    await exportToPdf({
      title: t('weekendVsWeekday.pdfTitle'),
      summaryCards: [
        { label: t('weekendVsWeekday.pdfWeekendSpending'), value: formatCurrency(weekendTotal), color: '#7c3aed' },
        { label: t('weekendVsWeekday.pdfWeekdaySpending'), value: formatCurrency(weekdayTotal), color: '#2563eb' },
        { label: t('weekendVsWeekday.pdfAvgWeekend'), value: formatCurrency(weekendAvg), color: '#111827' },
        { label: t('weekendVsWeekday.pdfAvgWeekday'), value: formatCurrency(weekdayAvg), color: '#111827' },
      ],
      chartContainer: chartRef.current,
      chartLegend: [
        { color: resolvePdfColor(WEEKEND_COLOR), label: `${t('weekendVsWeekday.weekendLabel')} - ${formatCurrency(weekendTotal)} (${weekendPercent.toFixed(1)}%)` },
        { color: resolvePdfColor(WEEKDAY_COLOR), label: `${t('weekendVsWeekday.weekdayLabel')} - ${formatCurrency(weekdayTotal)} (${weekdayPercent.toFixed(1)}%)` },
      ],
      filename: 'weekend-vs-weekday',
    });
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

  const hasData = totalSpending > 0;

  return (
    <div ref={chartRef} className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <div className="text-sm text-purple-600 dark:text-purple-400">{t('weekendVsWeekday.weekendSpending')}</div>
          <div className="text-xl font-bold text-purple-700 dark:text-purple-300">
            {formatCurrency(weekendTotal)}
          </div>
          <div className="text-xs text-purple-500 dark:text-purple-400">
            {t('weekendVsWeekday.weekendTransactions', { count: weekendCount })}
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">{t('weekendVsWeekday.weekdaySpending')}</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {formatCurrency(weekdayTotal)}
          </div>
          <div className="text-xs text-blue-500 dark:text-blue-400">
            {t('weekendVsWeekday.weekdayTransactions', { count: weekdayCount })}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('weekendVsWeekday.avgWeekendTransaction')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(weekendAvg)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('weekendVsWeekday.avgWeekdayTransaction')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(weekdayAvg)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['1m', '3m', '6m', '1y']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="flex gap-2 items-center">
            <button
              onClick={() => setViewType('comparison')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'comparison'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('weekendVsWeekday.viewOverview')}
            </button>
            <button
              onClick={() => setViewType('byDay')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'byDay'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('weekendVsWeekday.viewByDay')}
            </button>
            <button
              onClick={() => setViewType('categories')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'categories'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('weekendVsWeekday.viewByCategory')}
            </button>
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {!hasData ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('weekendVsWeekday.noData')}
          </p>
        </div>
      ) : viewType === 'comparison' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('weekendVsWeekday.weekendVsWeekdaySplit')}
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={140}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatCurrency(Number(value) || 0)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-col justify-center space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-4 h-4 rounded bg-purple-500" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">{t('weekendVsWeekday.weekendLabel')}</div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(weekendTotal)} ({weekendPercent.toFixed(1)}%)
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-4 h-4 rounded bg-blue-500" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">{t('weekendVsWeekday.weekdayLabel')}</div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(weekdayTotal)} ({(100 - weekendPercent).toFixed(1)}%)
                  </div>
                </div>
              </div>
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                {weekendAvg > weekdayAvg ? (
                  <p className="text-sm text-purple-600 dark:text-purple-400">
                    {t('weekendVsWeekday.spendMoreWeekend', { amount: formatCurrency(weekendAvg - weekdayAvg) })}
                  </p>
                ) : (
                  <p className="text-sm text-blue-600 dark:text-blue-400">
                    {t('weekendVsWeekday.spendMoreWeekday', { amount: formatCurrency(weekdayAvg - weekendAvg) })}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : viewType === 'byDay' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('weekendVsWeekday.spendingByDayOfWeek')}
          </h3>
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={dayData}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis dataKey="day" />
                <YAxis tickFormatter={formatCurrencyAxis} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total" name={t('weekendVsWeekday.barTotalSpent')}>
                  {dayData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.isWeekend ? WEEKEND_COLOR : WEEKDAY_COLOR}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 grid grid-cols-7 gap-2">
            {dayData.map((day) => (
              <div
                key={day.day}
                className={`text-center p-2 rounded ${
                  day.isWeekend
                    ? 'bg-purple-50 dark:bg-purple-900/20'
                    : 'bg-blue-50 dark:bg-blue-900/20'
                }`}
              >
                <div className="text-xs text-gray-500 dark:text-gray-400">{day.day}</div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {day.count}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{t('weekendVsWeekday.txnsLabel')}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('weekendVsWeekday.categoryComparison')}
          </h3>
          <div className="h-[480px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={categoryComparison} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis type="number" tickFormatter={formatCurrencyAxis} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={80} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <Bar dataKey="weekendTotal" fill={WEEKEND_COLOR} name={t('weekendVsWeekday.barWeekend')} />
                <Bar dataKey="weekdayTotal" fill={WEEKDAY_COLOR} name={t('weekendVsWeekday.barWeekday')} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
