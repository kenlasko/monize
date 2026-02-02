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
import { format, subMonths } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { Transaction } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface RecurringExpense {
  payeeName: string;
  payeeId: string | null;
  occurrences: number;
  totalAmount: number;
  averageAmount: number;
  lastTransaction: string;
  frequency: string;
  categoryName: string;
}

const COLORS = [
  '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
];

export function RecurringExpensesReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [minOccurrences, setMinOccurrences] = useState(3);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        // Get last 6 months of transactions
        const now = new Date();
        const startDate = format(subMonths(now, 6), 'yyyy-MM-dd');
        const endDate = format(now, 'yyyy-MM-dd');

        const txData = await transactionsApi.getAll({
          startDate,
          endDate,
          limit: 50000,
        });

        // Filter to expenses only (negative amounts, not transfers)
        const expenses = txData.data.filter(
          (tx) => !tx.isTransfer && Number(tx.amount) < 0
        );
        setTransactions(expenses);
      } catch (error) {
        console.error('Failed to load transactions:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  const recurringExpenses = useMemo((): RecurringExpense[] => {
    // Group by payee name (case insensitive)
    const payeeMap = new Map<string, {
      payeeName: string;
      payeeId: string | null;
      transactions: Transaction[];
      categoryName: string;
    }>();

    transactions.forEach((tx) => {
      const payeeName = (tx.payee?.name || tx.payeeName || 'Unknown').toLowerCase().trim();
      if (!payeeName || payeeName === 'unknown') return;

      let entry = payeeMap.get(payeeName);
      if (!entry) {
        entry = {
          payeeName: tx.payee?.name || tx.payeeName || 'Unknown',
          payeeId: tx.payeeId,
          transactions: [],
          categoryName: tx.category?.name || 'Uncategorized',
        };
        payeeMap.set(payeeName, entry);
      }
      entry.transactions.push(tx);
    });

    // Calculate recurring patterns
    const recurring: RecurringExpense[] = [];

    payeeMap.forEach((entry) => {
      if (entry.transactions.length < minOccurrences) return;

      const amounts = entry.transactions.map((tx) => Math.abs(Number(tx.amount)));
      const totalAmount = amounts.reduce((sum, a) => sum + a, 0);
      const averageAmount = totalAmount / amounts.length;

      // Sort transactions by date
      const sortedTx = [...entry.transactions].sort(
        (a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime()
      );

      // Estimate frequency based on occurrence count over 6 months
      const occurrences = entry.transactions.length;
      let frequency = 'Irregular';
      if (occurrences >= 24) frequency = 'Weekly';
      else if (occurrences >= 12) frequency = 'Bi-weekly';
      else if (occurrences >= 5) frequency = 'Monthly';
      else if (occurrences >= 3) frequency = 'Occasional';

      recurring.push({
        payeeName: entry.payeeName,
        payeeId: entry.payeeId,
        occurrences,
        totalAmount,
        averageAmount,
        lastTransaction: sortedTx[0].transactionDate,
        frequency,
        categoryName: entry.categoryName,
      });
    });

    return recurring.sort((a, b) => b.totalAmount - a.totalAmount);
  }, [transactions, minOccurrences]);

  const chartData = useMemo(() => {
    return recurringExpenses.slice(0, 10).map((item, index) => ({
      ...item,
      color: COLORS[index % COLORS.length],
    }));
  }, [recurringExpenses]);

  const totalRecurring = recurringExpenses.reduce((sum, item) => sum + item.totalAmount, 0);
  const monthlyEstimate = totalRecurring / 6;

  const handlePayeeClick = (payeeId: string | null) => {
    if (payeeId) {
      router.push(`/transactions?payeeId=${payeeId}`);
    }
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: RecurringExpense & { color: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.payeeName}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {data.occurrences} transactions • {data.frequency}
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

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Recurring Expenses</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {recurringExpenses.length}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">identified payees</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">6-Month Total</div>
          <div className="text-xl font-bold text-red-600 dark:text-red-400">
            {formatCurrency(totalRecurring)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Monthly Estimate</div>
          <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
            {formatCurrency(monthlyEstimate)}
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

      {recurringExpenses.length === 0 ? (
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
                  {recurringExpenses.map((expense, index) => (
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
                        {format(new Date(expense.lastTransaction), 'MMM d')}
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
