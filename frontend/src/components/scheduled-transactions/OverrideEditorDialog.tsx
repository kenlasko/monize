'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Combobox } from '@/components/ui/Combobox';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows } from '@/components/transactions/SplitEditor';
import { ScheduledTransaction, ScheduledTransactionOverride, CreateScheduledTransactionOverrideData } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents } from '@/lib/format';
import { useDateFormat } from '@/hooks/useDateFormat';

interface OverrideEditorDialogProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  overrideDate: string;
  categories: Category[];
  accounts: Account[];
  existingOverride?: ScheduledTransactionOverride | null;
  onClose: () => void;
  onSave: () => void;
}

export function OverrideEditorDialog({
  isOpen,
  scheduledTransaction,
  overrideDate,
  categories,
  accounts,
  existingOverride,
  onClose,
  onSave,
}: OverrideEditorDialogProps) {
  const { formatDate } = useDateFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [amount, setAmount] = useState<number>(0);
  const [categoryId, setCategoryId] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isSplit, setIsSplit] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);

  // Initialize form with base transaction or existing override values
  useEffect(() => {
    if (isOpen) {
      if (existingOverride) {
        // Use override values
        const amt = roundToCents(existingOverride.amount ?? scheduledTransaction.amount);
        setAmount(amt);
        setCategoryId(existingOverride.categoryId ?? scheduledTransaction.categoryId ?? '');
        setDescription(existingOverride.description ?? scheduledTransaction.description ?? '');
        setIsSplit(existingOverride.isSplit ?? scheduledTransaction.isSplit);
        if (existingOverride.isSplit && existingOverride.splits) {
          setSplits(toSplitRows(existingOverride.splits.map((s, i) => ({
            id: `override-${i}`,
            ...s,
          }))));
        } else if (scheduledTransaction.isSplit && scheduledTransaction.splits) {
          setSplits(toSplitRows(scheduledTransaction.splits));
        } else {
          setSplits(createEmptySplits(amt));
        }
      } else {
        // Use base transaction values
        const amt = roundToCents(scheduledTransaction.amount);
        setAmount(amt);
        setCategoryId(scheduledTransaction.categoryId ?? '');
        setDescription(scheduledTransaction.description ?? '');
        setIsSplit(scheduledTransaction.isSplit);
        if (scheduledTransaction.isSplit && scheduledTransaction.splits) {
          setSplits(toSplitRows(scheduledTransaction.splits));
        } else {
          setSplits(createEmptySplits(amt));
        }
      }
    }
  }, [isOpen, existingOverride, scheduledTransaction]);

  const categoryOptions = useMemo(() => {
    return buildCategoryTree(categories).map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    });
  }, [categories]);

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const baseData = {
        amount,
        categoryId: isSplit ? null : (categoryId || null),
        description: description || null,
        isSplit,
        splits: isSplit ? splits.map(s => ({
          categoryId: s.splitType === 'category' ? (s.categoryId ?? null) : null,
          transferAccountId: s.splitType === 'transfer' ? (s.transferAccountId ?? null) : null,
          amount: s.amount,
          memo: s.memo ?? null,
        })) : null,
      };

      if (existingOverride) {
        // Update doesn't include overrideDate - it's immutable
        await scheduledTransactionsApi.updateOverride(
          scheduledTransaction.id,
          existingOverride.id,
          baseData,
        );
        toast.success('Override updated');
      } else {
        // Create includes overrideDate
        await scheduledTransactionsApi.createOverride(scheduledTransaction.id, {
          ...baseData,
          overrideDate,
        });
        toast.success('Override created');
      }
      onSave();
      onClose();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to save override';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!existingOverride) return;

    setIsLoading(true);
    try {
      await scheduledTransactionsApi.deleteOverride(scheduledTransaction.id, existingOverride.id);
      toast.success('Override deleted - will use base values');
      onSave();
      onClose();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to delete override';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  // Handler for SplitEditor to update amount
  const handleAmountChange = (newAmount: number) => {
    setAmount(roundToCents(newAmount));
  };

  if (!isOpen) return null;

  const currentCategory = categoryId ? categories.find(c => c.id === categoryId) : null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75" onClick={onClose} />

        {/* Modal */}
        <div className="inline-block w-full max-w-5xl px-4 pt-5 pb-4 overflow-hidden text-left align-bottom transition-all transform bg-white dark:bg-gray-800 rounded-lg shadow-xl sm:my-8 sm:align-middle sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
              Edit Occurrence: {formatDate(overrideDate)}
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Modifying "{scheduledTransaction.name}" for {formatDate(overrideDate)} only.
            {existingOverride && (
              <span className="ml-1 text-blue-600 dark:text-blue-400">(Override exists)</span>
            )}
          </div>

          <div className="space-y-4">
            {/* Amount */}
            <CurrencyInput
              label="Amount"
              prefix="$"
              value={amount}
              onChange={(value) => setAmount(value ?? 0)}
            />

            {/* Split toggle */}
            <div className="flex items-center">
              <input
                type="checkbox"
                id="isSplit"
                checked={isSplit}
                onChange={(e) => {
                  setIsSplit(e.target.checked);
                  if (e.target.checked && splits.length < 2) {
                    setSplits(createEmptySplits(amount));
                  }
                }}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="isSplit" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                Split this occurrence
              </label>
            </div>

            {/* Category or Splits */}
            {isSplit ? (
              <SplitEditor
                splits={splits}
                onChange={setSplits}
                categories={categories}
                accounts={accounts}
                sourceAccountId={scheduledTransaction.accountId}
                transactionAmount={amount}
                onTransactionAmountChange={handleAmountChange}
                currencyCode={scheduledTransaction.currencyCode}
              />
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Category
                </label>
                <Combobox
                  placeholder="Select category..."
                  options={categoryOptions}
                  value={categoryId}
                  initialDisplayValue={currentCategory?.name || ''}
                  onChange={(value) => setCategoryId(value || '')}
                />
              </div>
            )}

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description (optional)
              </label>
              <Input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Override description..."
              />
            </div>
          </div>

          {/* Actions */}
          <div className="mt-6 flex justify-between">
            <div>
              {existingOverride && (
                <Button
                  variant="outline"
                  onClick={handleDelete}
                  isLoading={isLoading}
                  className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/50"
                >
                  Reset to Default
                </Button>
              )}
            </div>
            <div className="flex space-x-3">
              <Button variant="outline" onClick={onClose} disabled={isLoading}>
                Cancel
              </Button>
              <Button onClick={handleSave} isLoading={isLoading}>
                {existingOverride ? 'Update Override' : 'Save Override'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
