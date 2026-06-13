'use client';

import { useForm, useWatch, Resolver, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useState, useEffect, useMemo, MutableRefObject } from 'react';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { InstitutionForm } from '@/components/institutions/InstitutionForm';
import { institutionsApi } from '@/lib/institutions';
import { Institution } from '@/types/institution';
import { useAuthStore } from '@/store/authStore';
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
import { AccountExportModal } from './AccountExportModal';
import { LoanPaymentSetupDialog } from './LoanPaymentSetupDialog';

import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
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

const buildAccountSchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t('validation.nameRequired')).max(255),
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
    'HSA',
    'FSA',
    'DCFSA',
    '401K',
    '403B',
    'TRADITIONAL_IRA',
    'ROTH_IRA',
    '529_PLAN',
    'HELOC',
    'PROPERTY',
    'VEHICLE',
    'LIABILITY',
  ]),
  currencyCode: z.string().length(3, t('validation.currencyCodeLength')),
  openingBalance: optionalNumber,
  creditLimit: optionalNumber,
  interestRate: optionalNumberWithRange(0, 100),
  description: z.string().optional(),
  accountNumber: z.string().optional(),
  institutionId: z.string().optional(),
  isFavourite: z.boolean().optional(),
  excludeFromNetWorth: z.boolean().optional(),
  createInvestmentPair: z.boolean().optional(),
  // Credit card statement fields
  statementDueDay: optionalNumberWithRange(1, 31),
  statementSettlementDay: optionalNumberWithRange(1, 31),
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

type AccountFormData = z.infer<ReturnType<typeof buildAccountSchema>>;

