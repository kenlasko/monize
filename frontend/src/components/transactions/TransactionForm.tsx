'use client';

import { useState, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zodResolver';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows, toCreateSplitData } from './SplitEditor';
import { transactionsApi } from '@/lib/transactions';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { accountsApi } from '@/lib/accounts';
import { Transaction, CreateSplitData, TransactionStatus } from '@/types/transaction';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { createLogger } from '@/lib/logger';

const logger = createLogger('TransactionForm');

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
  amount: z.number({ error: 'Amount is required' }),
  currencyCode: z.string().default('CAD'),
  description: optionalString,
  referenceNumber: optionalString,
  status: z.nativeEnum(TransactionStatus).default(TransactionStatus.UNRECONCILED),
});

type TransactionFormData = z.infer<typeof transactionSchema>;

interface TransactionFormProps {
  transaction?: Transaction;
  defaultAccountId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
}

// Transaction mode type
type TransactionMode = 'normal' | 'split' | 'transfer';

// Currency symbol lookup
const currencySymbols: Record<string, string> = {
  USD: '$', CAD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', AUD: '$', NZD: '$'
};
const getCurrencySymbol = (code?: string): string => currencySymbols[(code || 'CAD').toUpperCase()] || '$';

export function TransactionForm({ transaction, defaultAccountId, onSuccess, onCancel }: TransactionFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]); // Full list of payees
  const [selectedPayeeId, setSelectedPayeeId] = useState<string>(transaction?.payeeId || '');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(transaction?.categoryId || '');
  const [categoryName, setCategoryName] = useState<string>('');

  // Determine initial mode based on transaction
  const getInitialMode = (): TransactionMode => {
    if (transaction?.isTransfer) return 'transfer';
    if (transaction?.isSplit) return 'split';
    return 'normal';
  };

  // Transaction mode state (normal, split, or transfer)
  const [mode, setMode] = useState<TransactionMode>(getInitialMode());

  // Split transaction state
  const [isSplitMode, setIsSplitMode] = useState<boolean>(transaction?.isSplit || false);
  const [splits, setSplits] = useState<SplitRow[]>(
    transaction?.splits && transaction.splits.length > 0
      ? toSplitRows(transaction.splits)
      : []
  );

  // For transfers, determine from/to accounts based on amount sign
  // Negative amount = outgoing (from this account), Positive amount = incoming (to this account)
  const getTransferAccounts = () => {
    if (!transaction?.isTransfer || !transaction.linkedTransaction) {
      return { fromAccountId: '', toAccountId: '' };
    }

    const isOutgoing = Number(transaction.amount) < 0;
    if (isOutgoing) {
      // This transaction is the "from" side (money leaving)
      return {
        fromAccountId: transaction.accountId,
        toAccountId: transaction.linkedTransaction.accountId,
      };
    } else {
      // This transaction is the "to" side (money arriving)
      return {
        fromAccountId: transaction.linkedTransaction.accountId,
        toAccountId: transaction.accountId,
      };
    }
  };

  const initialTransferAccounts = getTransferAccounts();

  // Transfer state - initialize from linked transaction if editing a transfer
  const [transferToAccountId, setTransferToAccountId] = useState<string>(
    initialTransferAccounts.toAccountId
  );

  // Target amount for cross-currency transfers
  const [transferTargetAmount, setTransferTargetAmount] = useState<number | undefined>(() => {
    // If editing a transfer with different currencies, initialize target amount from linked transaction
    if (transaction?.isTransfer && transaction.linkedTransaction) {
      const isOutgoing = Number(transaction.amount) < 0;
      const toTx = isOutgoing ? transaction.linkedTransaction : transaction;
      return Math.abs(Number(toTx.amount));
    }
    return undefined;
  });
  // Transfer payee (optional)
  const [transferPayeeId, setTransferPayeeId] = useState<string>(
    transaction?.isTransfer ? (transaction.payeeId || '') : '',
  );
  const [transferPayeeName, setTransferPayeeName] = useState<string>(
    transaction?.isTransfer ? (transaction.payeeName || '') : '',
  );

  // Note: CurrencyInput components manage their own display state internally

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
          // For transfers, use the "from" account as the primary account
          accountId: transaction.isTransfer && initialTransferAccounts.fromAccountId
            ? initialTransferAccounts.fromAccountId
            : transaction.accountId,
          transactionDate: transaction.transactionDate,
          payeeId: transaction.payeeId || '',
          payeeName: transaction.payeeName || '',
          categoryId: transaction.categoryId || '',
          // For transfers, always show absolute amount
          amount: transaction.isTransfer
            ? Math.abs(Math.round(Number(transaction.amount) * 100) / 100)
            : Math.round(Number(transaction.amount) * 100) / 100,
          currencyCode: transaction.currencyCode,
          description: transaction.description || '',
          referenceNumber: transaction.referenceNumber || '',
          status: transaction.status || TransactionStatus.UNRECONCILED,
        }
      : {
          accountId: defaultAccountId || '',
          transactionDate: new Date().toISOString().split('T')[0],
          currencyCode: 'CAD',
          status: TransactionStatus.UNRECONCILED,
        },
  });

  const watchedAccountId = watch('accountId');
  const watchedAmount = watch('amount');
  const watchedCurrencyCode = watch('currencyCode');

  // Determine if this is a cross-currency transfer
  const crossCurrencyInfo = useMemo(() => {
    if (mode !== 'transfer' || !watchedAccountId || !transferToAccountId) {
      return null;
    }
    const fromAccount = accounts.find(a => a.id === watchedAccountId);
    const toAccount = accounts.find(a => a.id === transferToAccountId);
    if (!fromAccount || !toAccount) return null;
    if (fromAccount.currencyCode === toAccount.currencyCode) return null;
    return {
      fromCurrency: fromAccount.currencyCode,
      toCurrency: toAccount.currencyCode,
      fromAccountName: fromAccount.name,
      toAccountName: toAccount.name,
    };
  }, [mode, watchedAccountId, transferToAccountId, accounts]);

  // Memoize category tree to avoid rebuilding on every render
  const categoryTree = useMemo(() => buildCategoryTree(categories), [categories]);

  // Memoize category options for combobox
  const categoryOptions = useMemo(() => categoryTree.map(({ category }) => {
    const parentCategory = category.parentId
      ? categories.find(c => c.id === category.parentId)
      : null;
    return {
      value: category.id,
      label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
    };
  }), [categoryTree, categories]);

  // Handle mode changes
  const handleModeChange = (newMode: TransactionMode) => {
    setMode(newMode);

    if (newMode === 'split') {
      setIsSplitMode(true);
      if (splits.length === 0) {
        const amount = watchedAmount || 0;
        setSplits(createEmptySplits(amount));
      }
      setTransferToAccountId('');
    } else if (newMode === 'transfer') {
      setIsSplitMode(false);
      setSplits([]);
      // Make amount positive for transfers
      if (watchedAmount && watchedAmount < 0) {
        setValue('amount', Math.abs(watchedAmount), { shouldDirty: true, shouldValidate: true });
      }
    } else {
      setIsSplitMode(false);
      setSplits([]);
      setTransferToAccountId('');
    }
  };

  // Handle toggling split mode (legacy - redirects to handleModeChange)
  const handleSplitModeToggle = (enabled: boolean) => {
    handleModeChange(enabled ? 'split' : 'normal');
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
      })
      .catch((error) => {
        toast.error('Failed to load form data');
        logger.error(error);
      });
  }, []);

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

        // Adjust amount sign based on default category type
        const category = categories.find(c => c.id === payee.defaultCategoryId);
        if (category && watchedAmount !== undefined && watchedAmount !== 0) {
          const absAmount = Math.abs(watchedAmount);
          const newAmount = category.isIncome ? absAmount : -absAmount;
          if (newAmount !== watchedAmount) {
            setValue('amount', newAmount, { shouldDirty: true, shouldValidate: true });
          }
        }
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
      // Add to payees list
      setPayees(prev => [...prev, newPayee]);
      // Select the new payee
      setSelectedPayeeId(newPayee.id);
      setValue('payeeId', newPayee.id, { shouldDirty: true, shouldValidate: true });
      setValue('payeeName', newPayee.name, { shouldDirty: true, shouldValidate: true });
      toast.success(`Payee "${name}" created`);
    } catch (error) {
      logger.error('Failed to create payee:', error);
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

      // Adjust amount sign based on category type (income = positive, expense = negative)
      const category = categories.find(c => c.id === categoryId);
      if (category && watchedAmount !== undefined && watchedAmount !== 0) {
        const absAmount = Math.abs(watchedAmount);
        const newAmount = category.isIncome ? absAmount : -absAmount;
        if (newAmount !== watchedAmount) {
          setValue('amount', newAmount, { shouldDirty: true, shouldValidate: true });
        }
      }
    } else {
      // Custom value being typed - don't create yet, just track the name
      // Category will be created when user clicks "Create" option
      setSelectedCategoryId('');
      setValue('categoryId', '', { shouldDirty: true, shouldValidate: true });
    }
  };

  // Handle amount change - adjust sign based on selected category
  // Only auto-adjust when the absolute value changes, not when user explicitly changes sign
  const handleAmountChange = (value: number | undefined) => {
    if (value === undefined || value === 0) {
      setValue('amount', value ?? 0, { shouldValidate: true });
      return;
    }

    // Check if user is just changing the sign (same absolute value)
    const currentAbsAmount = watchedAmount !== undefined ? Math.abs(watchedAmount) : 0;
    const newAbsAmount = Math.abs(value);
    const isJustSignChange = currentAbsAmount === newAbsAmount && currentAbsAmount !== 0;

    // If user explicitly changed the sign, respect their choice
    if (isJustSignChange) {
      setValue('amount', value, { shouldValidate: true });
      return;
    }

    // If a category is selected, adjust sign based on category type
    if (selectedCategoryId && mode === 'normal') {
      const category = categories.find(c => c.id === selectedCategoryId);
      if (category) {
        const absAmount = Math.abs(value);
        const newAmount = category.isIncome ? absAmount : -absAmount;
        setValue('amount', newAmount, { shouldValidate: true });
        return;
      }
    }

    // No category selected or not normal mode, use value as-is
    setValue('amount', value, { shouldValidate: true });
  };

  // Convert string to title case (capitalize first letter of each word)
  const toTitleCase = (str: string): string => {
    return str
      .toLowerCase()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  // Handle creating a new category - called when user clicks "Create" in dropdown
  // Supports "Parent: Child" format to create subcategories
  const handleCategoryCreate = async (name: string) => {
    if (!name.trim()) return;

    try {
      let categoryName = toTitleCase(name.trim());
      let parentId: string | undefined;
      let parentName: string | undefined;

      // Check for "Parent: Child" format
      if (categoryName.includes(':')) {
        const parts = categoryName.split(':').map(p => p.trim());
        if (parts.length === 2 && parts[0] && parts[1]) {
          parentName = toTitleCase(parts[0]);
          const childName = toTitleCase(parts[1]);

          // Find existing parent category (case-insensitive, top-level only)
          let parentCategory = categories.find(
            c => c.name.toLowerCase() === parentName!.toLowerCase() && !c.parentId
          );

          // If parent doesn't exist, create it first
          if (!parentCategory) {
            const newParent = await categoriesApi.create({ name: parentName });
            setCategories(prev => [...prev, newParent]);
            parentCategory = newParent;
          }

          parentId = parentCategory.id;
          parentName = parentCategory.name; // Use actual name from existing category
          categoryName = childName;
        }
      }

      const newCategory = await categoriesApi.create({
        name: categoryName,
        parentId,
      });
      setCategories(prev => [...prev, newCategory]);
      setSelectedCategoryId(newCategory.id);
      setValue('categoryId', newCategory.id, { shouldDirty: true, shouldValidate: true });

      if (parentId && parentName) {
        toast.success(`Category "${parentName}: ${categoryName}" created`);
      } else {
        toast.success(`Category "${categoryName}" created`);
      }
    } catch (error) {
      logger.error('Failed to create category:', error);
      toast.error('Failed to create category');
    }
  };

  const onSubmit = async (data: TransactionFormData) => {
    setIsLoading(true);
    try {
      // Handle transfer mode
      if (mode === 'transfer') {
        if (!transferToAccountId) {
          toast.error('Please select a destination account');
          setIsLoading(false);
          return;
        }
        if (transferToAccountId === data.accountId) {
          toast.error('Source and destination accounts must be different');
          setIsLoading(false);
          return;
        }
        if (!data.amount || data.amount <= 0) {
          toast.error('Transfer amount must be positive');
          setIsLoading(false);
          return;
        }

        // Get the destination account's currency
        const toAccount = accounts.find(a => a.id === transferToAccountId);
        const toCurrencyCode = toAccount?.currencyCode || data.currencyCode;

        const transferData: any = {
          fromAccountId: data.accountId,
          toAccountId: transferToAccountId,
          transactionDate: data.transactionDate,
          amount: Math.abs(data.amount),
          fromCurrencyCode: data.currencyCode,
          toCurrencyCode: toCurrencyCode,
          description: data.description,
          referenceNumber: data.referenceNumber,
          status: data.status,
          payeeId: transferPayeeId || undefined,
          payeeName: transferPayeeName || undefined,
        };

        // Include target amount for cross-currency transfers
        if (crossCurrencyInfo && transferTargetAmount !== undefined && transferTargetAmount > 0) {
          transferData.toAmount = transferTargetAmount;
        }

        if (transaction?.isTransfer) {
          await transactionsApi.updateTransfer(transaction.id, transferData);
          toast.success('Transfer updated');
        } else {
          await transactionsApi.createTransfer(transferData);
          toast.success('Transfer created');
        }
        onSuccess?.();
        return;
      }

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
      logger.error('Submit error:', error);
      const message = error.response?.data?.message || 'Failed to save transaction';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Mode selector - only show for new transactions or if not already a transfer being edited */}
      {(!transaction || !transaction.isTransfer) && (
        <div className="flex space-x-2 pb-2 border-b dark:border-gray-700">
          <button
            type="button"
            onClick={() => handleModeChange('normal')}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
              mode === 'normal'
                ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            Transaction
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('split')}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
              mode === 'split'
                ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            Split
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('transfer')}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
              mode === 'transfer'
                ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            Transfer
          </button>
        </div>
      )}

      {/* Transfer mode indicator for editing existing transfers */}
      {transaction?.isTransfer && (
        <div className="flex items-center space-x-2 pb-2 border-b dark:border-gray-700">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200">
            Transfer
          </span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            This is a linked transfer transaction
          </span>
        </div>
      )}

      {/* TRANSACTION MODE LAYOUT */}
      {mode === 'normal' && (
        <div className="space-y-4">
          {/* Row 1: Account and Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Account"
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: 'Select account...' },
                ...accounts
                  .filter(account =>
                    !account.isClosed &&
                    account.accountSubType !== 'INVESTMENT_BROKERAGE'
                  )
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(account => ({
                    value: account.id,
                    label: `${account.name} (${account.currencyCode})`,
                  })
                ),
              ]}
              {...register('accountId')}
            />
            <Input
              label="Date"
              type="date"
              error={errors.transactionDate?.message}
              {...register('transactionDate')}
            />
          </div>

          {/* Row 2: Payee and Category */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                    initialDisplayValue={transaction?.category?.name || ''}
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

          {/* Row 3: Amount and Reference Number */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CurrencyInput
              label="Amount"
              prefix={getCurrencySymbol(watchedCurrencyCode)}
              value={watchedAmount}
              onChange={handleAmountChange}
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
        </div>
      )}

      {/* SPLIT MODE LAYOUT */}
      {mode === 'split' && (
        <div className="space-y-4">
          {/* Row 1: Account and Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="Account"
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: 'Select account...' },
                ...accounts
                  .filter(account =>
                    !account.isClosed &&
                    account.accountSubType !== 'INVESTMENT_BROKERAGE'
                  )
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(account => ({
                    value: account.id,
                    label: `${account.name} (${account.currencyCode})`,
                  })
                ),
              ]}
              {...register('accountId')}
            />
            <Input
              label="Date"
              type="date"
              error={errors.transactionDate?.message}
              {...register('transactionDate')}
            />
          </div>

          {/* Row 2: Payee and Total Amount */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              onCreateNew={handlePayeeCreate}
              allowCustomValue={true}
              error={errors.payeeName?.message}
            />
            <CurrencyInput
              label="Total Amount"
              prefix={getCurrencySymbol(watchedCurrencyCode)}
              value={watchedAmount}
              onChange={(value) => setValue('amount', value ?? 0, { shouldValidate: true })}
              error={errors.amount?.message}
            />
          </div>

          {/* Row 3: Reference Number */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Reference Number"
              type="text"
              placeholder="Cheque #, confirmation #..."
              error={errors.referenceNumber?.message}
              {...register('referenceNumber')}
            />
          </div>
        </div>
      )}

      {/* TRANSFER MODE LAYOUT */}
      {mode === 'transfer' && (
        <div className="space-y-4">
          {/* Row 1: Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Date"
              type="date"
              error={errors.transactionDate?.message}
              {...register('transactionDate')}
            />
          </div>

          {/* Row 2: From and To Accounts side by side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label="From Account"
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: 'Select account...' },
                ...accounts
                  .filter(account =>
                    account.accountSubType !== 'INVESTMENT_BROKERAGE' &&
                    (!account.isClosed || account.id === watchedAccountId)
                  )
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(account => ({
                    value: account.id,
                    label: `${account.name} (${account.currencyCode})${account.isClosed ? ' (Closed)' : ''}`,
                    disabled: account.isClosed && account.id !== watchedAccountId,
                  })
                ),
              ]}
              {...register('accountId')}
            />
            <Select
              label="To Account"
              value={transferToAccountId}
              onChange={(e) => {
                setTransferToAccountId(e.target.value);
                setTransferTargetAmount(undefined);
              }}
              options={[
                { value: '', label: 'Select destination account...' },
                ...accounts
                  .filter(account =>
                    account.id !== watchedAccountId &&
                    account.accountSubType !== 'INVESTMENT_BROKERAGE' &&
                    (!account.isClosed || account.id === transferToAccountId)
                  )
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(account => ({
                    value: account.id,
                    label: `${account.name} (${account.currencyCode})${account.isClosed ? ' (Closed)' : ''}`,
                    disabled: account.isClosed && account.id !== transferToAccountId,
                  })),
              ]}
            />
          </div>

          {/* Row 3: Transfer Amount under From, Received Amount under To (for cross-currency) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <CurrencyInput
                label={`Transfer Amount${crossCurrencyInfo ? ` (${crossCurrencyInfo.fromCurrency})` : ''}`}
                prefix={getCurrencySymbol(watchedCurrencyCode)}
                value={watchedAmount}
                onChange={(value) => setValue('amount', value !== undefined ? Math.abs(value) : 0, { shouldValidate: true })}
                allowNegative={false}
                error={errors.amount?.message}
              />
              {!crossCurrencyInfo && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Amount must be positive for transfers
                </p>
              )}
            </div>

            {/* Received Amount - only for cross-currency transfers */}
            {crossCurrencyInfo && (
              <div>
                <CurrencyInput
                  label={`Amount Received (${crossCurrencyInfo.toCurrency})`}
                  prefix={getCurrencySymbol(crossCurrencyInfo.toCurrency)}
                  value={transferTargetAmount}
                  onChange={(value) => setTransferTargetAmount(value !== undefined ? Math.abs(value) : undefined)}
                  allowNegative={false}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Amount received after currency conversion
                </p>
              </div>
            )}
          </div>

          {/* Row 4: Payee and Reference Number */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Combobox
              label="Payee (Optional)"
              placeholder="Select or type payee name..."
              options={payees.map(payee => ({
                value: payee.id,
                label: payee.name,
              }))}
              value={transferPayeeId}
              initialDisplayValue={transferPayeeName}
              onChange={(payeeId: string, payeeName: string) => {
                setTransferPayeeId(payeeId);
                setTransferPayeeName(payeeName);
              }}
              allowCustomValue={true}
            />
            <Input
              label="Reference Number"
              type="text"
              placeholder="Cheque #, confirmation #..."
              error={errors.referenceNumber?.message}
              {...register('referenceNumber')}
            />
          </div>
        </div>
      )}

      {/* Split Editor - shown when in split mode */}
      {isSplitMode && (
        <div className="border-t dark:border-gray-700 pt-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Split Transaction</h3>
            <button
              type="button"
              onClick={() => handleSplitModeToggle(false)}
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
            disabled={isLoading}
            onTransactionAmountChange={(amount) => setValue('amount', amount, { shouldDirty: true, shouldValidate: true })}
            currencyCode={watchedCurrencyCode || 'CAD'}
          />
        </div>
      )}

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Description
        </label>
        <textarea
          rows={3}
          className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          {...register('description')}
        />
        {errors.description && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.description.message}</p>
        )}
      </div>

      {/* Status selector */}
      <Select
        label="Status"
        options={[
          { value: TransactionStatus.UNRECONCILED, label: 'Unreconciled' },
          { value: TransactionStatus.CLEARED, label: 'Cleared' },
          { value: TransactionStatus.RECONCILED, label: 'Reconciled' },
          { value: TransactionStatus.VOID, label: 'Void' },
        ]}
        {...register('status')}
      />

      {/* Actions */}
      <div className="flex justify-end space-x-3 pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" isLoading={isLoading}>
          {transaction ? 'Update' : 'Create'} {mode === 'transfer' ? 'Transfer' : 'Transaction'}
        </Button>
      </div>
    </form>
  );
}
