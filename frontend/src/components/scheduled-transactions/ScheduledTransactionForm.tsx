'use client';

import { useState, useEffect, MutableRefObject } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zodResolver';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows, toCreateSplitData } from '@/components/transactions/SplitEditor';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { accountsApi } from '@/lib/accounts';
import { ScheduledTransaction, FrequencyType, FREQUENCY_LABELS } from '@/types/scheduled-transaction';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents, getCurrencySymbol } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';

const logger = createLogger('ScheduledTxForm');

const optionalUuid = z.preprocess(
  (val) => (val === '' ? undefined : val),
  z.string().uuid().optional()
);

const optionalString = z.preprocess(
  (val) => (val === '' ? undefined : val),
  z.string().optional()
);

const optionalNumber = z.preprocess(
  (val) => (val === '' || val === undefined || val === null ? undefined : val),
  z.number().optional()
);

const scheduledTransactionSchema = z.object({
  accountId: z.string().uuid('Please select an account'),
  name: z.string().min(1, 'Name is required'),
  payeeId: optionalUuid,
  payeeName: optionalString,
  categoryId: optionalUuid,
  amount: z.number({ error: 'Amount is required' }),
  currencyCode: z.string().default('CAD'),
  description: optionalString,
  frequency: z.enum(['ONCE', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
  nextDueDate: z.string().min(1, 'Due date is required'),
  endDate: optionalString,
  occurrencesRemaining: optionalNumber,
  isActive: z.boolean().default(true),
  autoPost: z.boolean().default(false),
  reminderDaysBefore: z.number().min(0).default(3),
});

type ScheduledTransactionFormData = z.infer<typeof scheduledTransactionSchema>;

interface ScheduledTransactionFormProps {
  scheduledTransaction?: ScheduledTransaction;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

// Determine if an existing scheduled transaction is a transfer
function isScheduledTransfer(st?: ScheduledTransaction): boolean {
  if (!st) return false;
  return st.isTransfer && st.transferAccountId != null;
}

// Get the transfer destination account ID from an existing transfer
function getTransferAccountId(st?: ScheduledTransaction): string {
  return st?.transferAccountId || '';
}

export function ScheduledTransactionForm({
  scheduledTransaction,
  onSuccess,
  onCancel,
  onDirtyChange,
  submitRef,
}: ScheduledTransactionFormProps) {
  const { defaultCurrency } = useNumberFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [allPayees, setAllPayees] = useState<Payee[]>([]);

  // Transaction type: 'payment' for bills/deposits, 'transfer' for account transfers
  const [transactionType, setTransactionType] = useState<'payment' | 'transfer'>(
    isScheduledTransfer(scheduledTransaction) ? 'transfer' : 'payment'
  );
  const [transferToAccountId, setTransferToAccountId] = useState<string>(
    getTransferAccountId(scheduledTransaction)
  );

  const [selectedPayeeId, setSelectedPayeeId] = useState<string>(
    scheduledTransaction?.payeeId || ''
  );
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    scheduledTransaction?.categoryId || ''
  );
  const [useEndDate, setUseEndDate] = useState<boolean>(!!scheduledTransaction?.endDate);
  const [useOccurrences, setUseOccurrences] = useState<boolean>(
    scheduledTransaction?.occurrencesRemaining !== null &&
    scheduledTransaction?.occurrencesRemaining !== undefined
  );
  const [isSplit, setIsSplit] = useState<boolean>(
    scheduledTransaction?.isSplit && !isScheduledTransfer(scheduledTransaction) || false
  );
  const [splits, setSplits] = useState<SplitRow[]>(
    scheduledTransaction?.splits && scheduledTransaction.splits.length > 0 && !isScheduledTransfer(scheduledTransaction)
      ? toSplitRows(scheduledTransaction.splits)
      : []
  );

  // Helper to round to 2 decimal places
  // Note: CurrencyInput handles display state and rounding internally

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<ScheduledTransactionFormData>({
    resolver: zodResolver(scheduledTransactionSchema),
    defaultValues: scheduledTransaction
      ? {
          accountId: scheduledTransaction.accountId,
          name: scheduledTransaction.name,
          payeeId: scheduledTransaction.payeeId || '',
          payeeName: scheduledTransaction.payeeName || '',
          categoryId: scheduledTransaction.categoryId || '',
          amount: isScheduledTransfer(scheduledTransaction)
            ? Math.abs(Math.round(Number(scheduledTransaction.amount) * 100) / 100)
            : Math.round(Number(scheduledTransaction.amount) * 100) / 100,
          currencyCode: scheduledTransaction.currencyCode,
          description: scheduledTransaction.description || '',
          frequency: scheduledTransaction.frequency,
          nextDueDate: scheduledTransaction.nextDueDate.split('T')[0],
          endDate: scheduledTransaction.endDate?.split('T')[0] || '',
          occurrencesRemaining: scheduledTransaction.occurrencesRemaining ?? undefined,
          isActive: scheduledTransaction.isActive,
          autoPost: scheduledTransaction.autoPost,
          reminderDaysBefore: scheduledTransaction.reminderDaysBefore,
        }
      : {
          currencyCode: defaultCurrency,
          frequency: 'MONTHLY' as FrequencyType,
          nextDueDate: new Date().toISOString().split('T')[0],
          isActive: true,
          autoPost: false,
          reminderDaysBefore: 3,
        },
  });

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);

  const watchedAccountId = watch('accountId');
  const watchedAmount = watch('amount');
  const watchedFrequency = watch('frequency');
  const watchedCurrencyCode = watch('currencyCode');

  // Auto-set currencyCode from the selected account
  useEffect(() => {
    if (watchedAccountId && accounts.length > 0) {
      const account = accounts.find(a => a.id === watchedAccountId);
      if (account) {
        setValue('currencyCode', account.currencyCode, { shouldDirty: true });
      }
    }
  }, [watchedAccountId, accounts, setValue]);

  const currencySymbol = getCurrencySymbol(watchedCurrencyCode || defaultCurrency);

  // Load accounts, categories, payees on mount
  useEffect(() => {
    Promise.all([
      accountsApi.getAll(),
      categoriesApi.getAll(),
      payeesApi.getAll(),
    ])
      .then(([accountsData, categoriesData, payeesData]) => {
        setAccounts(accountsData);
        setCategories(categoriesData);
        setPayees(payeesData);
        setAllPayees(payeesData);
      })
      .catch((error) => {
        toast.error(getErrorMessage(error, 'Failed to load form data'));
        logger.error(error);
      });
  }, []);

  const handlePayeeSearch = (query: string) => {
    if (!query || query.length < 2) {
      setPayees(allPayees);
      return;
    }
    const lowerQuery = query.toLowerCase();
    const filtered = allPayees.filter((payee) =>
      payee.name.toLowerCase().includes(lowerQuery)
    );
    setPayees(filtered);
  };

  const handlePayeeChange = (payeeId: string, payeeName: string) => {
    setSelectedPayeeId(payeeId);
    setValue('payeeName', payeeName, { shouldDirty: true, shouldValidate: true });

    if (payeeId) {
      setValue('payeeId', payeeId, { shouldDirty: true, shouldValidate: true });

      // Auto-fill category from payee's default category (payment mode only)
      if (transactionType === 'payment') {
        const payee = payees.find((p) => p.id === payeeId);
        if (payee?.defaultCategoryId && !selectedCategoryId) {
          setSelectedCategoryId(payee.defaultCategoryId);
          setValue('categoryId', payee.defaultCategoryId, {
            shouldDirty: true,
            shouldValidate: true,
          });

          // Adjust amount sign based on default category type
          const category = categories.find((c) => c.id === payee.defaultCategoryId);
          if (category && watchedAmount !== undefined && watchedAmount !== 0) {
            const absAmount = Math.abs(watchedAmount);
            const newAmount = category.isIncome ? absAmount : -absAmount;
            if (newAmount !== watchedAmount) {
              const rounded = roundToCents(newAmount);
              setValue('amount', rounded, { shouldDirty: true, shouldValidate: true });
              // CurrencyInput syncs display from value prop
            }
          }
        }
      }
    } else {
      setValue('payeeId', undefined, { shouldDirty: true, shouldValidate: true });
    }
  };

  const handlePayeeCreate = async (name: string) => {
    if (!name.trim()) return;

    try {
      const newPayee = await payeesApi.create({ name: name.trim() });
      setPayees((prev) => [...prev, newPayee]);
      setAllPayees((prev) => [...prev, newPayee]);
      setSelectedPayeeId(newPayee.id);
      setValue('payeeId', newPayee.id, { shouldDirty: true, shouldValidate: true });
      setValue('payeeName', newPayee.name, { shouldDirty: true, shouldValidate: true });
      toast.success(`Payee "${name}" created`);
    } catch (error) {
      logger.error('Failed to create payee:', error);
      toast.error(getErrorMessage(error, 'Failed to create payee'));
    }
  };

  const handleCategoryChange = (categoryId: string, _name: string) => {
    if (categoryId) {
      setSelectedCategoryId(categoryId);
      setValue('categoryId', categoryId, { shouldDirty: true, shouldValidate: true });

      // Adjust amount sign based on category type
      const category = categories.find((c) => c.id === categoryId);
      if (category && watchedAmount !== undefined && watchedAmount !== 0) {
        const absAmount = Math.abs(watchedAmount);
        const newAmount = category.isIncome ? absAmount : -absAmount;
        if (newAmount !== watchedAmount) {
          const rounded = roundToCents(newAmount);
          setValue('amount', rounded, { shouldDirty: true, shouldValidate: true });
          // CurrencyInput syncs display from value prop
        }
      }
    } else {
      setSelectedCategoryId('');
      setValue('categoryId', '', { shouldDirty: true, shouldValidate: true });
    }
  };

  const handleCategoryCreate = async (name: string) => {
    if (!name.trim()) return;

    try {
      const newCategory = await categoriesApi.create({ name: name.trim() });
      setCategories((prev) => [...prev, newCategory]);
      setSelectedCategoryId(newCategory.id);
      setValue('categoryId', newCategory.id, { shouldDirty: true, shouldValidate: true });
      toast.success(`Category "${name}" created`);
    } catch (error) {
      logger.error('Failed to create category:', error);
      toast.error(getErrorMessage(error, 'Failed to create category'));
    }
  };

  const handleSplitToggle = (enabled: boolean) => {
    setIsSplit(enabled);
    if (enabled) {
      // Initialize with 2 empty splits when enabling
      if (splits.length === 0) {
        const amount = watchedAmount || 0;
        setSplits(createEmptySplits(amount));
      }
      // Clear single category when switching to split
      setSelectedCategoryId('');
      setValue('categoryId', '', { shouldDirty: true, shouldValidate: true });
    } else {
      // Clear splits when switching back to single category
      setSplits([]);
    }
  };

  const handleSplitsChange = (newSplits: SplitRow[]) => {
    setSplits(newSplits);
  };

  const handleTransactionAmountChange = (amount: number) => {
    const rounded = roundToCents(amount);
    setValue('amount', rounded, { shouldDirty: true, shouldValidate: true });
    // CurrencyInput syncs display from value prop
  };

  const onSubmit = async (data: ScheduledTransactionFormData) => {
    // Validate transfer destination
    if (transactionType === 'transfer') {
      if (!transferToAccountId) {
        toast.error('Please select a destination account for the transfer');
        return;
      }
      if (transferToAccountId === data.accountId) {
        toast.error('Source and destination accounts must be different');
        return;
      }
    }

    // Validate splits if in split mode (only for payment type)
    if (isSplit && transactionType === 'payment') {
      if (splits.length < 2) {
        toast.error('Split transactions require at least 2 splits');
        return;
      }
      const splitsTotal = splits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
      const remaining = Math.abs(Number(data.amount) - splitsTotal);
      if (remaining >= 0.01) {
        toast.error('Split amounts must equal the transaction amount');
        return;
      }
    }

    setIsLoading(true);
    try {
      // Build the payload based on transaction type
      let payload: any = {
        ...data,
        endDate: useEndDate ? data.endDate : undefined,
        occurrencesRemaining: useOccurrences ? data.occurrencesRemaining : undefined,
      };

      if (transactionType === 'transfer') {
        // For transfers, use direct transfer fields (no splits needed)
        // Amount should be negative (money leaving source account)
        const transferAmount = -Math.abs(Number(data.amount));
        payload = {
          ...payload,
          amount: transferAmount,
          isTransfer: true,
          transferAccountId: transferToAccountId,
          categoryId: undefined,
          splits: undefined,
        };
      } else if (isSplit) {
        // For split payments, convert splits to API format
        payload = {
          ...payload,
          isTransfer: false,
          transferAccountId: undefined,
          categoryId: undefined,
          splits: toCreateSplitData(splits),
        };
      } else {
        // Regular payment - no splits, no transfer
        payload = {
          ...payload,
          isTransfer: false,
          transferAccountId: undefined,
          splits: undefined,
        };
      }

      if (scheduledTransaction) {
        await scheduledTransactionsApi.update(scheduledTransaction.id, payload);
        toast.success('Scheduled transaction updated');
      } else {
        await scheduledTransactionsApi.create(payload);
        toast.success('Scheduled transaction created');
      }
      onSuccess?.();
    } catch (error) {
      logger.error('Submit error:', error);
      toast.error(getErrorMessage(error, 'Failed to save scheduled transaction'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (submitRef) submitRef.current = handleSubmit(onSubmit);
    return () => { if (submitRef) submitRef.current = null; };
  }, [submitRef, handleSubmit, onSubmit]);

  const frequencyOptions = Object.entries(FREQUENCY_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  // Get available "to" accounts for transfers (exclude source account, closed accounts, brokerage accounts, and asset accounts)
  const transferToAccountOptions = accounts
    .filter(a => !a.isClosed && a.id !== watchedAccountId && a.accountType !== 'ASSET' && a.accountSubType !== 'INVESTMENT_BROKERAGE')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(a => ({ value: a.id, label: a.name }));

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Transaction Type Toggle */}
      <div className="flex space-x-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1 w-fit">
        <button
          type="button"
          onClick={() => {
            setTransactionType('payment');
            setTransferToAccountId('');
          }}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            transactionType === 'payment'
              ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Bill / Deposit
        </button>
        <button
          type="button"
          onClick={() => {
            setTransactionType('transfer');
            setIsSplit(false);
            setSplits([]);
            setSelectedCategoryId('');
            setValue('categoryId', '', { shouldDirty: true });
            // Show absolute amount for transfers (sign is applied on submit)
            if (watchedAmount < 0) {
              setValue('amount', Math.abs(watchedAmount), { shouldDirty: true });
            }
          }}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            transactionType === 'transfer'
              ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Transfer
        </button>
      </div>

      {/* Name */}
      <Input
        label="Name"
        type="text"
        placeholder={transactionType === 'transfer' ? 'e.g., Savings Transfer, Credit Card Payment...' : 'e.g., Rent, Netflix, Salary...'}
        error={errors.name?.message}
        {...register('name')}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Account (From Account for transfers) */}
        <Select
          label={transactionType === 'transfer' ? 'From Account' : 'Account'}
          error={errors.accountId?.message}
          value={watchedAccountId || ''}
          options={[
            { value: '', label: 'Select account...' },
            ...accounts
              .filter(a => !a.isClosed && a.accountType !== 'ASSET' && a.accountSubType !== 'INVESTMENT_BROKERAGE')
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((account) => ({
                value: account.id,
                label: `${account.name} (${account.currencyCode})`,
              })),
          ]}
          {...register('accountId')}
        />

        {/* Amount */}
        <CurrencyInput
          label={isSplit ? 'Total Amount' : 'Amount'}
          prefix={currencySymbol}
          value={watchedAmount}
          onChange={(value) => setValue('amount', value ?? 0, { shouldValidate: true })}
          error={errors.amount?.message}
        />

        {/* Transfer: To Account */}
        {transactionType === 'transfer' && (
          <Select
            label="To Account"
            value={transferToAccountId}
            onChange={(e) => setTransferToAccountId(e.target.value)}
            options={[
              { value: '', label: 'Select destination account...' },
              ...transferToAccountOptions,
            ]}
            error={!transferToAccountId && watchedAccountId ? undefined : undefined}
          />
        )}

        {/* Payee (both payment and transfer) */}
        <Combobox
          label="Payee"
          placeholder="Select or type payee name..."
          options={payees.map((payee) => ({
            value: payee.id,
            label: payee.name,
            subtitle: payee.defaultCategory?.name,
          }))}
          value={selectedPayeeId}
          initialDisplayValue={scheduledTransaction?.payeeName || ''}
          onChange={handlePayeeChange}
          onInputChange={handlePayeeSearch}
          onCreateNew={handlePayeeCreate}
          allowCustomValue={true}
          error={errors.payeeName?.message}
        />

        {/* Payment: Category / Split Toggle */}
        {transactionType === 'payment' && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Category</label>
              <label className="flex items-center text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isSplit}
                  onChange={(e) => handleSplitToggle(e.target.checked)}
                  className="h-3.5 w-3.5 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded mr-1.5"
                />
                Split
              </label>
            </div>
            {!isSplit ? (
              <Combobox
                placeholder="Select or create category..."
                options={buildCategoryTree(categories).map(({ category }) => {
                  const parentCategory = category.parentId
                    ? categories.find(c => c.id === category.parentId)
                    : null;
                  return {
                    value: category.id,
                    label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
                  };
                })}
                value={selectedCategoryId}
                initialDisplayValue={scheduledTransaction?.category?.name || ''}
                onChange={handleCategoryChange}
                onCreateNew={handleCategoryCreate}
                allowCustomValue={true}
                error={errors.categoryId?.message}
              />
            ) : (
              <div className="text-sm text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-700 rounded-md px-3 py-2">
                {splits.length} categories · Configure below
              </div>
            )}
          </div>
        )}

        {/* Frequency */}
        <Select
          label="Frequency"
          error={errors.frequency?.message}
          value={watchedFrequency || 'MONTHLY'}
          options={frequencyOptions}
          {...register('frequency')}
        />

        {/* Next Due Date */}
        <Input
          label="Next Due Date"
          type="date"
          error={errors.nextDueDate?.message}
          {...register('nextDueDate')}
        />

        {/* Reminder Days */}
        <Input
          label="Remind Days Before"
          type="number"
          min={0}
          error={errors.reminderDaysBefore?.message}
          {...register('reminderDaysBefore', { valueAsNumber: true })}
        />
      </div>

      {/* Split Editor (only for payment type) */}
      {isSplit && transactionType === 'payment' && (
        <SplitEditor
          splits={splits}
          onChange={handleSplitsChange}
          categories={categories}
          accounts={accounts}
          sourceAccountId={watchedAccountId}
          transactionAmount={watchedAmount || 0}
          onTransactionAmountChange={handleTransactionAmountChange}
          currencyCode={watchedCurrencyCode || defaultCurrency}
        />
      )}

      {/* End conditions */}
      {watchedFrequency !== 'ONCE' && (
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">End Condition (optional)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* End Date Option */}
            <div>
              <div className="flex items-center mb-2">
                <input
                  id="useEndDate"
                  type="checkbox"
                  checked={useEndDate}
                  onChange={(e) => {
                    setUseEndDate(e.target.checked);
                    if (e.target.checked) setUseOccurrences(false);
                  }}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
                />
                <label htmlFor="useEndDate" className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                  End by date
                </label>
              </div>
              {useEndDate && (
                <Input
                  type="date"
                  error={errors.endDate?.message}
                  {...register('endDate')}
                />
              )}
            </div>

            {/* Occurrences Option */}
            <div>
              <div className="flex items-center mb-2">
                <input
                  id="useOccurrences"
                  type="checkbox"
                  checked={useOccurrences}
                  onChange={(e) => {
                    setUseOccurrences(e.target.checked);
                    if (e.target.checked) setUseEndDate(false);
                  }}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
                />
                <label htmlFor="useOccurrences" className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
                  Number of occurrences
                </label>
              </div>
              {useOccurrences && (
                <Input
                  type="number"
                  min={1}
                  placeholder="# remaining"
                  error={errors.occurrencesRemaining?.message}
                  {...register('occurrencesRemaining', { valueAsNumber: true })}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
        <textarea
          rows={2}
          className="block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500"
          {...register('description')}
        />
        {errors.description && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.description.message}</p>
        )}
      </div>

      {/* Options */}
      <div className="flex items-center space-x-6">
        <div className="flex items-center">
          <input
            id="isActive"
            type="checkbox"
            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
            {...register('isActive')}
          />
          <label htmlFor="isActive" className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
            Active
          </label>
        </div>
        <div className="flex items-center">
          <input
            id="autoPost"
            type="checkbox"
            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
            {...register('autoPost')}
          />
          <label htmlFor="autoPost" className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
            Auto-post on due date
          </label>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end space-x-3 pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" isLoading={isLoading}>
          {scheduledTransaction ? 'Update' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
