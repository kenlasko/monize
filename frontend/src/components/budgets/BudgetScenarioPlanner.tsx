'use client';

import { useState, useMemo, useCallback } from 'react';
import type { CategoryBreakdown } from '@/types/budget';

interface BudgetScenarioPlannerProps {
  categories: CategoryBreakdown[];
  totalIncome: number;
  formatCurrency: (amount: number) => string;
  onApplyChanges?: (changes: Array<{ budgetCategoryId: string; amount: number }>) => void;
}

interface ScenarioCategory {
  budgetCategoryId: string;
  categoryName: string;
  originalBudget: number;
  adjustedBudget: number;
  currentSpent: number;
}

export function BudgetScenarioPlanner({
  categories,
  totalIncome,
  formatCurrency,
  onApplyChanges,
}: BudgetScenarioPlannerProps) {
  const expenseCategories = useMemo(
    () => categories.filter((c) => !c.isIncome),
    [categories],
  );

  const [adjustments, setAdjustments] = useState<Map<string, number>>(
    () =>
      new Map(
        expenseCategories.map((c) => [c.budgetCategoryId, c.budgeted]),
      ),
  );

  const handleSliderChange = useCallback(
    (budgetCategoryId: string, value: number) => {
      setAdjustments((prev) => {
        const next = new Map(prev);
        next.set(budgetCategoryId, value);
        return next;
      });
    },
    [],
  );

  const resetAll = useCallback(() => {
    setAdjustments(
      new Map(
        expenseCategories.map((c) => [c.budgetCategoryId, c.budgeted]),
      ),
    );
  }, [expenseCategories]);

  const scenarioCategories: ScenarioCategory[] = useMemo(
    () =>
      expenseCategories.map((c) => ({
        budgetCategoryId: c.budgetCategoryId,
        categoryName: c.categoryName,
        originalBudget: c.budgeted,
        adjustedBudget: adjustments.get(c.budgetCategoryId) ?? c.budgeted,
        currentSpent: c.spent,
      })),
    [expenseCategories, adjustments],
  );

  const originalTotal = useMemo(
    () => expenseCategories.reduce((sum, c) => sum + c.budgeted, 0),
    [expenseCategories],
  );

  const adjustedTotal = useMemo(
    () =>
      scenarioCategories.reduce((sum, c) => sum + c.adjustedBudget, 0),
    [scenarioCategories],
  );

  const originalSavings = totalIncome - originalTotal;
  const adjustedSavings = totalIncome - adjustedTotal;
  const savingsDifference = adjustedSavings - originalSavings;

  const hasChanges = useMemo(
    () =>
      scenarioCategories.some(
        (c) =>
          Math.round(c.adjustedBudget * 100) !==
          Math.round(c.originalBudget * 100),
      ),
    [scenarioCategories],
  );

  const handleApply = () => {
    if (!onApplyChanges || !hasChanges) return;
    const changes = scenarioCategories
      .filter(
        (c) =>
          Math.round(c.adjustedBudget * 100) !==
          Math.round(c.originalBudget * 100),
      )
      .map((c) => ({
        budgetCategoryId: c.budgetCategoryId,
        amount: c.adjustedBudget,
      }));
    onApplyChanges(changes);
  };

  if (expenseCategories.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          What-If Scenario Planner
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No expense categories to plan with.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          What-If Scenario Planner
        </h2>
        <div className="flex gap-2">
          {hasChanges && (
            <button
              onClick={resetAll}
              className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              data-testid="reset-scenario"
            >
              Reset
            </button>
          )}
          {hasChanges && onApplyChanges && (
            <button
              onClick={handleApply}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
              data-testid="apply-scenario"
            >
              Apply Changes
            </button>
          )}
        </div>
      </div>

      {/* Summary comparison */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">Current Budget</p>
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100" data-testid="current-total">
            {formatCurrency(originalTotal)}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">Proposed Budget</p>
          <p
            className={`text-base font-semibold ${
              adjustedTotal !== originalTotal
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-900 dark:text-gray-100'
            }`}
            data-testid="proposed-total"
          >
            {formatCurrency(adjustedTotal)}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">Projected Savings</p>
          <p
            className={`text-base font-semibold ${
              adjustedSavings >= 0
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
            data-testid="projected-savings"
          >
            {formatCurrency(adjustedSavings)}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">Savings Change</p>
          <p
            className={`text-base font-semibold ${
              savingsDifference > 0
                ? 'text-green-600 dark:text-green-400'
                : savingsDifference < 0
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-gray-900 dark:text-gray-100'
            }`}
            data-testid="savings-difference"
          >
            {savingsDifference > 0 ? '+' : ''}
            {formatCurrency(savingsDifference)}
          </p>
        </div>
      </div>

      {/* Category sliders */}
      <div className="space-y-4" data-testid="scenario-categories">
        {scenarioCategories.map((cat) => {
          const maxValue = Math.max(cat.originalBudget * 2, 100);
          const changed =
            Math.round(cat.adjustedBudget * 100) !==
            Math.round(cat.originalBudget * 100);
          const difference = cat.adjustedBudget - cat.originalBudget;

          return (
            <div key={cat.budgetCategoryId}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {cat.categoryName}
                </span>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-sm font-semibold ${
                      changed
                        ? 'text-blue-600 dark:text-blue-400'
                        : 'text-gray-900 dark:text-gray-100'
                    }`}
                  >
                    {formatCurrency(cat.adjustedBudget)}
                  </span>
                  {changed && (
                    <span
                      className={`text-xs ${
                        difference > 0
                          ? 'text-red-500 dark:text-red-400'
                          : 'text-green-500 dark:text-green-400'
                      }`}
                    >
                      ({difference > 0 ? '+' : ''}
                      {formatCurrency(difference)})
                    </span>
                  )}
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={maxValue}
                step={5}
                value={cat.adjustedBudget}
                onChange={(e) =>
                  handleSliderChange(
                    cat.budgetCategoryId,
                    Number(e.target.value),
                  )
                }
                className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
                data-testid={`slider-${cat.budgetCategoryId}`}
              />
              <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                <span>{formatCurrency(0)}</span>
                <span className="text-gray-500 dark:text-gray-400">
                  Original: {formatCurrency(cat.originalBudget)}
                </span>
                <span>{formatCurrency(maxValue)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
