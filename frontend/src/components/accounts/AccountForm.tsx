'use client';

import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useState, useEffect, useCallback } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import toast from 'react-hot-toast';
import { Account, AccountType, AmortizationPreview, PaymentFrequency } from '@/types/account';
import { Category } from '@/types/category';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { formatCurrency } from '@/lib/format';

// Helper to handle optional numeric fields that may be NaN from empty inputs
const optionalNumber = z.preprocess(
  (val: unknown) => (val === '' || val === undefined || (typeof val === 'number' && isNaN(val)) ? undefined : val),
  z.number().optional()
);

const optionalNumberWithRange = (min: number, max: number) =>
  z.preprocess(
    (val: unknown) => (val === '' || val === undefined || (typeof val === 'number' && isNaN(val)) ? undefined : val),
    z.number().min(min).max(max).optional()
  );

const paymentFrequencies = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const;

const accountSchema = z.object({
  name: z.string().min(1, 'Account name is required').max(255),
  accountType: z.enum([
    'CHEQUING',
    'SAVINGS',
    'CREDIT_CARD',
    'LOAN',
    'MORTGAGE',
    'RRSP',
    'TFSA',
    'RESP',
    'INVESTMENT',
    'CASH',
    'LINE_OF_CREDIT',
    'ASSET',
    'OTHER',
  ]),
  currencyCode: z.string().length(3, 'Currency code must be 3 characters'),
  openingBalance: optionalNumber,
  creditLimit: optionalNumber,
  interestRate: optionalNumberWithRange(0, 100),
  description: z.string().optional(),
  accountNumber: z.string().optional(),
  institution: z.string().optional(),
  isFavourite: z.boolean().optional(),
  createInvestmentPair: z.boolean().optional(),
  // Loan-specific fields
  paymentAmount: optionalNumber,
  paymentFrequency: z.enum(paymentFrequencies).optional(),
  paymentStartDate: z.string().optional(),
  sourceAccountId: z.string().optional(),
  interestCategoryId: z.string().optional(),
  // Asset-specific fields
  assetCategoryId: z.string().optional(),
});

type AccountFormData = z.infer<typeof accountSchema>;

interface AccountFormProps {
  account?: Account;
  onSubmit: (data: AccountFormData) => Promise<void>;
  onCancel: () => void;
}

const accountTypeOptions = [
  { value: 'CHEQUING', label: 'Chequing' },
  { value: 'SAVINGS', label: 'Savings' },
  { value: 'CREDIT_CARD', label: 'Credit Card' },
  { value: 'INVESTMENT', label: 'Investment' },
  { value: 'LOAN', label: 'Loan' },
  { value: 'LINE_OF_CREDIT', label: 'Line of Credit' },
  { value: 'MORTGAGE', label: 'Mortgage' },
  { value: 'ASSET', label: 'Asset' },
  { value: 'CASH', label: 'Cash' },
  { value: 'OTHER', label: 'Other' },
];

const currencySymbols: Record<string, string> = {
  CAD: '$',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

const paymentFrequencyOptions = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Every 2 Weeks' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'YEARLY', label: 'Yearly' },
];

