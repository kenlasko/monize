'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { MonthlyIncomeExpenseItem, CategorySpendingItem, IncomeSourceItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { createLogger } from '@/lib/logger';

const logger = createLogger('CashFlowReport');

interface ChartDataItem {
  name: string;
  fullName: string;
  Income: number;
  Expenses: number;
  Net: number;
}

export function CashFlowReport() {
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const [monthlyData, setMonthlyData] = useState<ChartDataItem[]>([]);
  const [incomeItems, setIncomeItems] = useState<IncomeSourceItem[]>([]);
  const [expenseItems, setExpenseItems] = useState<CategorySpendingItem[]>([]);
  const [totals, setTotals] = useState({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const { dateRange, setDateRange, startDate, setStartDate, endDate, setEndDate, resolvedRange, isValid } = useDateRange({ defaultRange: '6m', alignment: 'month' });

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end } = resolvedRange;
      const params = {
        startDate: start || undefined,
        endDate: end,
      };

      // Fetch all data in parallel
      const [cashFlowResponse, incomeResponse, spendingResponse] = await Promise.all([
        builtInReportsApi.getCashFlow(params),
        builtInReportsApi.getIncomeBySource(params),
        builtInReportsApi.getSpendingByCategory(params),
      ]);

      // Map monthly data
      const data: ChartDataItem[] = cashFlowResponse.data.map((item: MonthlyIncomeExpenseItem) => {
        const monthDate = parseISO(item.month + '-01');
        return {
          name: format(monthDate, 'MMM'),
          fullName: format(monthDate, 'MMM yyyy'),
          Income: Math.round(item.income),
          Expenses: Math.round(item.expenses),
          Net: Math.round(item.net),
        };
      });

      setMonthlyData(data);
      setIncomeItems(incomeResponse.data);
      setExpenseItems(spendingResponse.data);
      setTotals({
        totalIncome: cashFlowResponse.totals.income,
        totalExpenses: cashFlowResponse.totals.expenses,
        netCashFlow: cashFlowResponse.totals.net,
      });
    } catch (error) {
      logger.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [resolvedRange]);

  useEffect(() => {
    if (isValid) loadData();
  }, [isValid, loadData]);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; payload: { fullName: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.fullName}</p>
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
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-6">
          <div className="text-sm text-green-600 dark:text-green-400">Total Inflows</div>
          <div className="text-2xl font-bold text-green-700 dark:text-green-300">
            {formatCurrency(totals.totalIncome)}
          </div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-6">
          <div className="text-sm text-red-600 dark:text-red-400">Total Outflows</div>
          <div className="text-2xl font-bold text-red-700 dark:text-red-300">
            {formatCurrency(totals.totalExpenses)}
          </div>
        </div>
        <div className={`rounded-lg p-6 ${
          totals.netCashFlow >= 0
            ? 'bg-blue-50 dark:bg-blue-900/20'
            : 'bg-orange-50 dark:bg-orange-900/20'
        }`}>
          <div className={`text-sm ${
            totals.netCashFlow >= 0
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-orange-600 dark:text-orange-400'
          }`}>
            Net Cash Flow
          </div>
          <div className={`text-2xl font-bold ${
            totals.netCashFlow >= 0
              ? 'text-blue-700 dark:text-blue-300'
              : 'text-orange-700 dark:text-orange-300'
          }`}>
            {totals.netCashFlow >= 0 ? '+' : ''}{formatCurrency(totals.netCashFlow)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <DateRangeSelector
          ranges={['3m', '6m', '1y']}
          value={dateRange}
          onChange={setDateRange}
          showCustom
          customStartDate={startDate}
          onCustomStartDateChange={setStartDate}
          customEndDate={endDate}
          onCustomEndDateChange={setEndDate}
        />
      </div>

      {/* Monthly Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Monthly Cash Flow
        </h3>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis
                tickFormatter={formatCurrencyAxis}
                tick={{ fontSize: 12 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <ReferenceLine y={0} stroke="#9ca3af" />
              <Bar dataKey="Income" fill="#22c55e" name="Inflows" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Expenses" fill="#ef4444" name="Outflows" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Breakdown Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inflows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 bg-green-50 dark:bg-green-900/20 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-green-700 dark:text-green-300">
              Inflows by Category
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {incomeItems.length === 0 ? (
              <p className="px-6 py-4 text-gray-500 dark:text-gray-400">No income in this period</p>
            ) : (
              incomeItems.map((item, index) => (
                <div key={index} className="px-6 py-3 flex items-center justify-between">
                  <span className="text-gray-900 dark:text-gray-100">{item.categoryName}</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    {formatCurrency(item.total)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Outflows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 bg-red-50 dark:bg-red-900/20 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-red-700 dark:text-red-300">
              Outflows by Category
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {expenseItems.length === 0 ? (
              <p className="px-6 py-4 text-gray-500 dark:text-gray-400">No expenses in this period</p>
            ) : (
              expenseItems.map((item, index) => (
                <div key={index} className="px-6 py-3 flex items-center justify-between">
                  <span className="text-gray-900 dark:text-gray-100">{item.categoryName}</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    {formatCurrency(item.total)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
