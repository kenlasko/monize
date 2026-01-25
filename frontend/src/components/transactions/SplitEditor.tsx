'use client';

import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Category } from '@/types/category';
import { CreateSplitData } from '@/types/transaction';
import { buildCategoryTree } from '@/lib/categoryUtils';

interface SplitRow extends CreateSplitData {
  id: string; // Temporary ID for React keys
}

interface SplitEditorProps {
  splits: SplitRow[];
  onChange: (splits: SplitRow[]) => void;
  categories: Category[];
  transactionAmount: number;
  disabled?: boolean;
  onTransactionAmountChange?: (amount: number) => void;
  currencyCode?: string;
}

// Get currency symbol from code
const getCurrencySymbol = (code: string): string => {
  const symbols: Record<string, string> = {
    USD: '$',
    CAD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    CNY: '¥',
    AUD: '$',
    NZD: '$',
  };
  return symbols[code.toUpperCase()] || '$';
};

export function SplitEditor({
  splits,
  onChange,
  categories,
  transactionAmount,
  disabled = false,
  onTransactionAmountChange,
  currencyCode = 'CAD',
}: SplitEditorProps) {
  const currencySymbol = getCurrencySymbol(currencyCode);
  const [localSplits, setLocalSplits] = useState<SplitRow[]>(splits);

  // Sync with parent when splits prop changes
  useEffect(() => {
    setLocalSplits(splits);
  }, [splits]);

  const splitsTotal = localSplits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const remaining = Number(transactionAmount) - splitsTotal;
  const isBalanced = Math.abs(remaining) < 0.01;

  const handleSplitChange = (index: number, field: keyof CreateSplitData, value: any) => {
    const newSplits = [...localSplits];

    // If changing category, adjust the amount sign based on income/expense
    if (field === 'categoryId' && value) {
      const category = categories.find(c => c.id === value);
      if (category) {
        const currentAmount = Number(newSplits[index].amount) || 0;
        if (currentAmount !== 0) {
          const absAmount = Math.abs(currentAmount);
          const newAmount = category.isIncome ? absAmount : -absAmount;
          if (newAmount !== currentAmount) {
            newSplits[index] = { ...newSplits[index], amount: newAmount };
          }
        }
      }
    }

    newSplits[index] = { ...newSplits[index], [field]: value };
    setLocalSplits(newSplits);
    onChange(newSplits);
  };

  const addSplit = () => {
    const newSplit: SplitRow = {
      id: `temp-${Date.now()}-${Math.random()}`,
      categoryId: undefined,
      amount: remaining, // Pre-fill with remaining amount
      memo: '',
    };
    const newSplits = [...localSplits, newSplit];
    setLocalSplits(newSplits);
    onChange(newSplits);
  };

  const removeSplit = (index: number) => {
    if (localSplits.length <= 2) {
      return; // Minimum 2 splits required
    }
    const newSplits = localSplits.filter((_, i) => i !== index);
    setLocalSplits(newSplits);
    onChange(newSplits);
  };

  const distributeEvenly = () => {
    if (localSplits.length === 0) return;

    const totalAmount = Number(transactionAmount);
    // Round each split to 2 decimal places (cents)
    const amountPerSplit = Math.round((totalAmount / localSplits.length) * 100) / 100;

    // Distribute evenly, put remainder on last split
    const newSplits = localSplits.map((split, index) => {
      if (index === localSplits.length - 1) {
        // Last split gets remainder to ensure exact sum
        const otherSplitsTotal = Math.round(amountPerSplit * (localSplits.length - 1) * 100) / 100;
        const lastAmount = Math.round((totalAmount - otherSplitsTotal) * 100) / 100;
        return { ...split, amount: lastAmount };
      }
      return { ...split, amount: amountPerSplit };
    });

    setLocalSplits(newSplits);
    onChange(newSplits);
  };

  // Add unassigned amount to a specific split
  const addRemainingToSplit = (index: number) => {
    if (Math.abs(remaining) < 0.01) return; // No remaining amount

    const newSplits = [...localSplits];
    const currentAmount = Number(newSplits[index].amount) || 0;
    newSplits[index] = { ...newSplits[index], amount: Math.round((currentAmount + remaining) * 100) / 100 };
    setLocalSplits(newSplits);
    onChange(newSplits);
  };

  // Set the transaction total to the sum of splits
  const setTotalToSplitsSum = () => {
    if (onTransactionAmountChange && splitsTotal !== 0) {
      onTransactionAmountChange(Math.round(splitsTotal * 100) / 100);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Split Details</h4>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={distributeEvenly}
          disabled={disabled || localSplits.length === 0}
        >
          Distribute Evenly
        </Button>
      </div>

      {/* Splits Table */}
      <div className="border dark:border-gray-700 rounded-lg overflow-visible">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800 rounded-t-lg">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                Category
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                Amount
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                Memo
              </th>
              <th className="px-4 py-2 w-24"></th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {localSplits.map((split, index) => {
              // Find current category name for initial display
              const currentCategory = split.categoryId
                ? categories.find(c => c.id === split.categoryId)
                : null;

              return (
              <tr key={split.id}>
                <td className="px-4 py-2">
                  <Combobox
                    placeholder="Select category..."
                    options={buildCategoryTree(categories).map(({ category }) => {
                      // Find parent category name for hierarchical display
                      const parentCategory = category.parentId
                        ? categories.find(c => c.id === category.parentId)
                        : null;
                      return {
                        value: category.id,
                        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
                      };
                    })}
                    value={split.categoryId || ''}
                    initialDisplayValue={currentCategory?.name || ''}
                    onChange={(categoryId) =>
                      handleSplitChange(index, 'categoryId', categoryId || undefined)
                    }
                    disabled={disabled}
                  />
                </td>
                <td className="px-4 py-2">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 text-sm">
                      {currencySymbol}
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      value={split.amount}
                      onChange={(e) =>
                        handleSplitChange(index, 'amount', parseFloat(e.target.value) || 0)
                      }
                      onBlur={(e) => {
                        // Round to 2 decimal places on blur
                        const rounded = Math.round(parseFloat(e.target.value) * 100) / 100;
                        if (!isNaN(rounded)) {
                          handleSplitChange(index, 'amount', rounded);
                        }
                      }}
                      disabled={disabled}
                      className="w-32 pl-7"
                    />
                  </div>
                </td>
                <td className="px-4 py-2">
                  <Input
                    type="text"
                    value={split.memo || ''}
                    onChange={(e) => handleSplitChange(index, 'memo', e.target.value)}
                    placeholder="Optional memo"
                    disabled={disabled}
                  />
                </td>
                <td className="px-4 py-2">
                  <div className="flex space-x-1">
                    <button
                      type="button"
                      onClick={() => addRemainingToSplit(index)}
                      disabled={disabled || Math.abs(remaining) < 0.01}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={Math.abs(remaining) < 0.01 ? 'No unassigned amount' : `Add ${remaining >= 0 ? '+' : ''}${currencySymbol}${Math.abs(remaining).toFixed(2)} to this split`}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeSplit(index)}
                      disabled={disabled || localSplits.length <= 2}
                      className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={localSplits.length <= 2 ? 'Minimum 2 splits required' : 'Remove split'}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            );
            })}
          </tbody>
          <tfoot className="bg-gray-50 dark:bg-gray-800">
            {/* Add Split Button Row */}
            <tr className="border-t border-gray-200 dark:border-gray-700">
              <td colSpan={4} className="p-0">
                <button
                  type="button"
                  onClick={addSplit}
                  disabled={disabled}
                  className="w-full px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-1"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  <span>Add Split</span>
                </button>
              </td>
            </tr>
            {/* Total Row */}
            <tr className="border-t border-gray-200 dark:border-gray-700">
              <td className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300">Total</td>
              <td className="px-4 py-2">
                <span
                  className={`font-medium ${
                    isBalanced ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {currencySymbol}{splitsTotal.toFixed(2)}
                </span>
                {!isBalanced && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                    (Remaining: {currencySymbol}{remaining.toFixed(2)})
                  </span>
                )}
              </td>
              <td colSpan={2} className="px-4 py-2">
                {isBalanced ? (
                  <span className="text-xs text-green-600 dark:text-green-400">Balanced</span>
                ) : (
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-red-600 dark:text-red-400">
                      Splits must equal transaction amount ({currencySymbol}{Number(transactionAmount).toFixed(2)})
                    </span>
                    {onTransactionAmountChange && splitsTotal !== 0 && (
                      <button
                        type="button"
                        onClick={setTotalToSplitsSum}
                        disabled={disabled}
                        className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline disabled:opacity-50"
                      >
                        Set total to {currencySymbol}{splitsTotal.toFixed(2)}
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// Helper function to generate temporary IDs for new splits
export function createEmptySplits(transactionAmount: number): SplitRow[] {
  const halfAmount = Math.round((Number(transactionAmount) / 2) * 10000) / 10000;
  const otherHalf = Number(transactionAmount) - halfAmount;

  return [
    {
      id: `temp-${Date.now()}-1`,
      categoryId: undefined,
      amount: halfAmount,
      memo: '',
    },
    {
      id: `temp-${Date.now()}-2`,
      categoryId: undefined,
      amount: otherHalf,
      memo: '',
    },
  ];
}

// Convert API splits to SplitRow format
export function toSplitRows(splits: { id?: string; categoryId?: string | null; amount: number; memo?: string | null }[]): SplitRow[] {
  return splits.map((split, index) => ({
    id: split.id || `temp-${Date.now()}-${index}`,
    categoryId: split.categoryId || undefined,
    amount: Number(split.amount),
    memo: split.memo || '',
  }));
}

// Convert SplitRow to API format (removes temporary id)
export function toCreateSplitData(splits: SplitRow[]): CreateSplitData[] {
  return splits.map((split) => ({
    categoryId: split.categoryId,
    amount: split.amount,
    memo: split.memo || undefined,
  }));
}
