'use client';

import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { formatCurrency } from '@/lib/format';
import type { WizardState } from './BudgetWizard';
import type { BudgetProfile } from '@/types/budget';

interface BudgetWizardCategoriesProps {
  state: WizardState;
  updateState: (updates: Partial<WizardState>) => void;
  onNext: () => void;
  onBack: () => void;
}

const PROFILE_OPTIONS: Array<{
  value: BudgetProfile;
  label: string;
}> = [
  { value: 'COMFORTABLE', label: 'Comfortable' },
  { value: 'ON_TRACK', label: 'On Track' },
  { value: 'AGGRESSIVE', label: 'Aggressive' },
];

export function BudgetWizardCategories({
  state,
  updateState,
  onNext,
  onBack,
}: BudgetWizardCategoriesProps) {
  const { analysisResult, selectedCategories, profile, currencyCode } = state;

  const incomeCategories = useMemo(
    () =>
      analysisResult?.categories.filter((c) => c.isIncome) ?? [],
    [analysisResult],
  );

  const expenseCategories = useMemo(
    () =>
      analysisResult?.categories
        .filter((c) => !c.isIncome)
        .sort((a, b) => b.suggested - a.suggested) ?? [],
    [analysisResult],
  );

  const totals = useMemo(() => {
    let totalIncome = 0;
    let totalExpenses = 0;

    for (const [, cat] of selectedCategories) {
      if (cat.isIncome) {
        totalIncome += cat.amount;
      } else {
        totalExpenses += cat.amount;
      }
    }

    return { totalIncome, totalExpenses, net: totalIncome - totalExpenses };
  }, [selectedCategories]);

  const handleProfileChange = (newProfile: BudgetProfile) => {
    if (!analysisResult) return;

    const updated = new Map(selectedCategories);
    for (const cat of analysisResult.categories) {
      const existing = updated.get(cat.categoryId);
      if (!existing) continue;

      let amount: number;
      switch (newProfile) {
        case 'COMFORTABLE':
          amount = cat.p75;
          break;
        case 'AGGRESSIVE':
          amount = cat.p25;
          break;
        default:
          amount = cat.median;
      }

      updated.set(cat.categoryId, { ...existing, amount });
    }

    updateState({ profile: newProfile, selectedCategories: updated });
  };

  const handleAmountChange = (categoryId: string, amount: number) => {
    const updated = new Map(selectedCategories);
    const existing = updated.get(categoryId);
    if (existing) {
      updated.set(categoryId, { ...existing, amount });
      updateState({ selectedCategories: updated });
    }
  };

  const handleToggleCategory = (categoryId: string, checked: boolean) => {
    const updated = new Map(selectedCategories);
    if (checked) {
      const cat = analysisResult?.categories.find(
        (c) => c.categoryId === categoryId,
      );
      if (cat) {
        updated.set(categoryId, {
          categoryId: cat.categoryId,
          amount: cat.suggested,
          isIncome: cat.isIncome,
        });
      }
    } else {
      updated.delete(categoryId);
    }
    updateState({ selectedCategories: updated });
  };

  const renderCategoryRow = (
    cat: { categoryId: string; categoryName: string; median: number; p25: number; p75: number; isFixed: boolean },
  ) => {
    const isSelected = selectedCategories.has(cat.categoryId);
    const currentAmount = selectedCategories.get(cat.categoryId)?.amount ?? 0;

    return (
      <tr
        key={cat.categoryId}
        className="border-b border-gray-100 dark:border-gray-700 last:border-0"
      >
        <td className="py-3 px-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={(e) =>
                handleToggleCategory(cat.categoryId, e.target.checked)
              }
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-500 dark:bg-gray-700"
            />
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {cat.categoryName}
            </span>
            {cat.isFixed && (
              <span className="text-xs bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 px-1.5 py-0.5 rounded">
                Fixed
              </span>
            )}
          </label>
        </td>
        <td className="py-3 px-4 text-right text-sm text-gray-500 dark:text-gray-400">
          {formatCurrency(cat.median, currencyCode)}
        </td>
        <td className="py-3 px-4">
          {isSelected && (
            <input
              type="number"
              value={currentAmount}
              min={0}
              step={0.01}
              onChange={(e) =>
                handleAmountChange(
                  cat.categoryId,
                  parseFloat(e.target.value) || 0,
                )
              }
              className="w-28 text-right rounded border border-gray-300 px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
            />
          )}
        </td>
      </tr>
    );
  };

  if (!analysisResult) {
    return (
      <div className="text-center text-gray-500 dark:text-gray-400 py-12">
        No analysis data. Go back and run the analysis first.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Profile toggle */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Review Categories
        </h3>
        <div className="flex rounded-md shadow-sm">
          {PROFILE_OPTIONS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => handleProfileChange(p.value)}
              className={`px-3 py-1.5 text-sm font-medium border first:rounded-l-md last:rounded-r-md transition-colors ${
                profile === p.value
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600 dark:hover:bg-gray-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Income categories */}
      {incomeCategories.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-green-700 dark:text-green-400 mb-2 uppercase tracking-wide">
            Income
          </h4>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-750 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Category
                  </th>
                  <th className="text-right py-2 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Median
                  </th>
                  <th className="py-2 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase text-right">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {incomeCategories.map(renderCategoryRow)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Expense categories */}
      <div>
        <h4 className="text-sm font-medium text-red-700 dark:text-red-400 mb-2 uppercase tracking-wide">
          Expenses
        </h4>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-750 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left py-2 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Category
                </th>
                <th className="text-right py-2 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Median
                </th>
                <th className="py-2 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase text-right">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {expenseCategories.map(renderCategoryRow)}
            </tbody>
          </table>
        </div>
      </div>

      {/* Totals */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Total Income
            </div>
            <div className="text-lg font-semibold text-green-600 dark:text-green-400">
              {formatCurrency(totals.totalIncome, currencyCode)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Total Expenses
            </div>
            <div className="text-lg font-semibold text-red-600 dark:text-red-400">
              {formatCurrency(totals.totalExpenses, currencyCode)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Net (Savings)
            </div>
            <div
              className={`text-lg font-semibold ${
                totals.net >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(totals.net, currencyCode)}
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-between pt-4 border-t border-gray-200 dark:border-gray-700">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={onNext}
          disabled={selectedCategories.size === 0}
        >
          Next: Configure
        </Button>
      </div>
    </div>
  );
}
