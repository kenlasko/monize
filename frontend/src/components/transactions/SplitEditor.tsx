'use client';

import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Category } from '@/types/category';
import { CreateSplitData } from '@/types/transaction';

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
}

export function SplitEditor({
  splits,
  onChange,
  categories,
  transactionAmount,
  disabled = false,
  onTransactionAmountChange,
}: SplitEditorProps) {
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
        <h4 className="text-sm font-medium text-gray-700">Split Details</h4>
        <div className="flex space-x-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={distributeEvenly}
            disabled={disabled || localSplits.length === 0}
          >
            Distribute Evenly
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addSplit}
            disabled={disabled}
          >
            + Add Split
          </Button>
        </div>
      </div>

      {/* Splits Table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Category
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Amount
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Memo
              </th>
              <th className="px-4 py-2 w-24"></th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {localSplits.map((split, index) => (
              <tr key={split.id}>
                <td className="px-4 py-2">
                  <Select
                    options={[
                      { value: '', label: 'Uncategorized' },
                      ...categories.map((cat) => ({
                        value: cat.id,
                        label: cat.name,
                      })),
                    ]}
                    value={split.categoryId || ''}
                    onChange={(e) =>
                      handleSplitChange(index, 'categoryId', e.target.value || undefined)
                    }
                    disabled={disabled}
                  />
                </td>
                <td className="px-4 py-2">
                  <Input
                    type="number"
                    step="0.01"
                    value={split.amount}
                    onChange={(e) =>
                      handleSplitChange(index, 'amount', parseFloat(e.target.value) || 0)
                    }
                    disabled={disabled}
                    className="w-32"
                  />
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
                      className="text-blue-600 hover:text-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={Math.abs(remaining) < 0.01 ? 'No unassigned amount' : `Add ${remaining >= 0 ? '+' : ''}${remaining.toFixed(2)} to this split`}
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
                      className="text-red-600 hover:text-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
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
            ))}
          </tbody>
          <tfoot className="bg-gray-50">
            <tr>
              <td className="px-4 py-2 text-sm font-medium text-gray-700">Total</td>
              <td className="px-4 py-2">
                <span
                  className={`font-medium ${
                    isBalanced ? 'text-green-600' : 'text-red-600'
                  }`}
                >
                  ${splitsTotal.toFixed(2)}
                </span>
                {!isBalanced && (
                  <span className="text-xs text-gray-500 ml-2">
                    (Remaining: ${remaining.toFixed(2)})
                  </span>
                )}
              </td>
              <td colSpan={2} className="px-4 py-2">
                {isBalanced ? (
                  <span className="text-xs text-green-600">Balanced</span>
                ) : (
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-red-600">
                      Splits must equal transaction amount (${transactionAmount})
                    </span>
                    {onTransactionAmountChange && splitsTotal !== 0 && (
                      <button
                        type="button"
                        onClick={setTotalToSplitsSum}
                        disabled={disabled}
                        className="text-xs text-blue-600 hover:text-blue-800 underline disabled:opacity-50"
                      >
                        Set total to ${splitsTotal.toFixed(2)}
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
