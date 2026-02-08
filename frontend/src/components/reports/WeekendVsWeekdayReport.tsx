'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
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
import { WeekendVsWeekdayResponse } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { createLogger } from '@/lib/logger';

const logger = createLogger('WeekendVsWeekdayReport');

interface DaySpendingDisplay {
  day: string;
  dayIndex: number;
  total: number;
  count: number;
  average: number;
  isWeekend: boolean;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function WeekendVsWeekdayReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const [reportData, setReportData] = useState<WeekendVsWeekdayResponse | null>(null);
  const { dateRange, setDateRange, resolvedRange } = useDateRange({ defaultRange: '3m', alignment: 'day' });
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'comparison' | 'byDay' | 'categories'>('comparison');

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = resolvedRange;
        const data = await builtInReportsApi.getWeekendVsWeekday({
          startDate: start,
          endDate: end,
        });
        setReportData(data);
      } catch (error) {
        logger.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [resolvedRange]);

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
  }, [reportData]);

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
    { name: 'Weekend', value: weekendTotal, color: '#8b5cf6' },
    { name: 'Weekday', value: weekdayTotal, color: '#3b82f6' },
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

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-96 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  const hasData = totalSpending > 0;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <div className="text-sm text-purple-600 dark:text-purple-400">Weekend Spending</div>
          <div className="text-xl font-bold text-purple-700 dark:text-purple-300">
            {formatCurrency(weekendTotal)}
          </div>
          <div className="text-xs text-purple-500 dark:text-purple-400">
            {weekendCount} transactions
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">Weekday Spending</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {formatCurrency(weekdayTotal)}
          </div>
          <div className="text-xs text-blue-500 dark:text-blue-400">
            {weekdayCount} transactions
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Avg Weekend Transaction</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(weekendAvg)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Avg Weekday Transaction</div>
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
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('comparison')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'comparison'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setViewType('byDay')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'byDay'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Day
            </button>
            <button
              onClick={() => setViewType('categories')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'categories'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Category
            </button>
          </div>
        </div>
      </div>

      {!hasData ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No expense transactions found for this period.
          </p>
        </div>
      ) : viewType === 'comparison' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Weekend vs Weekday Split
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%">
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
                  <div className="text-sm text-gray-600 dark:text-gray-400">Weekend (Sat-Sun)</div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(weekendTotal)} ({weekendPercent.toFixed(1)}%)
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="w-4 h-4 rounded bg-blue-500" />
                <div className="flex-1">
                  <div className="text-sm text-gray-600 dark:text-gray-400">Weekday (Mon-Fri)</div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(weekdayTotal)} ({(100 - weekendPercent).toFixed(1)}%)
                  </div>
                </div>
              </div>
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                {weekendAvg > weekdayAvg ? (
                  <p className="text-sm text-purple-600 dark:text-purple-400">
                    You spend {formatCurrency(weekendAvg - weekdayAvg)} more per transaction on weekends
                  </p>
                ) : (
                  <p className="text-sm text-blue-600 dark:text-blue-400">
                    You spend {formatCurrency(weekdayAvg - weekendAvg)} more per transaction on weekdays
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : viewType === 'byDay' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Spending by Day of Week
          </h3>
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dayData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" />
                <YAxis tickFormatter={formatCurrencyAxis} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total" name="Total Spent">
                  {dayData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.isWeekend ? '#8b5cf6' : '#3b82f6'}
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
                <div className="text-xs text-gray-500 dark:text-gray-400">txns</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Category Comparison
          </h3>
          <div className="h-[480px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryComparison} layout="vertical" margin={{ left: 100 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" tickFormatter={formatCurrencyAxis} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={100} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <Bar dataKey="weekendTotal" fill="#8b5cf6" name="Weekend" />
                <Bar dataKey="weekdayTotal" fill="#3b82f6" name="Weekday" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
