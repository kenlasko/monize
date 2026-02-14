'use client';

import { useState, useEffect, useMemo } from 'react';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { CreateSplitData } from '@/types/transaction';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents, getCurrencySymbol } from '@/lib/format';

export type SplitType = 'category' | 'transfer';

export interface SplitRow extends CreateSplitData {
  id: string; // Temporary ID for React keys
  splitType: SplitType;
}

interface SplitEditorProps {
  splits: SplitRow[];
  onChange: (splits: SplitRow[]) => void;
  categories: Category[];
  accounts?: Account[];
  sourceAccountId?: string;
  transactionAmount: number;
  disabled?: boolean;
  onTransactionAmountChange?: (amount: number) => void;
  currencyCode?: string;
}

export function SplitEditor({
  splits,
  onChange,
  categories,
  accounts = [],
  sourceAccountId = '',
  transactionAmount,
  disabled = false,
  onTransactionAmountChange,
  currencyCode = 'CAD',
}: SplitEditorProps) {
  const currencySymbol = getCurrencySymbol(currencyCode);
  const [localSplits, setLocalSplits] = useState<SplitRow[]>(splits);

  // Transfer support is only available when accounts are provided
  const supportsTransfers = accounts.length > 0 && sourceAccountId;

  // Memoize category options to avoid rebuilding on every render
  const categoryOptions = useMemo(() => buildCategoryTree(categories).map(({ category }) => {
    const parentCategory = category.parentId
      ? categories.find(c => c.id === category.parentId)
      : null;
    return {
      value: category.id,
      label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
    };
  }), [categories]);

  // Memoize account options (excluding source account, asset accounts, investment accounts, and closed accounts, sorted alphabetically)
  const accountOptions = useMemo(() => {
    if (!supportsTransfers) return [];
    return accounts
      .filter(a =>
        !a.isClosed &&
        a.id !== sourceAccountId &&
        a.accountSubType !== 'INVESTMENT_BROKERAGE'
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(a => ({
        value: a.id,
        label: a.name,
      }));
  }, [accounts, sourceAccountId, supportsTransfers]);

  // Sync with parent when splits prop changes
  useEffect(() => {
    setLocalSplits(splits);
  }, [splits]);

  const splitsTotal = localSplits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const remaining = Number(transactionAmount) - splitsTotal;
  const isBalanced = Math.abs(remaining) < 0.01;

  const handleSplitChange = (index: number, field: keyof SplitRow, value: any) => {
    const newSplits = [...localSplits];

    // If changing split type, clear the other field
    if (field === 'splitType') {
      if (value === 'category') {
        newSplits[index] = { ...newSplits[index], splitType: 'category', transferAccountId: undefined };
      } else {
        newSplits[index] = { ...newSplits[index], splitType: 'transfer', categoryId: undefined };
      }
      setLocalSplits(newSplits);
      onChange(newSplits);
      return;
    }

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

    // If changing amount, adjust sign based on selected category
    if (field === 'amount') {
      const categoryId = newSplits[index].categoryId;
      if (categoryId) {
        const category = categories.find(c => c.id === categoryId);
        if (category) {
          const newAmount = Number(value) || 0;
          if (newAmount !== 0) {
            const absAmount = Math.abs(newAmount);
            value = category.isIncome ? absAmount : -absAmount;
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
      splitType: 'category',
      categoryId: undefined,
      transferAccountId: undefined,
      amount: Math.round(remaining * 100) / 100, // Pre-fill with remaining amount, rounded to 2 decimals
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

  // Distribute remaining amount proportionally across all splits based on their current amounts
  const distributeProportionally = () => {
    if (localSplits.length === 0 || Math.abs(remaining) < 0.01) return;

    const absTotal = localSplits.reduce((sum, s) => sum + Math.abs(Number(s.amount) || 0), 0);

    // If all splits are zero, fall back to equal distribution
    if (absTotal < 0.01) {
      const perSplit = Math.round((remaining / localSplits.length) * 100) / 100;
      const newSplits = localSplits.map((split, index) => {
        const currentAmount = Number(split.amount) || 0;
        if (index === localSplits.length - 1) {
          const distributed = Math.round(perSplit * (localSplits.length - 1) * 100) / 100;
          const lastPortion = Math.round((remaining - distributed) * 100) / 100;
          return { ...split, amount: Math.round((currentAmount + lastPortion) * 100) / 100 };
        }
        return { ...split, amount: Math.round((currentAmount + perSplit) * 100) / 100 };
      });
      setLocalSplits(newSplits);
      onChange(newSplits);
      return;
    }

    let distributedSoFar = 0;
    const newSplits = localSplits.map((split, index) => {
      const currentAmount = Number(split.amount) || 0;
      const proportion = Math.abs(currentAmount) / absTotal;

      if (index === localSplits.length - 1) {
        // Last split absorbs rounding remainder
        const lastPortion = Math.round((remaining - distributedSoFar) * 100) / 100;
        return { ...split, amount: Math.round((currentAmount + lastPortion) * 100) / 100 };
      }

      const portion = Math.round(remaining * proportion * 100) / 100;
      distributedSoFar += portion;
      return { ...split, amount: Math.round((currentAmount + portion) * 100) / 100 };
    });

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
      <div className="flex justify-between items-center gap-2">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Split Details</h4>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={distributeProportionally}
            disabled={disabled || localSplits.length === 0 || Math.abs(remaining) < 0.01}
            title="Distribute the remaining amount proportionally based on each split's amount"
          >
            Distribute Proportionally
          </Button>
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
      </div>

      {/* Splits — Mobile Card Layout */}
      <div className="md:hidden border dark:border-gray-700 rounded-lg overflow-visible">
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {localSplits.map((split, index) => {
            const currentCategory = split.categoryId
              ? categories.find(c => c.id === split.categoryId)
              : null;

            return (
              <div key={split.id} className="p-3 space-y-2 bg-white dark:bg-gray-900">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Split {index + 1}</span>
                  <div className="flex space-x-1">
                    <button
                      type="button"
                      onClick={() => addRemainingToSplit(index)}
                      disabled={disabled || Math.abs(remaining) < 0.01}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={Math.abs(remaining) < 0.01 ? 'No unassigned amount' : `Add remaining to this split`}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
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
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
                {supportsTransfers && (
                  <Select
                    options={[
                      { value: 'category', label: 'Category' },
                      { value: 'transfer', label: 'Transfer' },
                    ]}
                    value={split.splitType}
                    onChange={(e) => handleSplitChange(index, 'splitType', e.target.value)}
                    disabled={disabled}
                    className="w-full"
                  />
                )}
                {split.splitType === 'category' || !supportsTransfers ? (
                  <Combobox
                    placeholder="Select category..."
                    options={categoryOptions}
                    value={split.categoryId || ''}
                    initialDisplayValue={currentCategory?.name || ''}
                    onChange={(categoryId) =>
                      handleSplitChange(index, 'categoryId', categoryId || undefined)
                    }
                    disabled={disabled}
                  />
                ) : (
                  <Select
                    options={[
                      { value: '', label: 'Select account...' },
                      ...accountOptions,
                    ]}
                    value={split.transferAccountId || ''}
                    onChange={(e) =>
                      handleSplitChange(index, 'transferAccountId', e.target.value || undefined)
                    }
                    disabled={disabled}
                    className="w-full"
                  />
                )}
                <div className="grid grid-cols-2 gap-2">
                  <CurrencyInput
                    prefix={currencySymbol}
                    value={split.amount}
                    onChange={(value) => handleSplitChange(index, 'amount', roundToCents(value ?? 0))}
                    disabled={disabled}
                    className="w-full"
                  />
                  <Input
                    type="text"
                    value={split.memo || ''}
                    onChange={(e) => handleSplitChange(index, 'memo', e.target.value)}
                    placeholder="Memo"
                    disabled={disabled}
                    className="w-full"
                  />
                </div>
              </div>
            );
          })}
        </div>
        {/* Add Split + Total */}
        <div className="bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={addSplit}
            disabled={disabled}
            className="w-full px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-1"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            <span>Add Split</span>
          </button>
          <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between flex-wrap gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Total</span>
                <span className={`font-medium ${isBalanced ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {currencySymbol}{splitsTotal.toFixed(2)}
                </span>
                {isBalanced ? (
                  <span className="text-xs text-green-600 dark:text-green-400">Balanced</span>
                ) : (
                  <span className="text-xs text-red-600 dark:text-red-400">
                    Remaining: {currencySymbol}{remaining.toFixed(2)}
                  </span>
                )}
              </div>
              {!isBalanced && onTransactionAmountChange && splitsTotal !== 0 && (
                <button
                  type="button"
                  onClick={setTotalToSplitsSum}
                  disabled={disabled}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline disabled:opacity-50 whitespace-nowrap"
                >
                  Set total to {currencySymbol}{splitsTotal.toFixed(2)}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Splits — Desktop Table Layout */}
      <div className="hidden md:block border dark:border-gray-700 rounded-lg overflow-visible">
        <table className="w-full table-fixed divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800 rounded-t-lg">
            <tr>
              {supportsTransfers && (
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: '17%' }}>
                  Type
                </th>
              )}
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: supportsTransfers ? '33%' : '45%' }}>
                {supportsTransfers ? 'Category / Account' : 'Category'}
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: '15%' }}>
                Amount
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: supportsTransfers ? '30%' : '35%' }}>
                Memo
              </th>
              <th className="px-3 py-2" style={{ width: '5%' }}></th>
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
                {supportsTransfers && (
                  <td className="px-3 py-2">
                    <Select
                      options={[
                        { value: 'category', label: 'Category' },
                        { value: 'transfer', label: 'Transfer' },
                      ]}
                      value={split.splitType}
                      onChange={(e) => handleSplitChange(index, 'splitType', e.target.value)}
                      disabled={disabled}
                      className="w-full"
                    />
                  </td>
                )}
                <td className="px-3 py-2">
                  {split.splitType === 'category' || !supportsTransfers ? (
                    <Combobox
                      placeholder="Select category..."
                      options={categoryOptions}
                      value={split.categoryId || ''}
                      initialDisplayValue={currentCategory?.name || ''}
                      onChange={(categoryId) =>
                        handleSplitChange(index, 'categoryId', categoryId || undefined)
                      }
                      disabled={disabled}
                    />
                  ) : (
                    <Select
                      options={[
                        { value: '', label: 'Select account...' },
                        ...accountOptions,
                      ]}
                      value={split.transferAccountId || ''}
                      onChange={(e) =>
                        handleSplitChange(index, 'transferAccountId', e.target.value || undefined)
                      }
                      disabled={disabled}
                      className="w-full"
                    />
                  )}
                </td>
                <td className="px-3 py-2">
                  <CurrencyInput
                    prefix={currencySymbol}
                    value={split.amount}
                    onChange={(value) => handleSplitChange(index, 'amount', roundToCents(value ?? 0))}
                    disabled={disabled}
                    className="w-full"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="text"
                    value={split.memo || ''}
                    onChange={(e) => handleSplitChange(index, 'memo', e.target.value)}
                    placeholder="Optional memo"
                    disabled={disabled}
                    className="w-full"
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex space-x-1 justify-end">
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
              <td colSpan={supportsTransfers ? 5 : 4} className="p-0">
                <button
                  type="button"
                  onClick={addSplit}
                  disabled={disabled}
                  className="w-full px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-1"
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
              <td colSpan={supportsTransfers ? 5 : 4} className="px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Total</span>
                    <span
                      className={`font-medium ${
                        isBalanced ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {currencySymbol}{splitsTotal.toFixed(2)}
                    </span>
                    {isBalanced ? (
                      <span className="text-xs text-green-600 dark:text-green-400">Balanced</span>
                    ) : (
                      <span className="text-xs text-red-600 dark:text-red-400 whitespace-nowrap">
                        Need {currencySymbol}{Number(transactionAmount).toFixed(2)} (remaining: {currencySymbol}{remaining.toFixed(2)})
                      </span>
                    )}
                  </div>
                  {!isBalanced && onTransactionAmountChange && splitsTotal !== 0 && (
                    <button
                      type="button"
                      onClick={setTotalToSplitsSum}
                      disabled={disabled}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline disabled:opacity-50 whitespace-nowrap"
                    >
                      Set total to {currencySymbol}{splitsTotal.toFixed(2)}
                    </button>
                  )}
                </div>
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
  const halfAmount = Math.round((Number(transactionAmount) / 2) * 100) / 100;
  const otherHalf = Math.round((Number(transactionAmount) - halfAmount) * 100) / 100;

  return [
    {
      id: `temp-${Date.now()}-1`,
      splitType: 'category',
      categoryId: undefined,
      transferAccountId: undefined,
      amount: halfAmount,
      memo: '',
    },
    {
      id: `temp-${Date.now()}-2`,
      splitType: 'category',
      categoryId: undefined,
      transferAccountId: undefined,
      amount: otherHalf,
      memo: '',
    },
  ];
}

// Convert API splits to SplitRow format
export function toSplitRows(splits: { id?: string; categoryId?: string | null; transferAccountId?: string | null; amount: number; memo?: string | null }[]): SplitRow[] {
  return splits.map((split, index) => ({
    id: split.id || `temp-${Date.now()}-${index}`,
    splitType: split.transferAccountId ? 'transfer' : 'category',
    categoryId: split.categoryId || undefined,
    transferAccountId: split.transferAccountId || undefined,
    amount: Number(split.amount),
    memo: split.memo || '',
  }));
}

// Convert SplitRow to API format (removes temporary id and splitType)
export function toCreateSplitData(splits: SplitRow[]): CreateSplitData[] {
  return splits.map((split) => ({
    categoryId: split.splitType === 'category' ? split.categoryId : undefined,
    transferAccountId: split.splitType === 'transfer' ? split.transferAccountId : undefined,
    amount: split.amount,
    memo: split.memo || undefined,
  }));
}