export function AccountForm({ account, onSubmit, onCancel }: AccountFormProps) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [amortizationPreview, setAmortizationPreview] = useState<AmortizationPreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [defaultLoanCategories, setDefaultLoanCategories] = useState<{
    principalId: string | null;
    interestId: string | null;
  }>({ principalId: null, interestId: null });
  const [selectedAssetCategoryId, setSelectedAssetCategoryId] = useState<string>(account?.assetCategoryId || '');
  const [assetCategoryName, setAssetCategoryName] = useState<string>('');

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormData>({
    resolver: zodResolver(accountSchema),
    defaultValues: account
      ? {
          name: account.name,
          accountType: account.accountType,
          currencyCode: account.currencyCode,
          openingBalance: account.openingBalance !== undefined
            ? Math.round(Math.abs(Number(account.openingBalance)) * 100) / 100
            : undefined,
          creditLimit: account.creditLimit
            ? Math.round(Number(account.creditLimit) * 100) / 100
            : undefined,
          interestRate: account.interestRate || undefined,
          description: account.description || undefined,
          accountNumber: account.accountNumber || undefined,
          institution: account.institution || undefined,
          isFavourite: account.isFavourite || false,
          paymentAmount: account.paymentAmount
            ? Math.round(Number(account.paymentAmount) * 100) / 100
            : undefined,
          paymentFrequency: account.paymentFrequency as PaymentFrequency || undefined,
          paymentStartDate: account.paymentStartDate?.split('T')[0] || undefined,
          sourceAccountId: account.sourceAccountId || undefined,
          interestCategoryId: account.interestCategoryId || undefined,
          assetCategoryId: account.assetCategoryId || undefined,
        }
      : {
          currencyCode: 'CAD',
          openingBalance: 0,
          isFavourite: false,
          paymentFrequency: 'MONTHLY' as PaymentFrequency,
        },
  });

  const watchedCurrency = watch('currencyCode');
  const watchedIsFavourite = watch('isFavourite');
  const watchedAccountType = watch('accountType');
  const watchedCreateInvestmentPair = watch('createInvestmentPair');
  const watchedOpeningBalance = watch('openingBalance');
  const watchedInterestRate = watch('interestRate');
  const watchedPaymentAmount = watch('paymentAmount');
  const watchedPaymentFrequency = watch('paymentFrequency');
  const watchedPaymentStartDate = watch('paymentStartDate');
  const currencySymbol = currencySymbols[watchedCurrency] || '$';

  // Show investment pair checkbox only when creating a new INVESTMENT account
  const showInvestmentPairOption = !account && watchedAccountType === 'INVESTMENT';

  // Show loan fields only for LOAN account type
  const isLoanAccount = watchedAccountType === 'LOAN';

  // Show asset fields only for ASSET account type
  const isAssetAccount = watchedAccountType === 'ASSET';

  // Load accounts and categories when LOAN or ASSET type is selected
  // For loans: only when creating new (loan payment setup is done at creation)
  // For assets: always (to allow editing the value change category)
  useEffect(() => {
    const shouldLoadForLoan = isLoanAccount && !account;
    const shouldLoadForAsset = isAssetAccount;

    if (shouldLoadForLoan || shouldLoadForAsset) {
      const loadData = async () => {
        try {
          const [accountsData, categoriesData] = await Promise.all([
            accountsApi.getAll(false),
            categoriesApi.getAll(),
          ]);
          // Filter out loan accounts from source account options
          setAccounts(accountsData.filter(a => a.accountType !== 'LOAN'));
          setCategories(categoriesData);

          if (isLoanAccount && !account) {
            // Find default loan interest category
            const loanParent = categoriesData.find(c => c.name === 'Loan' && !c.parentId);
            if (loanParent) {
              const interestCat = categoriesData.find(
                c => c.name === 'Loan Interest' && c.parentId === loanParent.id
              );
              setDefaultLoanCategories({
                principalId: null,
                interestId: interestCat?.id || null,
              });
              // Set default interest category if not already set
              if (interestCat && !getValues('interestCategoryId')) {
                setValue('interestCategoryId', interestCat.id);
              }
            }
          }
        } catch (error) {
          console.error('Failed to load accounts/categories:', error);
        }
      };
      loadData();
    }
  }, [isLoanAccount, isAssetAccount, account, setValue, getValues]);

  // Calculate amortization preview when loan fields change
  const calculatePreview = useCallback(async () => {
    if (!isLoanAccount || !watchedOpeningBalance || !watchedInterestRate ||
        !watchedPaymentAmount || !watchedPaymentFrequency || !watchedPaymentStartDate) {
      setAmortizationPreview(null);
      return;
    }

    setIsLoadingPreview(true);
    try {
      const preview = await accountsApi.previewLoanAmortization({
        loanAmount: watchedOpeningBalance,
        interestRate: watchedInterestRate,
        paymentAmount: watchedPaymentAmount,
        paymentFrequency: watchedPaymentFrequency,
        paymentStartDate: watchedPaymentStartDate,
      });
      setAmortizationPreview(preview);
    } catch (error) {
      console.error('Failed to calculate preview:', error);
      setAmortizationPreview(null);
    } finally {
      setIsLoadingPreview(false);
    }
  }, [isLoanAccount, watchedOpeningBalance, watchedInterestRate, watchedPaymentAmount, watchedPaymentFrequency, watchedPaymentStartDate]);

  // Debounced preview calculation
  useEffect(() => {
    const timer = setTimeout(() => {
      calculatePreview();
    }, 500);
    return () => clearTimeout(timer);
  }, [calculatePreview]);

  const toggleFavourite = () => {
    setValue('isFavourite', !watchedIsFavourite, { shouldDirty: true });
  };

  const handleImportQif = () => {
    if (account) {
      router.push(`/import?accountId=${account.id}`);
    }
  };

  // Handle asset category selection
  const handleAssetCategoryChange = (categoryId: string, name: string) => {
    setAssetCategoryName(name);
    if (categoryId) {
      setSelectedAssetCategoryId(categoryId);
      setValue('assetCategoryId', categoryId, { shouldDirty: true, shouldValidate: true });
    }
  };

  // Convert string to title case (capitalize first letter of each word)
  const toTitleCase = (str: string): string => {
    return str
      .toLowerCase()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  // Handle asset category creation - supports "Parent: Child" format
  const handleAssetCategoryCreate = async (name: string) => {
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
        isIncome: false, // Asset value changes are typically not income
      });
      setCategories(prev => [...prev, newCategory]);
      setSelectedAssetCategoryId(newCategory.id);
      setAssetCategoryName(parentName ? `${parentName}: ${categoryName}` : categoryName);
      setValue('assetCategoryId', newCategory.id, { shouldDirty: true, shouldValidate: true });

      if (parentId && parentName) {
        toast.success(`Category "${parentName}: ${categoryName}" created`);
      } else {
        toast.success(`Category "${categoryName}" created`);
      }
    } catch (error) {
      console.error('Failed to create category:', error);
      toast.error('Failed to create category');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label="Account Name"
        error={errors.name?.message}
        {...register('name')}
      />

      <Select
        label="Account Type"
        options={accountTypeOptions}
        error={errors.accountType?.message}
        {...register('accountType')}
      />

      {/* Investment account pair option */}
      {showInvestmentPairOption && (
        <div className="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
          <input
            type="checkbox"
            id="createInvestmentPair"
            className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            {...register('createInvestmentPair')}
          />
          <label htmlFor="createInvestmentPair" className="flex-1">
            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Create as Cash + Brokerage pair (recommended)
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">
              Creates two linked accounts: a Cash account for transfers in/out and a
              Brokerage account for investment transactions. This is the recommended
              structure for tracking investments.
            </span>
          </label>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Currency Code"
          placeholder="CAD"
          error={errors.currencyCode?.message}
          {...register('currencyCode')}
        />

        <Input
          label={isLoanAccount ? 'Loan Amount' : 'Opening Balance'}
          type="text"
          inputMode="decimal"
          prefix={currencySymbol}
          error={errors.openingBalance?.message}
          {...register('openingBalance', {
            setValueAs: (v) => {
              if (v === '' || v === undefined) return undefined;
              const parsed = parseFloat(v);
              return isNaN(parsed) ? undefined : parsed;
            },
          })}
          onBlur={(e) => {
            const value = parseFloat(e.target.value);
            if (!isNaN(value)) {
              const rounded = Math.round(value * 100) / 100;
              e.target.value = rounded.toFixed(2);
              setValue('openingBalance', rounded, { shouldValidate: true });
            }
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Account Number (optional)"
          error={errors.accountNumber?.message}
          {...register('accountNumber')}
        />

        <Input
          label={isLoanAccount ? 'Lender/Institution (required)' : 'Institution (optional)'}
          error={errors.institution?.message}
          {...register('institution')}
        />
      </div>

      {/* Credit Limit and Interest Rate - hide for loans and assets */}
      {!isAssetAccount && (
        <div className="grid grid-cols-2 gap-4">
          {!isLoanAccount && (
            <Input
              label="Credit Limit (optional)"
              type="text"
              inputMode="decimal"
              prefix={currencySymbol}
              error={errors.creditLimit?.message}
              {...register('creditLimit', {
                setValueAs: (v) => {
                  if (v === '' || v === undefined) return undefined;
                  const parsed = parseFloat(v);
                  return isNaN(parsed) ? undefined : parsed;
                },
              })}
              onBlur={(e) => {
                const value = parseFloat(e.target.value);
                if (!isNaN(value)) {
                  const rounded = Math.round(value * 100) / 100;
                  e.target.value = rounded.toFixed(2);
                  setValue('creditLimit', rounded, { shouldValidate: true });
                }
              }}
            />
          )}

          <Input
            label={isLoanAccount ? 'Interest Rate % (required)' : 'Interest Rate % (optional)'}
            type="number"
            step="0.01"
            error={errors.interestRate?.message}
            {...register('interestRate', { valueAsNumber: true })}
          />

          {isLoanAccount && <div />} {/* Spacer for grid alignment */}
        </div>
      )}

      {/* Loan-specific fields */}
      {isLoanAccount && !account && (
        <div className="space-y-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Loan Payment Details
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Payment Amount (required)"
              type="text"
              inputMode="decimal"
              prefix={currencySymbol}
              error={errors.paymentAmount?.message}
              {...register('paymentAmount', {
                setValueAs: (v) => {
                  if (v === '' || v === undefined) return undefined;
                  const parsed = parseFloat(v);
                  return isNaN(parsed) ? undefined : parsed;
                },
              })}
              onBlur={(e) => {
                const value = parseFloat(e.target.value);
                if (!isNaN(value)) {
                  const rounded = Math.round(value * 100) / 100;
                  e.target.value = rounded.toFixed(2);
                  setValue('paymentAmount', rounded, { shouldValidate: true });
                }
              }}
            />

            <Select
              label="Payment Frequency (required)"
              options={[
                { value: '', label: 'Select frequency...' },
                ...paymentFrequencyOptions,
              ]}
              error={errors.paymentFrequency?.message}
              {...register('paymentFrequency')}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="First Payment Date (required)"
              type="date"
              error={errors.paymentStartDate?.message}
              {...register('paymentStartDate')}
            />

            <Select
              label="Payment From Account (required)"
              options={[
                { value: '', label: 'Select account...' },
                ...accounts
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(a => ({
                    value: a.id,
                    label: `${a.name} (${a.currencyCode})`,
                  })),
              ]}
              error={errors.sourceAccountId?.message}
              {...register('sourceAccountId')}
            />
          </div>

          <Select
            label="Interest Category"
            options={[
              { value: '', label: 'Select category...' },
              ...categories
                .map(c => ({
                  value: c.id,
                  label: c.parentId
                    ? `${categories.find(p => p.id === c.parentId)?.name || ''}: ${c.name}`
                    : c.name,
                }))
                .sort((a, b) => a.label.localeCompare(b.label)),
            ]}
            error={errors.interestCategoryId?.message}
            {...register('interestCategoryId')}
          />

          {/* Amortization Preview */}
          {amortizationPreview && (
            <div className="p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                Payment Preview (First Payment)
              </h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Principal:</span>{' '}
                  <span className="font-medium">{formatCurrency(amortizationPreview.principalPayment, watchedCurrency)}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Interest:</span>{' '}
                  <span className="font-medium">{formatCurrency(amortizationPreview.interestPayment, watchedCurrency)}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Total Payments:</span>{' '}
                  <span className="font-medium">
                    {amortizationPreview.totalPayments > 0 ? amortizationPreview.totalPayments : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Est. Payoff:</span>{' '}
                  <span className="font-medium">
                    {amortizationPreview.totalPayments > 0
                      ? new Date(amortizationPreview.endDate).toLocaleDateString()
                      : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          )}
          {isLoadingPreview && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Calculating preview...
            </div>
          )}
        </div>
      )}

      {/* Asset-specific fields */}
      {isAssetAccount && (
        <div className="space-y-4 p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Asset Value Change Settings
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Select a category that will be used to track value changes for this asset (e.g., "Home Value Change", "Vehicle Depreciation").
          </p>
          <Combobox
            label="Value Change Category"
            placeholder="Select or create category..."
            options={categories.map(c => ({
              value: c.id,
              label: c.parentId
                ? `${categories.find(p => p.id === c.parentId)?.name || ''}: ${c.name}`
                : c.name,
            })).sort((a, b) => a.label.localeCompare(b.label))}
            value={selectedAssetCategoryId}
            initialDisplayValue={assetCategoryName || account?.assetCategoryId ? categories.find(c => c.id === (selectedAssetCategoryId || account?.assetCategoryId))?.name : ''}
            onChange={handleAssetCategoryChange}
            onCreateNew={handleAssetCategoryCreate}
            allowCustomValue={true}
          />
        </div>
      )}

      <Input
        label="Description (optional)"
        error={errors.description?.message}
        {...register('description')}
      />

      {/* Favourite star toggle */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={toggleFavourite}
          className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          title={watchedIsFavourite ? 'Remove from favourites' : 'Add to favourites'}
        >
          <svg
            className={`w-5 h-5 transition-colors ${
              watchedIsFavourite
                ? 'text-yellow-500 fill-current'
                : 'text-gray-400 dark:text-gray-500'
            }`}
            fill={watchedIsFavourite ? 'currentColor' : 'none'}
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
          <span className="text-sm text-gray-700 dark:text-gray-300">
            {watchedIsFavourite ? 'Favourite' : 'Add to favourites'}
          </span>
        </button>
        {/* Hidden input for form registration */}
        <input type="hidden" {...register('isFavourite')} />

        {/* Import QIF button - only shown when editing */}
        {account && (
          <button
            type="button"
            onClick={handleImportQif}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            title="Import transactions from QIF file"
          >
            <svg
              className="w-5 h-5 text-gray-500 dark:text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            <span className="text-sm text-gray-700 dark:text-gray-300">Import QIF</span>
          </button>
        )}
      </div>

      <div className="flex justify-end space-x-3 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {account ? 'Update Account' : 'Create Account'}
        </Button>
      </div>
    </form>
  );
}
