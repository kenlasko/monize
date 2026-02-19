'use client';

import { useState, useEffect, useCallback } from 'react';
import { budgetsApi } from '@/lib/budgets';
import type { Budget, HealthScoreResult } from '@/types/budget';
import { BudgetHealthGauge } from '@/components/budgets/BudgetHealthGauge';
import { createLogger } from '@/lib/logger';

const logger = createLogger('BudgetHealthScoreReport');

function getImpactColor(impact: number): string {
  if (impact > 0) return 'text-green-600 dark:text-green-400';
  if (impact < 0) return 'text-red-600 dark:text-red-400';
  return 'text-gray-500 dark:text-gray-400';
}

function getGroupLabel(group: string | null): string {
  if (group === 'NEED') return 'Need';
  if (group === 'WANT') return 'Want';
  if (group === 'SAVING') return 'Saving';
  return 'Uncategorized';
}

function getGroupColor(group: string | null): string {
  if (group === 'NEED') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  if (group === 'WANT') return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
  if (group === 'SAVING') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
}

export function BudgetHealthScoreReport() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const [healthScore, setHealthScore] = useState<HealthScoreResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadBudgets = async () => {
      try {
        const data = await budgetsApi.getAll();
        setBudgets(data);
        const active = data.find((b) => b.isActive);
        if (active) {
          setSelectedBudgetId(active.id);
        } else if (data.length > 0) {
          setSelectedBudgetId(data[0].id);
        }
      } catch (error) {
        logger.error('Failed to load budgets:', error);
      }
    };
    loadBudgets();
  }, []);

  const loadHealthScore = useCallback(async () => {
    if (!selectedBudgetId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const result = await budgetsApi.getHealthScore(selectedBudgetId);
      setHealthScore(result);
    } catch (error) {
      logger.error('Failed to load health score:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedBudgetId]);

  useEffect(() => {
    loadHealthScore();
  }, [loadHealthScore]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-40 w-40 bg-gray-200 dark:bg-gray-700 rounded-full mx-auto" />
          <div className="h-32 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (budgets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          No budgets found. Create a budget to see your health score.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Budget selector */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <select
          value={selectedBudgetId}
          onChange={(e) => setSelectedBudgetId(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          {budgets.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {healthScore && (
        <>
          {/* Gauge */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <BudgetHealthGauge score={healthScore.score} />

            {/* Score Breakdown */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Score Breakdown
              </h2>
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Base Score</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {healthScore.breakdown.baseScore}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Over-Budget Deductions</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -{healthScore.breakdown.overBudgetDeductions}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Essential Category Penalty</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -{healthScore.breakdown.essentialWeightPenalty}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Under-Budget Bonus</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    +{healthScore.breakdown.underBudgetBonus}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">Improving Trend Bonus</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    +{healthScore.breakdown.trendBonus}
                  </span>
                </div>
                <div className="pt-2 border-t border-gray-200 dark:border-gray-700 flex justify-between text-sm font-semibold">
                  <span className="text-gray-900 dark:text-gray-100">Final Score</span>
                  <span className="text-gray-900 dark:text-gray-100">{healthScore.score}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Per-Category Impact */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Category Impact
            </h2>
            {healthScore.categoryScores.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No categories to evaluate.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400">Category</th>
                      <th className="py-2 pr-4 text-left font-medium text-gray-500 dark:text-gray-400">Group</th>
                      <th className="py-2 pr-4 text-right font-medium text-gray-500 dark:text-gray-400">% Used</th>
                      <th className="py-2 text-right font-medium text-gray-500 dark:text-gray-400">Score Impact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {healthScore.categoryScores
                      .sort((a, b) => a.impact - b.impact)
                      .map((cat) => (
                        <tr key={cat.categoryId} className="border-b border-gray-100 dark:border-gray-700/50">
                          <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">{cat.categoryName}</td>
                          <td className="py-2 pr-4">
                            <span className={`px-2 py-0.5 text-xs font-medium rounded ${getGroupColor(cat.categoryGroup)}`}>
                              {getGroupLabel(cat.categoryGroup)}
                            </span>
                          </td>
                          <td className={`py-2 pr-4 text-right font-medium ${cat.percentUsed > 100 ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>
                            {cat.percentUsed}%
                          </td>
                          <td className={`py-2 text-right font-medium ${getImpactColor(cat.impact)}`}>
                            {cat.impact > 0 ? '+' : ''}{cat.impact}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
