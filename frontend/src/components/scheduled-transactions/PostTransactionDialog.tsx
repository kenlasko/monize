'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Combobox } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows } from '@/components/transactions/SplitEditor';
import { ScheduledTransaction, PostScheduledTransactionData } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents, getCurrencySymbol } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getProjectedBalanceAtDate, FutureTransaction } from '@/lib/forecast';

// Liability accounts normally carry negative balances — only warn if over credit limit
const LIABILITY_TYPES = new Set(['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT']);

function isLiabilityAccount(account: Account): boolean {
  return LIABILITY_TYPES.has(account.accountType);
}

/** Returns true when a projected balance should trigger a warning for the given account. */
function shouldWarnBalance(account: Account, projectedBalance: number): boolean {
  if (isLiabilityAccount(account)) {
    // Liability accounts: only warn if the balance exceeds the credit limit (if set)
    if (account.creditLimit != null && account.creditLimit > 0) {
      // Balance is negative, credit limit is positive — warn when balance is more negative than -creditLimit
      return projectedBalance < -account.creditLimit;
    }
    // No credit limit set — no warning for liability accounts
    return false;
  }
  // Asset accounts: warn if balance goes negative
  return projectedBalance < 0;
}

interface PostTransactionDialogProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  categories: Category[];
  accounts: Account[];
  scheduledTransactions: ScheduledTransaction[];
  futureTransactions: FutureTransaction[];
  onClose: () => void;
  onPosted: () => void;
}

