'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows } from '@/components/transactions/SplitEditor';
import { ScheduledTransaction, PostScheduledTransactionData } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { useDateFormat } from '@/hooks/useDateFormat';

interface PostTransactionDialogProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  categories: Category[];
  accounts: Account[];
  onClose: () => void;
  onPosted: () => void;
}

export function PostTransactionDialog({
  isOpen,
  scheduledTransaction,
  categories,
  accounts,
  onClose,
  onPosted,
}: PostTransactionDialogProps) {
  const { formatDate } = useDateFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [amount, setAmount] = useState<number>(0);
  const [amountDisplay, setAmountDisplay] = useState<string>('0.00');
  const [categoryId, setCategoryId] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isSplit, setIsSplit] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);
  const [transactionDate, setTransactionDate] = useState<string>('');

  // Helper to round to 2 decimal places
  const roundTo2Decimals = (value: number) => Math.round(value * 100) / 100;

  // Initialize form with transaction values (including override if exists)
  useEffect(() => {
    if (isOpen) {
      const nextOverride = scheduledTransaction.nextOverride;

      // Use override values if they exist, otherwise use base transaction values
      const amt = roundTo2Decimals(
        nextOverride?.amount ?? scheduledTransaction.amount
      );
      setAmount(amt);
      setAmountDisplay(amt.toFixed(2));
      setCategoryId(nextOverride?.categoryId ?? scheduledTransaction.categoryId ?? '');
      setDescription(nextOverride?.description ?? scheduledTransaction.description ?? '');
      setIsSplit(nextOverride?.isSplit ?? scheduledTransaction.isSplit);

      // Set transaction date to next due date
      const nextDueDate = scheduledTransaction.nextDueDate.split('T')[0];
      setTransactionDate(nextDueDate);

      // Initialize splits
      if ((nextOverride?.isSplit ?? scheduledTransaction.isSplit)) {
        if (nextOverride?.splits && nextOverride.splits.length > 0) {
          setSplits(toSplitRows(nextOverride.splits.map((s, i) => ({
            id: `override-${i}`,
            ...s,
          }))));
        } else if (scheduledTransaction.splits && scheduledTransaction.splits.length > 0) {
          setSplits(toSplitRows(scheduledTransaction.splits));
        } else {
          setSplits(createEmptySplits(amt));
        }
      } else {
        setSplits(createEmptySplits(amt));
      }
    }
  }, [isOpen, scheduledTransaction]);

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

  const handlePost = async () => {
    // Validate splits if in split mode
    if (isSplit) {
      if (splits.length < 2) {
        toast.error('Split transactions require at least 2 splits');
        return;
      }
      const splitsTotal = splits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
      const remaining = Math.abs(amount - splitsTotal);
      if (remaining >= 0.01) {
        toast.error('Split amounts must equal the transaction amount');
        return;
      }
    }

    setIsLoading(true);
    try {
      const postData: PostScheduledTransactionData = {
        transactionDate,
        amount,
        categoryId: isSplit ? null : (categoryId || null),
        description: description || null,
        isSplit,
        splits: isSplit ? splits.map(s => ({
          categoryId: s.splitType === 'category' ? (s.categoryId ?? null) : null,
          transferAccountId: s.splitType === 'transfer' ? (s.transferAccountId ?? null) : null,
          amount: s.amount,
          memo: s.memo ?? null,
        })) : undefined,
      };

      await scheduledTransactionsApi.post(scheduledTransaction.id, postData);
      toast.success('Transaction posted');
      onPosted();
      onClose();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to post transaction';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAmountDisplayChange = (displayValue: string) => {
    const filtered = displayValue.replace(/[^0-9.-]/g, '');
    setAmountDisplay(filtered);
    const numericValue = parseFloat(filtered) || 0;
    setAmount(roundTo2Decimals(numericValue));
  };

  const handleAmountBlur = () => {
    const numericValue = roundTo2Decimals(parseFloat(amountDisplay) || 0);
    setAmount(numericValue);
    setAmountDisplay(numericValue.toFixed(2));
  };

  const handleAmountChange = (newAmount: number) => {
    const rounded = roundTo2Decimals(newAmount);
    setAmount(rounded);
    setAmountDisplay(rounded.toFixed(2));
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
              Post Transaction
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
            Post "{scheduledTransaction.name}" to {scheduledTransaction.account?.name}.
            Modify values below if needed for this posting only.
          </div>

          <div className="space-y-4">
            {/* Transaction Date */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Transaction Date
              </label>
              <Input
                type="date"
                value={transactionDate}
                onChange={(e) => setTransactionDate(e.target.value)}
              />
            </div>

            {/* Amount */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Amount
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
                  $
                </span>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={amountDisplay}
                  onChange={(e) => handleAmountDisplayChange(e.target.value)}
                  onBlur={handleAmountBlur}
                  className="pl-7"
                />
              </div>
            </div>

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
                Split this transaction
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
                placeholder="Description..."
              />
            </div>
          </div>

          {/* Actions */}
          <div className="mt-6 flex justify-end space-x-3">
            <Button variant="outline" onClick={onClose} disabled={isLoading}>
              Cancel
            </Button>
            <Button onClick={handlePost} isLoading={isLoading}>
              Post Transaction
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
