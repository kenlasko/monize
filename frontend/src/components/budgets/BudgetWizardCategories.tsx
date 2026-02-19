'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { formatCurrency, getCurrencySymbol } from '@/lib/format';
import type { WizardState } from './BudgetWizard';
import type { BudgetProfile, TransferAnalysis } from '@/types/budget';

function BudgetAmountInput({
  categoryId,
  amount,
  currencyCode,
  onChange,
}: {
  categoryId: string;
  amount: number;
  currencyCode: string;
  onChange: (categoryId: string, amount: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const displayValue = editing ? editValue : amount.toFixed(2);

  return (
    <div className="relative inline-flex items-center">
      <span className="absolute left-2 text-sm text-gray-500 dark:text-gray-400 pointer-events-none">
        {getCurrencySymbol(currencyCode)}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={displayValue}
        onFocus={() => {
          setEditing(true);
          setEditValue(amount.toFixed(2));
        }}
        onBlur={() => {
          setEditing(false);
          const parsed = parseFloat(editValue);
          if (!isNaN(parsed) && parsed >= 0) {
            onChange(categoryId, Math.round(parsed * 100) / 100);
          }
        }}
        onChange={(e) => {
          if (editing) {
            setEditValue(e.target.value);
          }
        }}
        className="w-28 sm:w-36 text-right rounded border border-gray-300 pl-6 pr-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
      />
    </div>
  );
}

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
  const { analysisResult, selectedCategories, selectedTransfers, profile, currencyCode } = state;

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

  const transferAnalysis = useMemo(
    () => analysisResult?.transfers ?? [],
    [analysisResult],
  );

  const totals = useMemo(() => {
    let totalIncome = 0;
    let totalExpenses = 0;
    let totalTransfers = 0;

    for (const [, cat] of selectedCategories) {
      if (cat.isIncome) {
        totalIncome += cat.amount;
      } else {
        totalExpenses += cat.amount;
      }
    }

    for (const [, t] of selectedTransfers) {
      totalTransfers += t.amount;
    }

    return {
      totalIncome,
      totalExpenses,
      totalTransfers,
      net: totalIncome - totalExpenses - totalTransfers,
    };
  }, [selectedCategories, selectedTransfers]);

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

    const updatedTransfers = new Map(selectedTransfers);
    for (const t of analysisResult.transfers ?? []) {
      const existing = updatedTransfers.get(t.accountId);
      if (!existing) continue;

      let tAmount: number;
      switch (newProfile) {
        case 'COMFORTABLE':
          tAmount = t.p75;
          break;
        case 'AGGRESSIVE':
          tAmount = t.p25;
          break;
        default:
          tAmount = t.median;
      }

      updatedTransfers.set(t.accountId, { ...existing, amount: tAmount });
    }

    updateState({
      profile: newProfile,
      selectedCategories: updated,
      selectedTransfers: updatedTransfers,
    });
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

  const handleTransferAmountChange = (accountId: string, amount: number) => {
    const updated = new Map(selectedTransfers);
    const existing = updated.get(accountId);
    if (existing) {
      updated.set(accountId, { ...existing, amount });
      updateState({ selectedTransfers: updated });
    }
  };

  const handleToggleTransfer = (accountId: string, checked: boolean) => {
    const updated = new Map(selectedTransfers);
    if (checked) {
      const t = analysisResult?.transfers?.find(
        (tr) => tr.accountId === accountId,
      );
      if (t) {
        updated.set(accountId, {
          transferAccountId: t.accountId,
          isTransfer: true,
          amount: t.suggested,
        });
      }
    } else {
      updated.delete(accountId);
    }
    updateState({ selectedTransfers: updated });
  };

  const renderTransferRow = (transfer: TransferAnalysis) => {
    const isSelected = selectedTransfers.has(transfer.accountId);
    const currentAmount = selectedTransfers.get(transfer.accountId)?.amount ?? 0;

    return (
      <tr
        key={transfer.accountId}
        className="border-b border-gray-100 dark:border-gray-700 last:border-0"
      >
        <td className="py-3 px-2 sm:px-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={(e) =>
                handleToggleTransfer(transfer.accountId, e.target.checked)
              }
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-500 dark:bg-gray-700"
            />
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {transfer.accountName}
            </span>
            <span className="text-xs bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300 px-1.5 py-0.5 rounded hidden sm:inline">
              {transfer.accountType.replace(/_/g, ' ')}
            </span>
            {transfer.isFixed && (
              <span className="text-xs bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 px-1.5 py-0.5 rounded">
                Fixed
              </span>
            )}
          </label>
        </td>
        <td className="hidden sm:table-cell py-3 px-2 sm:px-4 text-right text-sm text-gray-500 dark:text-gray-400">
          {formatCurrency(transfer.median, currencyCode)}
        </td>
        <td className="py-3 px-2 sm:px-4 text-right">
          {isSelected && (
            <BudgetAmountInput
              categoryId={transfer.accountId}
              amount={currentAmount}
              currencyCode={currencyCode}
              onChange={handleTransferAmountChange}
            />
          )}
        </td>
      </tr>
    );
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
        <td className="py-3 px-2 sm:px-4">
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
        <td className="hidden sm:table-cell py-3 px-2 sm:px-4 text-right text-sm text-gray-500 dark:text-gray-400">
          {formatCurrency(cat.median, currencyCode)}
        </td>
        <td className="py-3 px-2 sm:px-4 text-right">
          {isSelected && (
            <BudgetAmountInput
              categoryId={cat.categoryId}
              amount={currentAmount}
              currencyCode={currencyCode}
              onChange={handleAmountChange}
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
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-green-50 dark:bg-green-900/20 border-b border-green-200 dark:border-green-800">
                  <th className="text-left py-2 px-2 sm:px-4 text-xs font-medium text-green-700 dark:text-green-400 uppercase">
                    Income
                  </th>
                  <th className="hidden sm:table-cell w-32 text-right py-2 px-2 sm:px-4 text-xs font-medium text-green-700 dark:text-green-400 uppercase">
                    Median
                  </th>
                  <th className="w-36 sm:w-48 py-2 px-2 sm:px-4 text-xs font-medium text-green-700 dark:text-green-400 uppercase text-right">
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
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
                <th className="text-left py-2 px-2 sm:px-4 text-xs font-medium text-red-700 dark:text-red-400 uppercase">
                  Expenses
                </th>
                <th className="hidden sm:table-cell w-32 text-right py-2 px-2 sm:px-4 text-xs font-medium text-red-700 dark:text-red-400 uppercase">
                  Median
                </th>
                <th className="w-36 sm:w-48 py-2 px-2 sm:px-4 text-xs font-medium text-red-700 dark:text-red-400 uppercase text-right">
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

      {/* Transfer categories */}
      {transferAnalysis.length > 0 && (
        <div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800">
                  <th className="text-left py-2 px-2 sm:px-4 text-xs font-medium text-blue-700 dark:text-blue-400 uppercase">
                    Transfers / Savings
                  </th>
                  <th className="hidden sm:table-cell w-32 text-right py-2 px-2 sm:px-4 text-xs font-medium text-blue-700 dark:text-blue-400 uppercase">
                    Median
                  </th>
                  <th className="w-36 sm:w-48 py-2 px-2 sm:px-4 text-xs font-medium text-blue-700 dark:text-blue-400 uppercase text-right">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {transferAnalysis.map(renderTransferRow)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Totals */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 text-center">
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
              Transfers
            </div>
            <div className="text-lg font-semibold text-blue-600 dark:text-blue-400">
              {formatCurrency(totals.totalTransfers, currencyCode)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Remaining
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
          disabled={selectedCategories.size === 0 && selectedTransfers.size === 0}
        >
          Next: Configure
        </Button>
      </div>
    </div>
  );
}
