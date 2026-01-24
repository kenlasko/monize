'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { SplitEditor, createEmptySplits, toSplitRows, toCreateSplitData } from './SplitEditor';
import { transactionsApi } from '@/lib/transactions';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { accountsApi } from '@/lib/accounts';
import { Transaction, CreateSplitData } from '@/types/transaction';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { Account } from '@/types/account';

// Helper to convert empty strings to undefined for optional UUID fields
const optionalUuid = z.preprocess(
  (val) => (val === '' ? undefined : val),
  z.string().uuid().optional()
);

const optionalString = z.preprocess(
  (val) => (val === '' ? undefined : val),
  z.string().optional()
);

const transactionSchema = z.object({
  accountId: z.string().uuid('Please select an account'),
  transactionDate: z.string().min(1, 'Date is required'),
  payeeId: optionalUuid,
  payeeName: optionalString,
  categoryId: optionalUuid,
  amount: z.number({ invalid_type_error: 'Amount is required' }),
  currencyCode: z.string().default('CAD'),
  description: optionalString,
  referenceNumber: optionalString,
  isCleared: z.boolean().default(false),
});

type TransactionFormData = z.infer<typeof transactionSchema>;

interface TransactionFormProps {
  transaction?: Transaction;
  defaultAccountId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
}

// Type for split row with temporary ID
interface SplitRow extends CreateSplitData {
  id: string;
}