export function PostTransactionDialog({
  isOpen,
  scheduledTransaction,
  categories,
  accounts,
  scheduledTransactions,
  futureTransactions,
  onClose,
  onPosted,
}: PostTransactionDialogProps) {
  const { formatCurrency } = useNumberFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [amount, setAmount] = useState<number>(0);
  const [categoryId, setCategoryId] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isSplit, setIsSplit] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);
  const [transactionDate, setTransactionDate] = useState<string>('');
  const [referenceNumber, setReferenceNumber] = useState<string>('');

  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const sourceAccount = scheduledTransaction.account
    ? accounts.find(a => a.id === scheduledTransaction.accountId) ?? scheduledTransaction.account
    : null;
  const transferAccount = scheduledTransaction.isTransfer && scheduledTransaction.transferAccount
    ? accounts.find(a => a.id === scheduledTransaction.transferAccountId) ?? scheduledTransaction.transferAccount
    : null;

  const projectedBalances = useMemo(() => {
    if (!transactionDate) return null;
    const sourceBefore = sourceAccount
      ? getProjectedBalanceAtDate(sourceAccount, transactionDate, scheduledTransactions, futureTransactions, scheduledTransaction.id)
      : null;
    const transferBefore = transferAccount
      ? getProjectedBalanceAtDate(transferAccount, transactionDate, scheduledTransactions, futureTransactions, scheduledTransaction.id)
      : null;
    return {
      sourceBefore,
      sourceAfter: sourceBefore != null ? roundToCents(sourceBefore + amount) : null,
      transferBefore,
      transferAfter: transferBefore != null ? roundToCents(transferBefore - amount) : null,
    };
  }, [sourceAccount, transferAccount, transactionDate, amount, scheduledTransactions, futureTransactions, scheduledTransaction.id]);

  // Initialize form with transaction values (including override if exists)
  useEffect(() => {
    if (isOpen) {
      const nextOverride = scheduledTransaction.nextOverride;

      // Use override values if they exist, otherwise use base transaction values
      const amt = roundToCents(
        nextOverride?.amount ?? scheduledTransaction.amount
      );
      setAmount(amt);
      setCategoryId(nextOverride?.categoryId ?? scheduledTransaction.categoryId ?? '');
      setDescription(nextOverride?.description ?? scheduledTransaction.description ?? '');
      setIsSplit(nextOverride?.isSplit ?? scheduledTransaction.isSplit);

      setReferenceNumber('');

      // Set transaction date: use override date if modified, otherwise next due date
      const nextDueDate = (nextOverride?.overrideDate ?? scheduledTransaction.nextDueDate).split('T')[0];
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
        referenceNumber: referenceNumber || undefined,
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
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to post transaction'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleAmountChange = (newAmount: number) => {
    setAmount(roundToCents(newAmount));
  };

  const currentCategory = categoryId ? categories.find(c => c.id === categoryId) : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="5xl" className="p-6">
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
        {scheduledTransaction.isTransfer ? (
          <>
            Post transfer "{scheduledTransaction.name}" from{' '}
            <span className="font-medium text-gray-700 dark:text-gray-300">{scheduledTransaction.account?.name}</span>
            {' '}to{' '}
            <span className="font-medium text-gray-700 dark:text-gray-300">{scheduledTransaction.transferAccount?.name}</span>.
          </>
        ) : (
          <>
            Post "{scheduledTransaction.name}" to {scheduledTransaction.account?.name}.
            Modify values below if needed for this posting only.
          </>
        )}
      </div>

      {/* Account balance info */}
      {projectedBalances && sourceAccount && (
        <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg p-3 mb-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">{sourceAccount.name}</span>
            <span className="text-gray-500 dark:text-gray-400">
              {formatCurrency(projectedBalances.sourceBefore!, scheduledTransaction.currencyCode)}
              {' → '}
              <span className={projectedBalances.sourceAfter! < projectedBalances.sourceBefore! ? 'text-red-600 dark:text-red-400 font-medium' : 'text-green-600 dark:text-green-400 font-medium'}>
                {formatCurrency(projectedBalances.sourceAfter!, scheduledTransaction.currencyCode)}
              </span>
            </span>
          </div>
          {transferAccount && projectedBalances.transferBefore != null && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">{transferAccount.name}</span>
              <span className="text-gray-500 dark:text-gray-400">
                {formatCurrency(projectedBalances.transferBefore, scheduledTransaction.currencyCode)}
                {' → '}
                <span className={projectedBalances.transferAfter! > projectedBalances.transferBefore ? 'text-green-600 dark:text-green-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
                  {formatCurrency(projectedBalances.transferAfter!, scheduledTransaction.currencyCode)}
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Balance warning — for asset accounts: below zero; for liability accounts: over credit limit */}
      {(() => {
        if (!projectedBalances) return null;
        const sourceWarn = sourceAccount && projectedBalances.sourceAfter != null && shouldWarnBalance(sourceAccount, projectedBalances.sourceAfter);
        const transferWarn = transferAccount && projectedBalances.transferAfter != null && shouldWarnBalance(transferAccount, projectedBalances.transferAfter);
        if (!sourceWarn && !transferWarn) return null;

        const warningLabel = (account: Account) =>
          isLiabilityAccount(account) ? 'over the credit limit' : 'below zero';

        return (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg p-3 mb-4 flex items-start gap-2">
            <svg className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="text-sm text-amber-700 dark:text-amber-300">
              {sourceWarn && transferWarn ? (
                <>
                  Posting on this date will bring <span className="font-medium">{sourceAccount?.name}</span> to{' '}
                  <span className="font-medium">{formatCurrency(projectedBalances.sourceAfter!, scheduledTransaction.currencyCode)}</span> ({warningLabel(sourceAccount!)}) and{' '}
                  <span className="font-medium">{transferAccount?.name}</span> to{' '}
                  <span className="font-medium">{formatCurrency(projectedBalances.transferAfter!, scheduledTransaction.currencyCode)}</span> ({warningLabel(transferAccount!)}).
                </>
              ) : sourceWarn ? (
                <>
                  Posting on this date will bring <span className="font-medium">{sourceAccount?.name}</span> to{' '}
                  <span className="font-medium">{formatCurrency(projectedBalances.sourceAfter!, scheduledTransaction.currencyCode)}</span>, {warningLabel(sourceAccount!)}.
                </>
              ) : (
                <>
                  Posting on this date will bring <span className="font-medium">{transferAccount?.name}</span> to{' '}
                  <span className="font-medium">{formatCurrency(projectedBalances.transferAfter!, scheduledTransaction.currencyCode)}</span>, {warningLabel(transferAccount!)}.
                </>
              )}
            </div>
          </div>
        );
      })()}

      <div className="space-y-4">
        {/* Transaction Date */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Transaction Date
          </label>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
            />
            {transactionDate !== todayStr && (
              <button
                type="button"
                onClick={() => setTransactionDate(todayStr)}
                className="shrink-0 px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
              >
                Today
              </button>
            )}
          </div>
        </div>

        {/* Amount */}
        <CurrencyInput
          label="Amount"
          prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
          value={amount}
          onChange={(value) => setAmount(value ?? 0)}
        />

        {/* Transfer indicator - shown instead of category for transfers */}
        {scheduledTransaction.isTransfer ? (
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg p-4">
            <div className="flex items-center">
              <svg className="h-5 w-5 text-blue-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                Transfer: {scheduledTransaction.account?.name} → {scheduledTransaction.transferAccount?.name}
              </span>
            </div>
          </div>
        ) : (
          <>
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
          </>
        )}

        {/* Description and Reference Number */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Reference Number (optional)
            </label>
            <Input
              type="text"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="Cheque #, confirmation #..."
            />
          </div>
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
    </Modal>
  );
}