interface AccountFormProps {
  account?: Account;
  onSubmit: (data: AccountFormData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function AccountForm({ account, onSubmit, onCancel, onDirtyChange, submitRef }: AccountFormProps) {
  const t = useTranslations('accounts');
  const router = useRouter();

  const accountTypeOptions = [
    { value: 'CHEQUING', label: t('form.accountTypeOptions.chequing') },
    { value: 'SAVINGS', label: t('form.accountTypeOptions.savings') },
    { value: 'CREDIT_CARD', label: t('form.accountTypeOptions.creditCard') },
    { value: 'INVESTMENT', label: t('form.accountTypeOptions.investment') },
    { value: 'LOAN', label: t('form.accountTypeOptions.loan') },
    { value: 'LINE_OF_CREDIT', label: t('form.accountTypeOptions.lineOfCredit') },
    { value: 'MORTGAGE', label: t('form.accountTypeOptions.mortgage') },
    { value: 'ASSET', label: t('form.accountTypeOptions.asset') },
    { value: 'CASH', label: t('form.accountTypeOptions.cash') },
    { value: 'OTHER', label: t('form.accountTypeOptions.other') },
    { value: 'HSA', label: t('form.accountTypeOptions.hsa') },
    { value: 'FSA', label: t('form.accountTypeOptions.fsa') },
    { value: 'DCFSA', label: t('form.accountTypeOptions.dcfsa') },
    { value: '401K', label: t('form.accountTypeOptions.401k') },
    { value: '403B', label: t('form.accountTypeOptions.403b') },
    { value: 'TRADITIONAL_IRA', label: t('form.accountTypeOptions.traditionalIra') },
    { value: 'ROTH_IRA', label: t('form.accountTypeOptions.rothIra') },
    { value: '529_PLAN', label: t('form.accountTypeOptions.529Plan') },
    { value: 'HELOC', label: t('form.accountTypeOptions.heloc') },
    { value: 'PROPERTY', label: t('form.accountTypeOptions.property') },
    { value: 'VEHICLE', label: t('form.accountTypeOptions.vehicle') },
    { value: 'LIABILITY', label: t('form.accountTypeOptions.liability') },
  ];
  const { formatCurrency } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [activeTab, setActiveTab] = useState<'offline' | 'other'>('offline');
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
  const [showLoanSetupDialog, setShowLoanSetupDialog] = useState(false);
  const [hasScheduledPayment, setHasScheduledPayment] = useState(!!account?.scheduledTransactionId);
  // Currency becomes locked once the account has any transactions so existing
  // balances are not silently re-denominated. Stays unlocked while loading.
  const [isCurrencyLocked, setIsCurrencyLocked] = useState(false);
  // Financial institution selection + inline create.
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [selectedInstitutionId, setSelectedInstitutionId] = useState<string>(account?.institutionId || '');
  const [showInstitutionModal, setShowInstitutionModal] = useState(false);
  const [pendingInstitutionName, setPendingInstitutionName] = useState('');

  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<AccountFormData>({
    resolver: zodResolver(buildAccountSchema(t)) as Resolver<AccountFormData>,
    defaultValues: account
      ? {
          name: account.name,
          accountType: account.accountType,
          currencyCode: account.currencyCode,
          openingBalance: account.openingBalance !== undefined
            ? (account.accountType === 'LOAN' || account.accountType === 'MORTGAGE'
              ? Math.round(Math.abs(Number(account.openingBalance)) * 100) / 100
              : Math.round(Number(account.openingBalance) * 100) / 100)
            : undefined,
          creditLimit: account.creditLimit
            ? Math.round(Number(account.creditLimit) * 100) / 100
            : undefined,
          interestRate: account.interestRate || undefined,
          description: account.description || undefined,
          accountNumber: account.accountNumber || undefined,
          institutionId: account.institutionId || undefined,
          isFavourite: account.isFavourite || false,
          excludeFromNetWorth: account.excludeFromNetWorth || false,
          statementDueDay: account.statementDueDay || undefined,
          statementSettlementDay: account.statementSettlementDay || undefined,
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
          excludeFromNetWorth: false,
          paymentFrequency: 'MONTHLY' as PaymentFrequency,
          createInvestmentPair: true,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const watchedCurrency = useWatch({ control, name: 'currencyCode' });
  const watchedIsFavourite = useWatch({ control, name: 'isFavourite' });
  // Account edits are owner-only. A delegate sets favourites from the
  // account list (their own overlay), so the in-form toggle is hidden for
  // them to avoid an owner-only save error.
  const isDelegateView = useAuthStore((s) => !!s.actingAsUserId);
  const watchedAccountType = useWatch({ control, name: 'accountType' });
  const watchedOpeningBalance = useWatch({ control, name: 'openingBalance' });
  const watchedCreditLimit = useWatch({ control, name: 'creditLimit' });
  const watchedInterestRate = useWatch({ control, name: 'interestRate' });
  const watchedPaymentAmount = useWatch({ control, name: 'paymentAmount' });
  const watchedPaymentFrequency = useWatch({ control, name: 'paymentFrequency' });
  const watchedPaymentStartDate = useWatch({ control, name: 'paymentStartDate' });
  const currencySymbol = getCurrencySymbol(watchedCurrency || defaultCurrency);

  // Show investment pair checkbox only when creating a new INVESTMENT account
  const showInvestmentPairOption = !account && watchedAccountType === 'INVESTMENT';

  // Show credit card fields for CREDIT_CARD account type
  const isCreditCardAccount = watchedAccountType === 'CREDIT_CARD';

  // Show loan fields only for LOAN account type
  const isLoanAccount = watchedAccountType === 'LOAN';

  // Show asset fields for ASSET, PROPERTY, and VEHICLE account types
  const isAssetAccount = watchedAccountType === 'ASSET' || watchedAccountType === 'PROPERTY' || watchedAccountType === 'VEHICLE';
  const isLiabilityAccount = watchedAccountType === 'LIABILITY';
  const watchedDateAcquired = useWatch({ control, name: 'dateAcquired' });

  // Show mortgage fields only for MORTGAGE account type
  const isMortgageAccount = watchedAccountType === 'MORTGAGE';
  const watchedIsCanadianMortgage = useWatch({ control, name: 'isCanadianMortgage' });
  const watchedIsVariableRate = useWatch({ control, name: 'isVariableRate' });
  const watchedTermMonths = useWatch({ control, name: 'termMonths' });
  const watchedAmortizationMonths = useWatch({ control, name: 'amortizationMonths' });
  const watchedMortgagePaymentFrequency = useWatch({ control, name: 'mortgagePaymentFrequency' });

  // Load supported currencies
  useEffect(() => {
    exchangeRatesApi.getCurrencies().then(setCurrencies).catch(() => {});
  }, []);

  // Load financial institutions for the selector
  useEffect(() => {
    institutionsApi.getAll().then(setInstitutions).catch(() => {});
  }, []);

  const institutionOptions = useMemo(
    () => institutions.map((i) => ({ value: i.id, label: i.name, subtitle: i.website })),
    [institutions],
  );

  const accountInstitutionId = account?.institutionId;
  const initialInstitutionName = useMemo(() => {
    if (!accountInstitutionId) return '';
    return institutions.find((i) => i.id === accountInstitutionId)?.name || '';
  }, [accountInstitutionId, institutions]);

  const handleInstitutionChange = (value: string) => {
    setSelectedInstitutionId(value);
    setValue('institutionId', value || undefined, { shouldDirty: true });
  };

  const handleInstitutionCreate = (name: string) => {
    setPendingInstitutionName(name);
    setShowInstitutionModal(true);
  };

  const handleInstitutionCreated = async (data: {
    name: string;
    website: string;
    country?: string;
  }) => {
    try {
      const created = await institutionsApi.create(data);
      setInstitutions((prev) => [created, ...prev]);
      setSelectedInstitutionId(created.id);
      setValue('institutionId', created.id, { shouldDirty: true });
      setShowInstitutionModal(false);
      toast.success(t('toasts.institutionCreated', { name: created.name }));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.institutionCreateFailed')));
      throw error;
    }
  };

  // For existing accounts, check whether any transactions exist. The backend
  // rejects currency changes once transactions are present; mirror that in the
  // UI by locking the field with an explanatory tooltip.
  useEffect(() => {
    if (!account?.id) return;
    accountsApi
      .canDelete(account.id)
      .then(({ transactionCount, investmentTransactionCount }) => {
        setIsCurrencyLocked(
          transactionCount > 0 || investmentTransactionCount > 0,
        );
      })
      .catch((error) => {
        logger.error('Failed to load account transaction count:', error);
      });
  }, [account?.id]);

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

  // Load accounts and categories when LOAN, MORTGAGE, LINE_OF_CREDIT, or ASSET type is selected
  // For assets: always (to allow editing the value change category)
  // For loans/mortgages: for new creation or when editing accounts that need payment setup
  const isLineOfCreditAccount = watchedAccountType === 'LINE_OF_CREDIT';
  useEffect(() => {
    const shouldLoadForLoan = isLoanAccount;
    const shouldLoadForMortgage = isMortgageAccount;
    const shouldLoadForLineOfCredit = isLineOfCreditAccount;
    const shouldLoadForAsset = isAssetAccount;

    if (shouldLoadForLoan || shouldLoadForMortgage || shouldLoadForLineOfCredit || shouldLoadForAsset) {
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
  }, [isLoanAccount, isMortgageAccount, isLineOfCreditAccount, isAssetAccount, account, setValue, getValues]);

  const toggleFavourite = () => {
    setValue('isFavourite', !watchedIsFavourite, { shouldDirty: true });
  };

  const handleImportQif = () => {
    if (account) {
      const accountId = account.id;
      // Close the modal first so its history entry is cleaned up
      // before navigating. Without this, the Modal's unmount cleanup
      // calls history.back() which navigates away from the import page.
      onCancel();
      setTimeout(() => {
        router.push(`/import?accountId=${accountId}`);
      }, 100);
    }
  };

  const [showExportModal, setShowExportModal] = useState(false);

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
        toast.success(t('toasts.categoryCreatedNested', { parent: parentName, name: categoryName }));
      } else {
        toast.success(t('toasts.categoryCreated', { name: categoryName }));
      }
    } catch (error) {
      logger.error('Failed to create category:', error);
      toast.error(getErrorMessage(error, t('toasts.categoryCreateFailed')));
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label={t('form.accountName')}
        error={errors.name?.message}
        {...register('name')}
      />

      {account ? (
        <Select
          label={t('form.accountType')}
          options={accountTypeOptions}
          error={errors.accountType?.message}
          {...register('accountType')}
        />
      ) : (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('form.accountType')}
          </label>
          
          {/* Tabs */}
          <div className="flex border-b border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={() => setActiveTab('offline')}
              className={`py-2 px-4 font-medium text-sm border-b-2 transition-colors ${
                activeTab === 'offline'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Offline Account
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('other')}
              className={`py-2 px-4 font-medium text-sm border-b-2 transition-colors ${
                activeTab === 'other'
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Other Assets & Liabilities
            </button>
          </div>

          {/* Grid Selector */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 max-h-[320px] overflow-y-auto pr-1">
            {activeTab === 'offline' ? (
              <>
                {/* Banking Group */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider border-b border-gray-100 dark:border-gray-800 pb-1">
                    <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                    </svg>
                    Banking
                  </div>
                  <div className="space-y-1">
                    {[
                      { value: 'CHEQUING', label: t('form.accountTypeOptions.chequing'), desc: 'Checking / Daily bills' },
                      { value: 'SAVINGS', label: t('form.accountTypeOptions.savings'), desc: 'Savings & reserves' },
                      { value: 'CREDIT_CARD', label: t('form.accountTypeOptions.creditCard'), desc: 'Revolving credit card' },
                    ].map((type) => (
                      <button
                        key={type.value}
                        type="button"
                        onClick={() => setValue('accountType', type.value as any, { shouldDirty: true, shouldValidate: true })}
                        className={`w-full text-left p-2 rounded border transition-all ${
                          watchedAccountType === type.value
                            ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 ring-1 ring-blue-500'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 bg-white dark:bg-gray-800'
                        }`}
                      >
                        <div className="font-medium text-xs text-gray-900 dark:text-gray-100">{type.label}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 leading-tight">{type.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Investing & Retirement Group */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider border-b border-gray-100 dark:border-gray-800 pb-1">
                    <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                    </svg>
                    Investing & Retirement
                  </div>
                  <div className="space-y-1">
                    {[
                      { value: 'INVESTMENT', label: t('form.accountTypeOptions.investment'), desc: 'Brokerage & investments' },
                      { value: '401K', label: t('form.accountTypeOptions.401k'), desc: 'Employer 401(k)' },
                      { value: '403B', label: t('form.accountTypeOptions.403b'), desc: 'Employer 403(b)' },
                      { value: 'TRADITIONAL_IRA', label: t('form.accountTypeOptions.traditionalIra'), desc: 'Pre-tax individual IRA' },
                      { value: 'ROTH_IRA', label: t('form.accountTypeOptions.rothIra'), desc: 'Post-tax individual Roth' },
                      { value: '529_PLAN', label: t('form.accountTypeOptions.529Plan'), desc: 'Education savings plans' },
                      { value: 'HSA', label: t('form.accountTypeOptions.hsa'), desc: 'Health Savings Account' },
                    ].map((type) => (
                      <button
                        key={type.value}
                        type="button"
                        onClick={() => setValue('accountType', type.value as any, { shouldDirty: true, shouldValidate: true })}
                        className={`w-full text-left p-2 rounded border transition-all ${
                          watchedAccountType === type.value
                            ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 ring-1 ring-blue-500'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 bg-white dark:bg-gray-800'
                        }`}
                      >
                        <div className="font-medium text-xs text-gray-900 dark:text-gray-100">{type.label}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 leading-tight">{type.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Loan & Debt Group */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider border-b border-gray-100 dark:border-gray-800 pb-1">
                    <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Loan & Debt
                  </div>
                  <div className="space-y-1">
                    {[
                      { value: 'LOAN', label: t('form.accountTypeOptions.loan'), desc: 'Auto / Personal loans' },
                      { value: 'MORTGAGE', label: t('form.accountTypeOptions.mortgage'), desc: 'Property mortgages' },
                      { value: 'HELOC', label: t('form.accountTypeOptions.heloc'), desc: 'Home Equity Line of Credit' },
                      { value: 'LINE_OF_CREDIT', label: t('form.accountTypeOptions.lineOfCredit'), desc: 'Revolving line of credit' },
                    ].map((type) => (
                      <button
                        key={type.value}
                        type="button"
                        onClick={() => setValue('accountType', type.value as any, { shouldDirty: true, shouldValidate: true })}
                        className={`w-full text-left p-2 rounded border transition-all ${
                          watchedAccountType === type.value
                            ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 ring-1 ring-blue-500'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 bg-white dark:bg-gray-800'
                        }`}
                      >
                        <div className="font-medium text-xs text-gray-900 dark:text-gray-100">{type.label}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 leading-tight">{type.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Cash & Assets Column */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider border-b border-gray-100 dark:border-gray-800 pb-1">
                    <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M12 16v1M4 6h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z" />
                    </svg>
                    Cash & Assets
                  </div>
                  <div className="space-y-1">
                    {[
                      { value: 'CASH', label: t('form.accountTypeOptions.cash'), desc: 'Cash on hand / Wallets' },
                      { value: 'PROPERTY', label: t('form.accountTypeOptions.property'), desc: 'Home, rental property' },
                      { value: 'VEHICLE', label: t('form.accountTypeOptions.vehicle'), desc: 'Car, truck, RV' },
                      { value: 'ASSET', label: t('form.accountTypeOptions.asset'), desc: 'Other high-value assets' },
                    ].map((type) => (
                      <button
                        key={type.value}
                        type="button"
                        onClick={() => setValue('accountType', type.value as any, { shouldDirty: true, shouldValidate: true })}
                        className={`w-full text-left p-2 rounded border transition-all ${
                          watchedAccountType === type.value
                            ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 ring-1 ring-blue-500'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 bg-white dark:bg-gray-800'
                        }`}
                      >
                        <div className="font-medium text-xs text-gray-900 dark:text-gray-100">{type.label}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 leading-tight">{type.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tax-Advantaged Cash Column */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider border-b border-gray-100 dark:border-gray-800 pb-1">
                    <svg className="w-4 h-4 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    Tax-Advantaged Cash
                  </div>
                  <div className="space-y-1">
                    {[
                      { value: 'FSA', label: t('form.accountTypeOptions.fsa'), desc: 'Flexible Spending Account' },
                      { value: 'DCFSA', label: t('form.accountTypeOptions.dcfsa'), desc: 'Dependent Care FSA' },
                    ].map((type) => (
                      <button
                        key={type.value}
                        type="button"
                        onClick={() => setValue('accountType', type.value as any, { shouldDirty: true, shouldValidate: true })}
                        className={`w-full text-left p-2 rounded border transition-all ${
                          watchedAccountType === type.value
                            ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 ring-1 ring-blue-500'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 bg-white dark:bg-gray-800'
                        }`}
                      >
                        <div className="font-medium text-xs text-gray-900 dark:text-gray-100">{type.label}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 leading-tight">{type.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Liabilities & Other Column */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-gray-800 dark:text-gray-200 text-xs uppercase tracking-wider border-b border-gray-100 dark:border-gray-800 pb-1">
                    <svg className="w-4 h-4 text-rose-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    Liabilities & Other
                  </div>
                  <div className="space-y-1">
                    {[
                      { value: 'LIABILITY', label: t('form.accountTypeOptions.liability'), desc: 'Other liabilities' },
                      { value: 'OTHER', label: t('form.accountTypeOptions.other'), desc: 'Other custom accounts' },
                    ].map((type) => (
                      <button
                        key={type.value}
                        type="button"
                        onClick={() => setValue('accountType', type.value as any, { shouldDirty: true, shouldValidate: true })}
                        className={`w-full text-left p-2 rounded border transition-all ${
                          watchedAccountType === type.value
                            ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 ring-1 ring-blue-500'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 bg-white dark:bg-gray-800'
                        }`}
                      >
                        <div className="font-medium text-xs text-gray-900 dark:text-gray-100">{type.label}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 leading-tight">{type.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
          {errors.accountType?.message && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.accountType.message}</p>
          )}
        </div>
      )}

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
              {t('form.investmentPairTitle')}
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('form.investmentPairDescription')}
            </span>
          </label>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center mb-1">
            <label
              htmlFor="select-currency"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('form.currency')}
            </label>
            {isCurrencyLocked && (
              <InfoTooltip text={t('form.currencyLocked')} />
            )}
          </div>
          <Select
            id="select-currency"
            options={currencyOptions}
            error={errors.currencyCode?.message}
            disabled={isCurrencyLocked}
            className={isCurrencyLocked ? 'opacity-60' : undefined}
            {...register('currencyCode')}
          />
        </div>

        <CurrencyInput
          label={isLoanAccount ? t('form.loanAmount') : isMortgageAccount ? t('form.mortgageAmount') : t('form.openingBalance')}
          prefix={currencySymbol}
          value={watchedOpeningBalance}
          onChange={(value) => setValue('openingBalance', value, { shouldValidate: true })}
          error={errors.openingBalance?.message}
          allowNegative={!isLoanAccount && !isMortgageAccount}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label={t('form.accountNumber')}
          error={errors.accountNumber?.message}
          {...register('accountNumber')}
        />

        <Combobox
          label={t('form.institution')}
          placeholder={t('form.institutionPlaceholder')}
          options={institutionOptions}
          value={selectedInstitutionId}
          initialDisplayValue={initialInstitutionName}
          onChange={handleInstitutionChange}
          onCreateNew={handleInstitutionCreate}
          allowCustomValue
          usePortal
          alwaysShowSubtitle
          error={errors.institutionId?.message}
        />
      </div>

      {/* Credit Limit and Interest Rate - hide for loans, mortgages, assets, and liabilities */}
      {!isAssetAccount && (
        <div className="grid grid-cols-2 gap-4">
          {!isLoanAccount && !isMortgageAccount && !isLiabilityAccount && (
            <CurrencyInput
              label={t('form.creditLimit')}
              prefix={currencySymbol}
              value={watchedCreditLimit}
              onChange={(value) => setValue('creditLimit', value, { shouldValidate: true })}
              error={errors.creditLimit?.message}
              allowNegative={false}
            />
          )}

          <Input
            label={(isLoanAccount || isMortgageAccount) ? t('form.interestRateRequired') : t('form.interestRateOptional')}
            type="number"
            step="0.01"
            error={errors.interestRate?.message}
            {...register('interestRate', { valueAsNumber: true })}
          />

          {(isLoanAccount || isMortgageAccount) && <div />} {/* Spacer for grid alignment */}
        </div>
      )}

      {/* Credit card statement date fields */}
      {isCreditCardAccount && (
        <div className="space-y-4">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('form.statementDates')}</h4>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={t('form.statementDueDay')}
              type="number"
              min={1}
              max={31}
              placeholder={t('form.statementDueDayPlaceholder')}
              error={errors.statementDueDay?.message}
              {...register('statementDueDay', { valueAsNumber: true })}
            />

            <div>
              <div className="flex items-center mb-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('form.statementSettlementDay')}
                </label>
                <InfoTooltip text={t('form.statementSettlementDayTooltip')} align="right" />
              </div>
              <input
                type="number"
                min={1}
                max={31}
                placeholder={t('form.statementSettlementDayPlaceholder')}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                {...register('statementSettlementDay', { valueAsNumber: true })}
              />
              {errors.statementSettlementDay?.message && (
                <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.statementSettlementDay.message}</p>
              )}
            </div>
          </div>
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

      {/* Set Up Payments button for existing loan/mortgage accounts without scheduled payments */}
      {account && !hasScheduledPayment &&
        (isLoanAccount || isMortgageAccount) && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
          <p className="text-sm text-amber-800 dark:text-amber-300 mb-2">
            {t('form.noScheduledPayments')}
          </p>
          <button
            type="button"
            onClick={() => setShowLoanSetupDialog(true)}
            className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            {t('form.setUpRecurringPayments')}
          </button>
        </div>
      )}

      {showLoanSetupDialog && account && (
        <LoanPaymentSetupDialog
          isOpen={showLoanSetupDialog}
          onClose={() => setShowLoanSetupDialog(false)}
          loanAccount={{
            accountId: account.id,
            accountName: account.name,
            accountType: account.accountType,
            currencyCode: account.currencyCode,
          }}
          accounts={accounts}
          onSetupComplete={() => {
            setShowLoanSetupDialog(false);
            setHasScheduledPayment(true);
            router.refresh();
          }}
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
          setValue={setValue}
          errors={errors}
          watchedDateAcquired={watchedDateAcquired}
        />
      )}

      <Input
        label={t('form.description')}
        error={errors.description?.message}
        {...register('description')}
      />

      {/* Favourite star toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!isDelegateView && (
        <button
          type="button"
          onClick={toggleFavourite}
          className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          title={watchedIsFavourite ? t('form.removeFromFavourites') : t('form.addToFavourites')}
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
            {watchedIsFavourite ? t('form.favourite') : t('form.addToFavourites')}
          </span>
        </button>
        )}
        {/* Hidden input for form registration */}
        <input type="hidden" {...register('isFavourite')} />

        <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600">
          <Controller
            name="excludeFromNetWorth"
            control={control}
            render={({ field }) => (
              <ToggleSwitch
                checked={!!field.value}
                onChange={field.onChange}
                label={t('form.excludeFromNetWorth')}
              />
            )}
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            {t('form.excludeFromNetWorth')}
          </span>
        </div>

        {/* Import/Export buttons - only shown when editing */}
        {account && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleImportQif}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              title={t('form.importTitle')}
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
              <span className="hidden sm:inline text-sm text-gray-700 dark:text-gray-300">{t('form.importLabel')}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowExportModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              title={t('form.exportTitle')}
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
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              <span className="hidden sm:inline text-sm text-gray-700 dark:text-gray-300">{t('form.exportLabel')}</span>
            </button>
          </div>
        )}
      </div>

      <FormActions onCancel={onCancel} submitLabel={account ? t('form.updateAccount') : t('form.createAccount')} isSubmitting={isSubmitting} />

      {account && (
        <AccountExportModal
          isOpen={showExportModal}
          onClose={() => setShowExportModal(false)}
          accountId={account.id}
          accountName={account.name}
        />
      )}

      {/* Inline create-institution modal (stacked on top of the account form) */}
      <Modal
        isOpen={showInstitutionModal}
        onClose={() => setShowInstitutionModal(false)}
        maxWidth="lg"
        className="p-6"
        pushHistory
      >
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          {t('form.newInstitutionTitle')}
        </h2>
        <InstitutionForm
          initialName={pendingInstitutionName}
          onSubmit={handleInstitutionCreated}
          onCancel={() => setShowInstitutionModal(false)}
        />
      </Modal>
    </form>
  );
}
