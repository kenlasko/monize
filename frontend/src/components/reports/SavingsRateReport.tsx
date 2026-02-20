'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { budgetsApi } from '@/lib/budgets';
import type { Budget, SavingsRatePoint } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SavingsRateReport');

export function SavingsRateReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const [months, setMonths] = useState(12);
  const [data, setData] = useState<SavingsRatePoint[]>([]);
  const [targetRate, setTargetRate] = useState(20);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadBudgets = async () => {
      try {
        const budgetList = await budgetsApi.getAll();
        setBudgets(budgetList);
        const active = budgetList.find((b) => b.isActive);
        if (active) {
          setSelectedBudgetId(active.id);
        } else if (budgetList.length > 0) {
          setSelectedBudgetId(budgetList[0].id);
        }
      } catch (error) {
        logger.error('Failed to load budgets:', error);
      }
    };
    loadBudgets();
  }, []);

  const loadData = useCallback(async () => {
    if (!selectedBudgetId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const result = await budgetsApi.getSavingsRate(selectedBudgetId, months);
      setData(result);
    } catch (error) {
      logger.error('Failed to load savings rate data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedBudgetId, months]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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

  if (budgets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          No budgets found. Create a budget to see your savings rate.
        </p>
      </div>
    );
  }

  const avgRate = data.length > 0
    ? data.reduce((s, p) => s + p.savingsRate, 0) / data.length
    : 0;
  const currentRate = data.length > 0 ? data[data.length - 1].savingsRate : 0;
  const totalSaved = data.reduce((s, p) => s + p.savings, 0);
  const meetsTarget = currentRate >= targetRate;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={selectedBudgetId}
            onChange={(e) => setSelectedBudgetId(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value={6}>6 Months</option>
            <option value={12}>12 Months</option>
            <option value={24}>24 Months</option>
          </select>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400">Target:</label>
            <select
              value={targetRate}
              onChange={(e) => setTargetRate(Number(e.target.value))}
              className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              <option value={10}>10%</option>
              <option value={15}>15%</option>
              <option value={20}>20%</option>
              <option value={25}>25%</option>
              <option value={30}>30%</option>
              <option value={50}>50%</option>
            </select>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Current Rate</p>
          <p className={`text-2xl font-bold ${meetsTarget ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {currentRate.toFixed(1)}%
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Average Rate</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {avgRate.toFixed(1)}%
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Target Rate</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {targetRate}%
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Total Saved</p>
          <p className={`text-2xl font-bold ${totalSaved >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatCurrency(totalSaved)}
          </p>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        {data.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No savings rate data available yet.
          </p>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 12 }}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const point = payload[0]?.payload as SavingsRatePoint | undefined;
                    if (!point) return null;
                    return (
                      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Income: {formatCurrency(point.income)}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Expenses: {formatCurrency(point.expenses)}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">Savings: {formatCurrency(point.savings)}</p>
                        <p className={`text-sm font-medium ${point.savingsRate >= targetRate ? 'text-green-600' : 'text-red-600'}`}>
                          Rate: {point.savingsRate.toFixed(1)}%
                        </p>
                      </div>
                    );
                  }}
                />
                <Legend />
                <ReferenceLine
                  y={targetRate}
                  stroke="#3b82f6"
                  strokeDasharray="3 3"
                  label={{ value: `Target ${targetRate}%`, position: 'right', fill: '#3b82f6', fontSize: 11 }}
                />
                <ReferenceLine y={0} stroke="#9ca3af" />
                <Line
                  type="monotone"
                  dataKey="savingsRate"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  name="Savings Rate (%)"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Monthly breakdown table */}
      {data.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Monthly Breakdown</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400">Month</th>
                  <th className="py-2 pr-4 text-right font-medium text-gray-500 dark:text-gray-400">Income</th>
                  <th className="py-2 pr-4 text-right font-medium text-gray-500 dark:text-gray-400">Expenses</th>
                  <th className="py-2 pr-4 text-right font-medium text-gray-500 dark:text-gray-400">Savings</th>
                  <th className="py-2 text-right font-medium text-gray-500 dark:text-gray-400">Rate</th>
                </tr>
              </thead>
              <tbody>
                {data.map((point) => (
                  <tr key={point.month} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">{point.month}</td>
                    <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">{formatCurrency(point.income)}</td>
                    <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">{formatCurrency(point.expenses)}</td>
                    <td className={`py-2 pr-4 text-right font-medium ${point.savings >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {formatCurrency(point.savings)}
                    </td>
                    <td className={`py-2 text-right font-medium ${point.savingsRate >= targetRate ? 'text-green-600 dark:text-green-400' : point.savingsRate >= 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                      {point.savingsRate.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