export function TransactionForm({ transaction, defaultAccountId, onSuccess, onCancel }: TransactionFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [allPayees, setAllPayees] = useState<Payee[]>([]);
  const [selectedPayeeId, setSelectedPayeeId] = useState<string>(transaction?.payeeId || '');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(transaction?.categoryId || '');
  const [categoryName, setCategoryName] = useState<string>('');

  // Split transaction state
  const [isSplitMode, setIsSplitMode] = useState<boolean>(transaction?.isSplit || false);
  const [splits, setSplits] = useState<SplitRow[]>(
    transaction?.splits && transaction.splits.length > 0
      ? toSplitRows(transaction.splits)
      : []
  );

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<TransactionFormData>({
    resolver: zodResolver(transactionSchema),
    defaultValues: transaction
      ? {
          accountId: transaction.accountId,
          transactionDate: transaction.transactionDate,
          payeeId: transaction.payeeId || '',
          payeeName: transaction.payeeName || '',
          categoryId: transaction.categoryId || '',
          amount: Math.round(Number(transaction.amount) * 100) / 100,
          currencyCode: transaction.currencyCode,
          description: transaction.description || '',
          referenceNumber: transaction.referenceNumber || '',
          isCleared: transaction.isCleared,
        }
      : {
          accountId: defaultAccountId || '',
          transactionDate: new Date().toISOString().split('T')[0],
          currencyCode: 'CAD',
          isCleared: false,
        },
  });

  const watchedAccountId = watch('accountId');
  const watchedAmount = watch('amount');

  // Handle toggling split mode
  const handleSplitModeToggle = (enabled: boolean) => {
    setIsSplitMode(enabled);
    if (enabled && splits.length === 0) {
      // Create initial splits when enabling split mode
      const amount = watchedAmount || 0;
      setSplits(createEmptySplits(amount));
    }
    if (!enabled) {
      // Clear splits when disabling split mode
      setSplits([]);
    }
  };

  // Set defaultAccountId when it changes (and we're not editing an existing transaction)
  useEffect(() => {
    if (!transaction && defaultAccountId) {
      setValue('accountId', defaultAccountId);
    }
  }, [defaultAccountId, transaction, setValue]);

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
        toast.error('Failed to load form data');
        console.error(error);
      });
  }, []);

  // Filter payees based on search (client-side filtering for reliability)
  const handlePayeeSearch = (query: string) => {
    if (!query || query.length < 2) {
      // Show all payees when query is too short
      setPayees(allPayees);
      return;
    }

    // Filter payees client-side
    const lowerQuery = query.toLowerCase();
    const filtered = allPayees.filter(payee =>
      payee.name.toLowerCase().includes(lowerQuery)
    );
    setPayees(filtered);
  };

  // Handle payee selection
  const handlePayeeChange = (payeeId: string, payeeName: string) => {
    setSelectedPayeeId(payeeId);
    setValue('payeeName', payeeName, { shouldDirty: true, shouldValidate: true });

    if (payeeId) {
      setValue('payeeId', payeeId, { shouldDirty: true, shouldValidate: true });

      // Auto-fill category from payee's default category
      const payee = payees.find(p => p.id === payeeId);
      if (payee?.defaultCategoryId && !selectedCategoryId) {
        setSelectedCategoryId(payee.defaultCategoryId);
        setValue('categoryId', payee.defaultCategoryId, { shouldDirty: true, shouldValidate: true });
      }
    } else {
      // Custom payee name (not in database)
      setValue('payeeId', undefined, { shouldDirty: true, shouldValidate: true });
    }
  };

  // Handle creating a new payee - called when user clicks "Create" in dropdown
  const handlePayeeCreate = async (name: string) => {
    if (!name.trim()) return;

    try {
      const newPayee = await payeesApi.create({ name: name.trim() });
      // Add to both lists
      setPayees(prev => [...prev, newPayee]);
      setAllPayees(prev => [...prev, newPayee]);
      // Select the new payee
      setSelectedPayeeId(newPayee.id);
      setValue('payeeId', newPayee.id, { shouldDirty: true, shouldValidate: true });
      setValue('payeeName', newPayee.name, { shouldDirty: true, shouldValidate: true });
      toast.success(`Payee "${name}" created`);
    } catch (error) {
      console.error('Failed to create payee:', error);
      toast.error('Failed to create payee');
    }
  };

  // Handle category selection - only create when explicitly selected from dropdown
  const handleCategoryChange = (categoryId: string, name: string) => {
    setCategoryName(name);

    if (categoryId) {
      // Existing category selected
      setSelectedCategoryId(categoryId);
      setValue('categoryId', categoryId, { shouldDirty: true, shouldValidate: true });
    } else {
      // Custom value being typed - don't create yet, just track the name
      // Category will be created when user clicks "Create" option
      setSelectedCategoryId('');
      setValue('categoryId', '', { shouldDirty: true, shouldValidate: true });
    }
  };

  // Handle creating a new category - called when user clicks "Create" in dropdown
  const handleCategoryCreate = async (name: string) => {
    if (!name.trim()) return;

    try {
      const newCategory = await categoriesApi.create({ name: name.trim() });
      setCategories(prev => [...prev, newCategory]);
      setSelectedCategoryId(newCategory.id);
      setValue('categoryId', newCategory.id, { shouldDirty: true, shouldValidate: true });
      toast.success(`Category "${name}" created`);
    } catch (error) {
      console.error('Failed to create category:', error);
      toast.error('Failed to create category');
    }
  };

  const onSubmit = async (data: TransactionFormData) => {
    setIsLoading(true);
    try {
      // Prepare splits data if in split mode
      const splitsData = isSplitMode ? toCreateSplitData(splits) : undefined;

      // Validate splits sum to amount if in split mode
      if (isSplitMode && splitsData) {
        const splitsTotal = splitsData.reduce((sum, s) => sum + s.amount, 0);
        const roundedSplitsTotal = Math.round(splitsTotal * 100) / 100;
        const roundedAmount = Math.round(data.amount * 100) / 100;
        if (roundedSplitsTotal !== roundedAmount) {
          toast.error(`Splits total (${roundedSplitsTotal}) must equal transaction amount (${roundedAmount})`);
          setIsLoading(false);
          return;
        }
      }

      const payload = {
        ...data,
        splits: splitsData,
        // Clear categoryId for split transactions
        categoryId: isSplitMode ? undefined : data.categoryId,
      };

      if (transaction) {
        await transactionsApi.update(transaction.id, payload);
        toast.success('Transaction updated');
      } else {
        await transactionsApi.create(payload);
        toast.success('Transaction created');
      }
      onSuccess?.();
    } catch (error: any) {
      console.error('Submit error:', error);
      const message = error.response?.data?.message || 'Failed to save transaction';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Account */}
        <Select
          label="Account"
          error={errors.accountId?.message}
          value={watchedAccountId || ''}
          options={[
            { value: '', label: 'Select account...' },
            ...accounts.map(account => ({
              value: account.id,
              label: `${account.name} (${account.currencyCode})`,
            })),
          ]}
          {...register('accountId')}
        />

        {/* Date */}
        <Input
          label="Date"
          type="date"
          error={errors.transactionDate?.message}
          {...register('transactionDate')}
        />

        {/* Payee with autocomplete */}
        <Combobox
          label="Payee"
          placeholder="Select or type payee name..."
          options={payees.map(payee => ({
            value: payee.id,
            label: payee.name,
            subtitle: payee.defaultCategory?.name,
          }))}
          value={selectedPayeeId}
          initialDisplayValue={transaction?.payeeName || ''}
          onChange={handlePayeeChange}
          onInputChange={handlePayeeSearch}
          onCreateNew={handlePayeeCreate}
          allowCustomValue={true}
          error={errors.payeeName?.message}
        />

        {/* Amount - labeled as Total when in split mode */}
        <Input
          label={isSplitMode ? "Total Amount" : "Amount"}
          type="number"
          step="0.01"
          placeholder="0.00"
          error={errors.amount?.message}
          {...register('amount', { valueAsNumber: true })}
        />

        {/* Category - only show if not in split mode */}
        {!isSplitMode && (
          <Combobox
            label="Category"
            placeholder="Select or create category..."
            options={categories.map(category => ({
              value: category.id,
              label: category.name,
            }))}
            value={selectedCategoryId}
            initialDisplayValue={transaction?.category?.name || ''}
            onChange={handleCategoryChange}
            onCreateNew={handleCategoryCreate}
            allowCustomValue={true}
            error={errors.categoryId?.message}
          />
        )}

        {/* Split toggle - shown when not in split mode, beside Amount */}
        {!isSplitMode && (
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => handleSplitModeToggle(true)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Split Transaction
            </button>
          </div>
        )}

        {/* Currency */}
        <Input
          label="Currency"
          type="text"
          maxLength={3}
          placeholder="CAD"
          error={errors.currencyCode?.message}
          {...register('currencyCode')}
        />

        {/* Reference Number */}
        <Input
          label="Reference Number"
          type="text"
          placeholder="Check #, confirmation #..."
          error={errors.referenceNumber?.message}
          {...register('referenceNumber')}
        />
      </div>

      {/* Split Editor - shown when in split mode */}
      {isSplitMode && (
        <div className="border-t pt-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-medium text-gray-900">Split Transaction</h3>
            <button
              type="button"
              onClick={() => handleSplitModeToggle(false)}
              className="text-sm text-red-600 hover:text-red-800"
            >
              Cancel Split
            </button>
          </div>
          <SplitEditor
            splits={splits}
            onChange={setSplits}
            categories={categories}
            transactionAmount={watchedAmount || 0}
            disabled={isLoading}
            onTransactionAmountChange={(amount) => setValue('amount', amount, { shouldDirty: true, shouldValidate: true })}
          />
        </div>
      )}

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Description
        </label>
        <textarea
          rows={3}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
          {...register('description')}
        />
        {errors.description && (
          <p className="mt-1 text-sm text-red-600">{errors.description.message}</p>
        )}
      </div>

      {/* Cleared checkbox */}
      <div className="flex items-center">
        <input
          id="isCleared"
          type="checkbox"
          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
          {...register('isCleared')}
        />
        <label htmlFor="isCleared" className="ml-2 block text-sm text-gray-900">
          Mark as cleared
        </label>
      </div>

      {/* Actions */}
      <div className="flex justify-end space-x-3 pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" isLoading={isLoading}>
          {transaction ? 'Update' : 'Create'} Transaction
        </Button>
      </div>
    </form>
  );
}
