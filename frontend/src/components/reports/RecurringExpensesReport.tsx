'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { RecurringExpenseItem, RecurringExpensesResponse } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { createLogger } from '@/lib/logger';

const logger = createLogger('RecurringExpensesReport');


export function RecurringExpensesReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [recurringData, setRecurringData] = useState<RecurringExpensesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [minOccurrences, setMinOccurrences] = useState(3);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const data = await builtInReportsApi.getRecurringExpenses(minOccurrences);
        setRecurringData(data);
      } catch (error) {
        logger.error('Failed to load recurring expenses:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [minOccurrences]);

  const chartData = useMemo(() => {
    if (!recurringData) return [];
    return recurringData.data.slice(0, 10).map((item, index) => ({
      ...item,
      color: CHART_COLOURS[index % CHART_COLOURS.length],
    }));
  }, [recurringData]);

  const handlePayeeClick = (payeeId: string | null) => {
    if (payeeId) {
      router.push(`/transactions?payeeId=${payeeId}`);
    }
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: RecurringExpenseItem & { color: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.payeeName}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {data.occurrences} transactions - {data.frequency}
          </p>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-1">
            Total: {formatCurrency(data.totalAmount)}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Avg: {formatCurrency(data.averageAmount)} per transaction
          </p>
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

  if (!recurringData) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          Failed to load recurring expenses data.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Recurring Expenses</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {recurringData.summary.uniquePayees}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">identified payees</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">6-Month Total</div>
          <div className="text-xl font-bold text-red-600 dark:text-red-400">
            {formatCurrency(recurringData.summary.totalRecurring)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Monthly Estimate</div>
          <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
            {formatCurrency(recurringData.summary.monthlyEstimate)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center gap-4">
          <label className="text-sm text-gray-700 dark:text-gray-300">
            Minimum occurrences:
          </label>
          <select
            value={minOccurrences}
            onChange={(e) => setMinOccurrences(Number(e.target.value))}
            className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
          >
            <option value={2}>2+</option>
            <option value={3}>3+</option>
            <option value={4}>4+</option>
            <option value={5}>5+</option>
            <option value={6}>6+</option>
          </select>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            (in last 6 months)
          </span>
        </div>
      </div>

      {recurringData.data.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No recurring expenses found with {minOccurrences}+ occurrences in the last 6 months.
          </p>
        </div>
      ) : (
        <>
          {/* Chart */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Top 10 Recurring Expenses
            </h3>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={120}
                    paddingAngle={2}
                    dataKey="totalAmount"
                    cursor="pointer"
                    onClick={(data) => handlePayeeClick(data.payeeId)}
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                All Recurring Expenses
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Payee
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Category
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Frequency
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Count
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Avg Amount
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      6-Mo Total
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Last Paid
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {recurringData.data.map((expense, index) => (
                    <tr
                      key={index}
                      className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${expense.payeeId ? 'cursor-pointer' : ''}`}
                      onClick={() => handlePayeeClick(expense.payeeId)}
                    >
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {expense.payeeName}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {expense.categoryName}
                      </td>
                      <td className="px-4 py-3 text-sm text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          expense.frequency === 'Weekly'
                            ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                            : expense.frequency === 'Bi-weekly'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                            : expense.frequency === 'Monthly'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {expense.frequency}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-center text-gray-900 dark:text-gray-100">
                        {expense.occurrences}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-100">
                        {formatCurrency(expense.averageAmount)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-red-600 dark:text-red-400">
                        {formatCurrency(expense.totalAmount)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400">
                        {format(new Date(expense.lastTransactionDate), 'MMM d')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
