'use client';

import { useForm, Resolver } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useState, useEffect, useMemo, MutableRefObject } from 'react';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import toast from 'react-hot-toast';
import { Account, PaymentFrequency } from '@/types/account';
import { Category } from '@/types/category';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { exchangeRatesApi, CurrencyInfo } from '@/lib/exchange-rates';
import { getCurrencySymbol } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { LoanFields } from './LoanFields';
import { MortgageFields } from './MortgageFields';
import { AssetFields } from './AssetFields';

import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const logger = createLogger('AccountForm');

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
const mortgagePaymentFrequencies = ['MONTHLY', 'SEMI_MONTHLY', 'BIWEEKLY', 'ACCELERATED_BIWEEKLY', 'WEEKLY', 'ACCELERATED_WEEKLY'] as const;

const accountSchema = z.object({
  name: z.string().min(1, 'Account name is required').max(255),
  accountType: z.enum([
    'CHEQUING',
    'SAVINGS',
    'CREDIT_CARD',
    'LOAN',
    'MORTGAGE',
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
  dateAcquired: z.string().optional(),
  // Mortgage-specific fields
  isCanadianMortgage: z.boolean().optional(),
  isVariableRate: z.boolean().optional(),
  termMonths: optionalNumber,
  amortizationMonths: optionalNumber,
  mortgagePaymentFrequency: z.enum(mortgagePaymentFrequencies).optional(),
});

type AccountFormData = z.infer<typeof accountSchema>;

interface AccountFormProps {
  account?: Account;
  onSubmit: (data: AccountFormData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
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


export function AccountForm({ account, onSubmit, onCancel, onDirtyChange, submitRef }: AccountFormProps) {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [_defaultLoanCategories, setDefaultLoanCategories] = useState<{
    principalId: string | null;
    interestId: string | null;
  }>({ principalId: null, interestId: null });
  const [selectedAssetCategoryId, setSelectedAssetCategoryId] = useState<string>(account?.assetCategoryId || '');
  const [assetCategoryName, setAssetCategoryName] = useState<string>('');
  const [selectedInterestCategoryId, setSelectedInterestCategoryId] = useState<string>(account?.interestCategoryId || '');

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<AccountFormData>({
    resolver: zodResolver(accountSchema) as Resolver<AccountFormData>,
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
          dateAcquired: account.dateAcquired?.split('T')[0] || undefined,
          isCanadianMortgage: account.isCanadianMortgage || false,
          isVariableRate: account.isVariableRate || false,
          termMonths: account.termMonths || undefined,
          amortizationMonths: account.amortizationMonths || undefined,
          mortgagePaymentFrequency: (account as any).mortgagePaymentFrequency || undefined,
        }
      : {
          currencyCode: defaultCurrency,
          openingBalance: 0,
          isFavourite: false,
          paymentFrequency: 'MONTHLY' as PaymentFrequency,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const watchedCurrency = watch('currencyCode');
  const watchedIsFavourite = watch('isFavourite');
  const watchedAccountType = watch('accountType');
  const watchedOpeningBalance = watch('openingBalance');
  const watchedCreditLimit = watch('creditLimit');
  const watchedInterestRate = watch('interestRate');
  const watchedPaymentAmount = watch('paymentAmount');
  const watchedPaymentFrequency = watch('paymentFrequency');
  const watchedPaymentStartDate = watch('paymentStartDate');
  const currencySymbol = getCurrencySymbol(watchedCurrency || defaultCurrency);

  // Show investment pair checkbox only when creating a new INVESTMENT account
  const showInvestmentPairOption = !account && watchedAccountType === 'INVESTMENT';

  // Show loan fields only for LOAN account type
  const isLoanAccount = watchedAccountType === 'LOAN';

  // Show asset fields only for ASSET account type
  const isAssetAccount = watchedAccountType === 'ASSET';
  const watchedDateAcquired = watch('dateAcquired');

  // Show mortgage fields only for MORTGAGE account type
  const isMortgageAccount = watchedAccountType === 'MORTGAGE';
  const watchedIsCanadianMortgage = watch('isCanadianMortgage');
  const watchedIsVariableRate = watch('isVariableRate');
  const watchedTermMonths = watch('termMonths');
  const watchedAmortizationMonths = watch('amortizationMonths');
  const watchedMortgagePaymentFrequency = watch('mortgagePaymentFrequency');

  // Load supported currencies
  useEffect(() => {
    exchangeRatesApi.getCurrencies().then(setCurrencies).catch(() => {});
  }, []);

  // Re-sync the currency select value after options load.
  // react-hook-form's register sets the select value on mount, but if options
  // haven't loaded yet, the browser ignores it. When options arrive, the select
  // defaults to the first option instead of the form's actual value.
  useEffect(() => {
    if (currencies.length > 0) {
      const current = getValues('currencyCode');
      if (current) {
        setValue('currencyCode', current, { shouldDirty: false });
      }
    }
  }, [currencies, setValue, getValues]);

  // Build currency options: default currency first, then alphabetical
  const currencyOptions = useMemo(() => {
    const sorted = [...currencies].sort((a, b) => {
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
    return sorted.map((c) => ({
      value: c.code,
      label: `${c.code} - ${c.name} (${c.symbol})`,
    }));
  }, [currencies, defaultCurrency]);

  // Load accounts and categories when LOAN, MORTGAGE, or ASSET type is selected
  // For loans/mortgages: only when creating new (payment setup is done at creation)
  // For assets: always (to allow editing the value change category)
  useEffect(() => {
    const shouldLoadForLoan = isLoanAccount && !account;
    const shouldLoadForMortgage = isMortgageAccount;
    const shouldLoadForAsset = isAssetAccount;

    if (shouldLoadForLoan || shouldLoadForMortgage || shouldLoadForAsset) {
      const loadData = async () => {
        try {
          const [accountsData, categoriesData] = await Promise.all([
            accountsApi.getAll(false),
            categoriesApi.getAll(),
          ]);
          // Filter out loan and mortgage accounts from source account options
          setAccounts(accountsData.filter(a => a.accountType !== 'LOAN' && a.accountType !== 'MORTGAGE'));
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
                setSelectedInterestCategoryId(interestCat.id);
              }
            }
          }

          if (isMortgageAccount && !account) {
            // Find default mortgage interest category (fallback to loan interest)
            const mortgageParent = categoriesData.find(c => c.name === 'Mortgage' && !c.parentId);
            const loanParent = categoriesData.find(c => c.name === 'Loan' && !c.parentId);
            const parent = mortgageParent || loanParent;
            if (parent) {
              const interestCat = categoriesData.find(
                c => (c.name === 'Mortgage Interest' || c.name === 'Loan Interest') && c.parentId === parent.id
              );
              if (interestCat && !getValues('interestCategoryId')) {
                setValue('interestCategoryId', interestCat.id);
                setSelectedInterestCategoryId(interestCat.id);
              }
            }
          }
        } catch (error) {
          logger.error('Failed to load accounts/categories:', error);
        }
      };
      loadData();
    }
  }, [isLoanAccount, isMortgageAccount, isAssetAccount, account, setValue, getValues]);

  const toggleFavourite = () => {
    setValue('isFavourite', !watchedIsFavourite, { shouldDirty: true });
  };

  const handleImportQif = () => {
    if (account) {
      router.push(`/import?accountId=${account.id}`);
    }
  };

  // Handle interest category selection (for loan/mortgage)
  const handleInterestCategoryChange = (categoryId: string) => {
    setSelectedInterestCategoryId(categoryId);
    setValue('interestCategoryId', categoryId || '', { shouldDirty: true, shouldValidate: true });
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
      logger.error('Failed to create category:', error);
      toast.error(getErrorMessage(error, 'Failed to create category'));
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
        <Select
          label="Currency"
          options={currencyOptions}
          error={errors.currencyCode?.message}
          {...register('currencyCode')}
        />

        <CurrencyInput
          label={isLoanAccount ? 'Loan Amount' : isMortgageAccount ? 'Mortgage Amount' : 'Opening Balance'}
          prefix={currencySymbol}
          value={watchedOpeningBalance}
          onChange={(value) => setValue('openingBalance', value, { shouldValidate: true })}
          error={errors.openingBalance?.message}
          allowNegative={false}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Account Number (optional)"
          error={errors.accountNumber?.message}
          {...register('accountNumber')}
        />

        <Input
          label={isLoanAccount || isMortgageAccount ? 'Lender/Institution (required)' : 'Institution (optional)'}
          error={errors.institution?.message}
          {...register('institution')}
        />
      </div>

      {/* Credit Limit and Interest Rate - hide for loans, mortgages, and assets */}
      {!isAssetAccount && (
        <div className="grid grid-cols-2 gap-4">
          {!isLoanAccount && !isMortgageAccount && (
            <CurrencyInput
              label="Credit Limit (optional)"
              prefix={currencySymbol}
              value={watchedCreditLimit}
              onChange={(value) => setValue('creditLimit', value, { shouldValidate: true })}
              error={errors.creditLimit?.message}
              allowNegative={false}
            />
          )}

          <Input
            label={(isLoanAccount || isMortgageAccount) ? 'Interest Rate % (required)' : 'Interest Rate % (optional)'}
            type="number"
            step="0.01"
            error={errors.interestRate?.message}
            {...register('interestRate', { valueAsNumber: true })}
          />

          {(isLoanAccount || isMortgageAccount) && <div />} {/* Spacer for grid alignment */}
        </div>
      )}

      {isLoanAccount && !account && (
        <LoanFields
          currencySymbol={currencySymbol}
          watchedCurrency={watchedCurrency}
          paymentAmount={watchedPaymentAmount}
          interestRate={watchedInterestRate}
          paymentFrequency={watchedPaymentFrequency}
          paymentStartDate={watchedPaymentStartDate}
          openingBalance={watchedOpeningBalance}
          setValue={setValue}
          register={register}
          errors={errors}
          accounts={accounts}
          categories={categories}
          formatCurrency={formatCurrency}
          selectedInterestCategoryId={selectedInterestCategoryId}
          handleInterestCategoryChange={handleInterestCategoryChange}
        />
      )}

      {isMortgageAccount && (
        <MortgageFields
          watchedCurrency={watchedCurrency}
          openingBalance={watchedOpeningBalance}
          interestRate={watchedInterestRate}
          paymentStartDate={watchedPaymentStartDate}
          isCanadianMortgage={watchedIsCanadianMortgage}
          isVariableRate={watchedIsVariableRate}
          termMonths={watchedTermMonths}
          amortizationMonths={watchedAmortizationMonths}
          mortgagePaymentFrequency={watchedMortgagePaymentFrequency}
          setValue={setValue}
          register={register}
          errors={errors}
          accounts={accounts}
          categories={categories}
          formatCurrency={formatCurrency}
          isEditing={!!account}
          selectedInterestCategoryId={selectedInterestCategoryId}
          handleInterestCategoryChange={handleInterestCategoryChange}
        />
      )}

      {isAssetAccount && (
        <AssetFields
          categories={categories}
          selectedAssetCategoryId={selectedAssetCategoryId}
          assetCategoryName={assetCategoryName}
          accountAssetCategoryId={account?.assetCategoryId}
          handleAssetCategoryChange={handleAssetCategoryChange}
          handleAssetCategoryCreate={handleAssetCategoryCreate}
          register={register}
          errors={errors}
          watchedDateAcquired={watchedDateAcquired}
        />
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

      <FormActions onCancel={onCancel} submitLabel={account ? 'Update Account' : 'Create Account'} isSubmitting={isSubmitting} />
    </form>
  );
}
