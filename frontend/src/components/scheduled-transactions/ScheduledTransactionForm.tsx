'use client';

import { useState, useEffect, useMemo, MutableRefObject } from 'react';
import { useForm, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
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

import { optionalUuid, optionalString, optionalNumber } from '@/lib/zod-helpers';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const logger = createLogger('ScheduledTxForm');

type ScheduledTransactionMode = 'transaction' | 'split' | 'transfer';

const scheduledTransactionSchema = z.object({
  accountId: z.string().uuid('Please select an account'),
  name: z.string().min(1, 'Name is required'),
  payeeId: optionalUuid,
  payeeName: optionalString,
  categoryId: optionalUuid,
  amount: z.number({ error: 'Amount is required' }),
  currencyCode: z.string().default('CAD'),
  description: optionalString,
  referenceNumber: optionalString,
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

  // Determine initial mode
  const getInitialMode = (): ScheduledTransactionMode => {
    if (isScheduledTransfer(scheduledTransaction)) return 'transfer';
    if (scheduledTransaction?.isSplit && !isScheduledTransfer(scheduledTransaction)) return 'split';
    return 'transaction';
  };

  const [mode, setMode] = useState<ScheduledTransactionMode>(getInitialMode());
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
  const [splits, setSplits] = useState<SplitRow[]>(
    scheduledTransaction?.splits && scheduledTransaction.splits.length > 0 && !isScheduledTransfer(scheduledTransaction)
      ? toSplitRows(scheduledTransaction.splits)
      : []
  );

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<ScheduledTransactionFormData>({
    resolver: zodResolver(scheduledTransactionSchema) as Resolver<ScheduledTransactionFormData>,
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
          referenceNumber: '',
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

  useFormDirtyNotify(isDirty, onDirtyChange);

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

  // Memoize category options
  const categoryOptions = useMemo(() => buildCategoryTree(categories).map(({ category }) => {
    const parentCategory = category.parentId
      ? categories.find(c => c.id === category.parentId)
      : null;
    return {
      value: category.id,
      label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
    };
  }), [categories]);

  // Memoize account options (exclude closed, asset, brokerage)
  const accountOptions = useMemo(() =>
    accounts
      .filter(a => !a.isClosed && a.accountType !== 'ASSET' && a.accountSubType !== 'INVESTMENT_BROKERAGE')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(a => ({ value: a.id, label: `${a.name} (${a.currencyCode})` })),
    [accounts]
  );

  // Memoize transfer To account options
  const transferToAccountOptions = useMemo(() =>
    accounts
      .filter(a =>
        !a.isClosed &&
        a.id !== watchedAccountId &&
        a.accountType !== 'ASSET' &&
        a.accountSubType !== 'INVESTMENT_BROKERAGE'
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(a => ({ value: a.id, label: `${a.name} (${a.currencyCode})` })),
    [accounts, watchedAccountId]
  );

  // Memoize payee options
  const payeeOptions = useMemo(() =>
    payees.map((payee) => ({
      value: payee.id,
      label: payee.name,
      subtitle: payee.defaultCategory?.name,
    })),
    [payees]
  );

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

  // Handle mode changes
  const handleModeChange = (newMode: ScheduledTransactionMode) => {
    setMode(newMode);

    if (newMode === 'split') {
      if (splits.length === 0) {
        const amount = watchedAmount || 0;
        setSplits(createEmptySplits(amount));
      }
      setSelectedCategoryId('');
      setValue('categoryId', '', { shouldDirty: true });
      setTransferToAccountId('');
    } else if (newMode === 'transfer') {
      setSplits([]);
      setSelectedCategoryId('');
      setValue('categoryId', '', { shouldDirty: true });
      if (watchedAmount < 0) {
        setValue('amount', Math.abs(watchedAmount), { shouldDirty: true });
      }
    } else {
      // 'transaction'
      setSplits([]);
      setTransferToAccountId('');
    }
  };

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
    setValue('payeeName', payeeName, { shouldDirty: true });

    if (payeeId) {
      setValue('payeeId', payeeId, { shouldDirty: true });

      // Auto-fill category from payee's default category (not for transfers)
      if (mode !== 'transfer') {
        const payee = payees.find((p) => p.id === payeeId);
        if (payee?.defaultCategoryId && !selectedCategoryId) {
          setSelectedCategoryId(payee.defaultCategoryId);
          setValue('categoryId', payee.defaultCategoryId, { shouldDirty: true });

          // Adjust amount sign based on default category type
          const category = categories.find((c) => c.id === payee.defaultCategoryId);
          if (category && watchedAmount !== undefined && watchedAmount !== 0) {
            const absAmount = Math.abs(watchedAmount);
            const newAmount = category.isIncome ? absAmount : -absAmount;
            if (newAmount !== watchedAmount) {
              const rounded = roundToCents(newAmount);
              setValue('amount', rounded, { shouldDirty: true });
            }
          }
        }
      }
    } else {
      setValue('payeeId', undefined, { shouldDirty: true });
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

  const handleTransactionAmountChange = (amount: number) => {
    const rounded = roundToCents(amount);
    setValue('amount', rounded, { shouldDirty: true, shouldValidate: true });
  };

  const onSubmit = async (data: ScheduledTransactionFormData) => {
    // Validate transfer destination
    if (mode === 'transfer') {
      if (!transferToAccountId) {
        toast.error('Please select a destination account for the transfer');
        return;
      }
      if (transferToAccountId === data.accountId) {
        toast.error('Source and destination accounts must be different');
        return;
      }
    }

    // Validate splits if in split mode
    if (mode === 'split') {
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
      // Strip referenceNumber (backend doesn't support it for scheduled transactions)
      const { referenceNumber: _ref, ...formData } = data;

      // Build the payload based on mode
      let payload: any = {
        ...formData,
        endDate: useEndDate ? formData.endDate : undefined,
        occurrencesRemaining: useOccurrences ? formData.occurrencesRemaining : undefined,
      };

      if (mode === 'transfer') {
        // Amount should be negative (money leaving source account)
        const transferAmount = -Math.abs(Number(formData.amount));
        payload = {
          ...payload,
          amount: transferAmount,
          isTransfer: true,
          transferAccountId: transferToAccountId,
          categoryId: undefined,
          splits: undefined,
        };
      } else if (mode === 'split') {
        payload = {
          ...payload,
          isTransfer: false,
          transferAccountId: undefined,
          categoryId: undefined,
          splits: toCreateSplitData(splits),
        };
      } else {
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
  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const frequencyOptions = Object.entries(FREQUENCY_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  // Shared End Condition section
  const renderEndCondition = (idSuffix: string) => {
    if (watchedFrequency === 'ONCE') return null;
    return (
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">End Condition (optional)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="flex items-center mb-2">
              <input
                id={`useEndDate${idSuffix}`}
                type="checkbox"
                checked={useEndDate}
                onChange={(e) => {
                  setUseEndDate(e.target.checked);
                  if (e.target.checked) setUseOccurrences(false);
                }}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label htmlFor={`useEndDate${idSuffix}`} className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
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
          <div>
            <div className="flex items-center mb-2">
              <input
                id={`useOccurrences${idSuffix}`}
                type="checkbox"
                checked={useOccurrences}
                onChange={(e) => {
                  setUseOccurrences(e.target.checked);
                  if (e.target.checked) setUseEndDate(false);
                }}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <label htmlFor={`useOccurrences${idSuffix}`} className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
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
    );
  };

  // Shared Active/Auto-post section
  const renderOptions = (idSuffix: string) => (
    <div className="flex items-center space-x-6">
      <div className="flex items-center">
        <input
          id={`isActive${idSuffix}`}
          type="checkbox"
          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
          {...register('isActive')}
        />
        <label htmlFor={`isActive${idSuffix}`} className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
          Active
        </label>
      </div>
      <div className="flex items-center">
        <input
          id={`autoPost${idSuffix}`}
          type="checkbox"
          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600 rounded"
          {...register('autoPost')}
        />
        <label htmlFor={`autoPost${idSuffix}`} className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
          Auto-post on due date
        </label>
      </div>
    </div>
  );

  // Shared Description textarea section
  const renderDescription = () => (
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
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Tab Bar */}
      <div className="flex space-x-2 pb-2 border-b dark:border-gray-700">
        {(['transaction', 'split', 'transfer'] as const).map((tabMode) => (
          <button
            key={tabMode}
            type="button"
            onClick={() => handleModeChange(tabMode)}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
              mode === tabMode
                ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {tabMode === 'transaction' ? 'Transaction' : tabMode === 'split' ? 'Split' : 'Transfer'}
          </button>
        ))}
      </div>

      {/* ==================== Transaction Tab ==================== */}
      {mode === 'transaction' && (
        <div className="space-y-4">
          {/* Row 1: Name */}
          <Input
            label="Name"
            type="text"
            placeholder="e.g., Rent, Netflix, Salary..."
            error={errors.name?.message}
            {...register('name')}
          />

          {/* Row 2: Account, Next Due Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Account"
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: 'Select account...' },
                ...accountOptions,
              ]}
              {...register('accountId')}
            />
            <Input
              label="Next Due Date"
              type="date"
              error={errors.nextDueDate?.message}
              {...register('nextDueDate')}
            />
          </div>

          {/* Row 3: Payee, Category + Split Transaction button */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Combobox
              label="Payee"
              placeholder="Select or type payee name..."
              options={payeeOptions}
              value={selectedPayeeId}
              initialDisplayValue={scheduledTransaction?.payeeName || ''}
              onChange={handlePayeeChange}
              onInputChange={handlePayeeSearch}
              onCreateNew={handlePayeeCreate}
              allowCustomValue={true}
              error={errors.payeeName?.message}
            />
            <div>
              <div className="flex items-end sm:space-x-2">
                <div className="flex-1">
                  <Combobox
                    label="Category"
                    placeholder="Select or create category..."
                    options={categoryOptions}
                    value={selectedCategoryId}
                    initialDisplayValue={scheduledTransaction?.category?.name || ''}
                    onChange={handleCategoryChange}
                    onCreateNew={handleCategoryCreate}
                    allowCustomValue={true}
                    error={errors.categoryId?.message}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => handleModeChange('split')}
                  className="hidden sm:block px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 whitespace-nowrap"
                >
                  Split Transaction
                </button>
              </div>
              <button
                type="button"
                onClick={() => handleModeChange('split')}
                className="sm:hidden mt-2 w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
              >
                Split Transaction
              </button>
            </div>
          </div>

          {/* Row 4: Amount, Reference Number */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CurrencyInput
              label="Amount"
              prefix={currencySymbol}
              value={watchedAmount}
              onChange={(value) => setValue('amount', value ?? 0, { shouldValidate: true })}
              error={errors.amount?.message}
            />
            <Input
              label="Reference Number"
              type="text"
              placeholder="Cheque #, confirmation #..."
              error={errors.referenceNumber?.message}
              {...register('referenceNumber')}
            />
          </div>

          {/* Row 5: Frequency, Remind Days Before */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Frequency"
              error={errors.frequency?.message}
              value={watchedFrequency || 'MONTHLY'}
              options={frequencyOptions}
              {...register('frequency')}
            />
            <Input
              label="Remind Days Before"
              type="number"
              min={0}
              error={errors.reminderDaysBefore?.message}
              {...register('reminderDaysBefore', { valueAsNumber: true })}
            />
          </div>

          {/* Row 6: End Condition */}
          {renderEndCondition('Tx')}

          {/* Row 7: Description */}
          {renderDescription()}

          {/* Row 8: Active/Auto-post */}
          {renderOptions('Tx')}
        </div>
      )}

      {/* ==================== Split Tab ==================== */}
      {mode === 'split' && (
        <div className="space-y-4">
          {/* Row 1: Name */}
          <Input
            label="Name"
            type="text"
            placeholder="e.g., Rent, Netflix, Salary..."
            error={errors.name?.message}
            {...register('name')}
          />

          {/* Row 2: Account, Next Due Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Account"
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: 'Select account...' },
                ...accountOptions,
              ]}
              {...register('accountId')}
            />
            <Input
              label="Next Due Date"
              type="date"
              error={errors.nextDueDate?.message}
              {...register('nextDueDate')}
            />
          </div>

          {/* Row 3: Payee, Total Amount */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Combobox
              label="Payee"
              placeholder="Select or type payee name..."
              options={payeeOptions}
              value={selectedPayeeId}
              initialDisplayValue={scheduledTransaction?.payeeName || ''}
              onChange={handlePayeeChange}
              onInputChange={handlePayeeSearch}
              onCreateNew={handlePayeeCreate}
              allowCustomValue={true}
              error={errors.payeeName?.message}
            />
            <CurrencyInput
              label="Total Amount"
              prefix={currencySymbol}
              value={watchedAmount}
              onChange={(value) => setValue('amount', value ?? 0, { shouldValidate: true })}
              error={errors.amount?.message}
            />
          </div>

          {/* Row 4: Reference Number, Description */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Reference Number"
              type="text"
              placeholder="Cheque #, confirmation #..."
              error={errors.referenceNumber?.message}
              {...register('referenceNumber')}
            />
            <Input
              label="Description"
              type="text"
              placeholder="Optional description..."
              error={errors.description?.message}
              {...register('description')}
            />
          </div>

          {/* Row 5: Split Editor */}
          <div className="border-t dark:border-gray-700 pt-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Split Transaction</h3>
              <button
                type="button"
                onClick={() => handleModeChange('transaction')}
                className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
              >
                Cancel Split
              </button>
            </div>
            <SplitEditor
              splits={splits}
              onChange={setSplits}
              categories={categories}
              accounts={accounts}
              sourceAccountId={watchedAccountId || ''}
              transactionAmount={watchedAmount || 0}
              onTransactionAmountChange={handleTransactionAmountChange}
              currencyCode={watchedCurrencyCode || defaultCurrency}
            />
          </div>

          {/* Row 6: Frequency, Remind Days Before */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Frequency"
              error={errors.frequency?.message}
              value={watchedFrequency || 'MONTHLY'}
              options={frequencyOptions}
              {...register('frequency')}
            />
            <Input
              label="Remind Days Before"
              type="number"
              min={0}
              error={errors.reminderDaysBefore?.message}
              {...register('reminderDaysBefore', { valueAsNumber: true })}
            />
          </div>

          {/* Row 7: End Condition */}
          {renderEndCondition('Split')}

          {/* Row 8: Active/Auto-post */}
          {renderOptions('Split')}
        </div>
      )}

      {/* ==================== Transfer Tab ==================== */}
      {mode === 'transfer' && (
        <div className="space-y-4">
          {/* Row 1: Name */}
          <Input
            label="Name"
            type="text"
            placeholder="e.g., Savings Transfer, Credit Card Payment..."
            error={errors.name?.message}
            {...register('name')}
          />

          {/* Row 2: Next Due Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Next Due Date"
              type="date"
              error={errors.nextDueDate?.message}
              {...register('nextDueDate')}
            />
          </div>

          {/* Row 3: From Account, To Account */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="From Account"
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: 'Select account...' },
                ...accountOptions,
              ]}
              {...register('accountId')}
            />
            <Select
              label="To Account"
              value={transferToAccountId}
              onChange={(e) => setTransferToAccountId(e.target.value)}
              options={[
                { value: '', label: 'Select destination account...' },
                ...transferToAccountOptions,
              ]}
            />
          </div>

          {/* Row 4: Transfer Amount */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CurrencyInput
              label="Transfer Amount"
              prefix={currencySymbol}
              value={watchedAmount}
              onChange={(value) => setValue('amount', value !== undefined ? Math.abs(value) : 0, { shouldValidate: true })}
              allowNegative={false}
              error={errors.amount?.message}
            />
          </div>

          {/* Row 5: Payee, Reference Number */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Combobox
              label="Payee"
              placeholder="Select or type payee name..."
              options={payeeOptions}
              value={selectedPayeeId}
              initialDisplayValue={scheduledTransaction?.payeeName || ''}
              onChange={handlePayeeChange}
              onInputChange={handlePayeeSearch}
              onCreateNew={handlePayeeCreate}
              allowCustomValue={true}
              error={errors.payeeName?.message}
            />
            <Input
              label="Reference Number"
              type="text"
              placeholder="Cheque #, confirmation #..."
              error={errors.referenceNumber?.message}
              {...register('referenceNumber')}
            />
          </div>

          {/* Row 6: Frequency, Remind Days Before */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Frequency"
              error={errors.frequency?.message}
              value={watchedFrequency || 'MONTHLY'}
              options={frequencyOptions}
              {...register('frequency')}
            />
            <Input
              label="Remind Days Before"
              type="number"
              min={0}
              error={errors.reminderDaysBefore?.message}
              {...register('reminderDaysBefore', { valueAsNumber: true })}
            />
          </div>

          {/* Row 7: Description */}
          {renderDescription()}

          {/* Row 8: Active/Auto-post */}
          {renderOptions('Transfer')}
        </div>
      )}

      {/* Actions */}
      <FormActions onCancel={onCancel} submitLabel={scheduledTransaction ? 'Update' : 'Create'} isSubmitting={isLoading} />
    </form>
  );
}
