'use client';

import { useForm, useWatch, Resolver, Controller } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useState, useEffect, useMemo, useCallback, MutableRefObject } from 'react';
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
import { Account, PaymentFrequency, InterestBookingMode } from '@/types/account';
import { Category } from '@/types/category';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { exchangeRatesApi, CurrencyInfo } from '@/lib/exchange-rates';
import { getCurrencySymbol } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
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

// An optional enum that maps any value outside its allowed set to undefined
// rather than failing validation. This also absorbs the empty-string
// placeholder from an unselected <Select> (issue #785); required-ness is
// enforced per account type in the superRefine below with localized messages.
// It further matters on the edit form: a mortgage
// stores its (often accelerated/semi-monthly) cadence in the same
// paymentFrequency column, which is not a member of the loan-only enum. The
// frequency field is not rendered while editing, so a stored value like
// ACCELERATED_BIWEEKLY loaded as the paymentFrequency default would otherwise
// make the base schema reject the form, silently blocking submit with no
// visible error. Coercing it to undefined lets the form save; the cleanup in
// AccountFormModal drops the undefined field from the payload, so the stored
// frequency round-trips untouched.
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (val: unknown) =>
      typeof val === 'string' && (values as readonly string[]).includes(val)
        ? val
        : undefined,
    z.enum(values).optional(),
  );

const buildAccountSchema = (t: (key: string) => string, isEditing: boolean) => z.object({
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
  ]),
  currencyCode: z.string().length(3, t('validation.currencyCodeLength')),
  openingBalance: optionalNumber,
  creditLimit: optionalNumber,
  interestRate: optionalNumberWithRange(0, 100),
  description: z.string().optional(),
  accountNumber: z.string().optional(),
  institutionId: z.string().nullable().optional(),
  isFavourite: z.boolean().optional(),
  excludeFromNetWorth: z.boolean().optional(),
  createInvestmentPair: z.boolean().optional(),
  // Credit card statement fields
  statementDueDay: optionalNumberWithRange(1, 31),
  statementSettlementDay: optionalNumberWithRange(1, 31),
  // Loan-specific fields
  paymentAmount: optionalNumber,
  paymentFrequency: optionalEnum(paymentFrequencies),
  paymentStartDate: z.string().optional(),
  sourceAccountId: z.string().optional(),
  interestCategoryId: z.string().optional(),
  interestBookingMode: z.enum(['AUTO', 'SPLIT', 'SEPARATE']).optional(),
  overpaymentCategoryId: z.string().optional(),
  overpaymentMemo: z.string().max(255).optional(),
  overpaymentPayeeId: z.string().optional(),
  // Foreign-transaction fee (percentage)
  fxFeePercent: optionalNumberWithRange(0, 100),
  // Asset-specific fields
  assetCategoryId: z.string().optional(),
  dateAcquired: z.string().optional(),
  // Mortgage-specific fields
  isCanadianMortgage: z.boolean().optional(),
  isVariableRate: z.boolean().optional(),
  termMonths: optionalNumber,
  amortizationMonths: optionalNumber,
  mortgagePaymentFrequency: optionalEnum(mortgagePaymentFrequencies),
}).superRefine((data, ctx) => {
  // Loan and mortgage payment setup is only collected when creating the account
  // (the payment fields are hidden while editing), so only enforce these on
  // create. The backend rejects the same gaps, but validating here gives clean,
  // localized, inline errors instead of a generic API toast -- and stops the
  // silent fall-through that would otherwise create a payment-less account.
  if (isEditing) return;

  const requireField = (
    condition: boolean,
    path: keyof typeof data,
    messageKey: string,
  ) => {
    if (condition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: t(messageKey),
      });
    }
  };

  if (data.accountType === 'MORTGAGE') {
    requireField(!data.institutionId, 'institutionId', 'validation.institutionRequired');
    requireField(data.interestRate === undefined, 'interestRate', 'validation.interestRateRequired');
    requireField(!data.mortgagePaymentFrequency, 'mortgagePaymentFrequency', 'validation.paymentFrequencyRequired');
    requireField(!data.paymentStartDate, 'paymentStartDate', 'validation.paymentStartDateRequired');
    requireField(!data.sourceAccountId, 'sourceAccountId', 'validation.paymentAccountRequired');
    requireField(!data.amortizationMonths, 'amortizationMonths', 'validation.amortizationRequired');
  } else if (data.accountType === 'LOAN') {
    requireField(!data.institutionId, 'institutionId', 'validation.institutionRequired');
    requireField(data.interestRate === undefined, 'interestRate', 'validation.interestRateRequired');
    requireField(!data.paymentAmount, 'paymentAmount', 'validation.paymentAmountRequired');
    requireField(!data.paymentFrequency, 'paymentFrequency', 'validation.paymentFrequencyRequired');
    requireField(!data.paymentStartDate, 'paymentStartDate', 'validation.paymentStartDateRequired');
    requireField(!data.sourceAccountId, 'sourceAccountId', 'validation.paymentAccountRequired');
  }
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
  ];
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
  const [interestBookingMode, setInterestBookingMode] = useState<InterestBookingMode>(account?.interestBookingMode || 'AUTO');
  const [selectedOverpaymentCategoryId, setSelectedOverpaymentCategoryId] = useState<string>(account?.overpaymentCategoryId || '');
  const [selectedOverpaymentPayeeId, setSelectedOverpaymentPayeeId] = useState<string>(account?.overpaymentPayeeId || '');
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
    formState: { errors, isSubmitting, isDirty, dirtyFields },
  } = useForm<AccountFormData>({
    resolver: zodResolver(buildAccountSchema(t, !!account)) as Resolver<AccountFormData>,
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
          interestBookingMode: account.interestBookingMode || 'AUTO',
          overpaymentCategoryId: account.overpaymentCategoryId || undefined,
          overpaymentMemo: account.overpaymentMemo || undefined,
          overpaymentPayeeId: account.overpaymentPayeeId || undefined,
          fxFeePercent: account.fxFeePercent ?? undefined,
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

  // Retain the account's stored institution unless the user actually changed
  // the Institution field. The institution combobox marks the field dirty only
  // on real interaction (selecting, clearing, or creating an institution), so
  // an untouched edit of any other property omits institutionId entirely and
  // the backend keeps the stored value -- the form can never clobber it. Only
  // an explicit change or removal (which dirties the field, null on a clear) is
  // sent through (issue #806). Omitting rather than resending the loaded value
  // also avoids overwriting the stored institution with a stale form value.
  const handleValidatedSubmit = useCallback(
    (data: AccountFormData) => {
      if (account && !dirtyFields.institutionId) {
        const { institutionId: _untouched, ...rest } = data;
        return onSubmit(rest);
      }
      return onSubmit(data);
    },
    [account, dirtyFields.institutionId, onSubmit],
  );

  useFormSubmitRef(submitRef, handleSubmit, handleValidatedSubmit);

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

  // Show asset fields only for ASSET account type
  const isAssetAccount = watchedAccountType === 'ASSET';
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
    // The combobox only reports changes from real user interaction, so an
    // empty value here means the user explicitly cleared the field. When
    // editing, encode that as null -- the explicit "clear the stored
    // institution" signal -- so the submit layer never has to infer a clear
    // from a merely absent value (issue #806). On create there is nothing to
    // clear, so an empty selection stays undefined and is stripped on submit.
    setValue('institutionId', value || (account ? null : undefined), {
      shouldDirty: true,
    });
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

  // Load accounts and categories when LOAN, MORTGAGE, LINE_OF_CREDIT, or ASSET
  // type is selected (for the source-account and value-change/interest category
  // pickers). Other account types don't need them.
  const isLineOfCreditAccount = watchedAccountType === 'LINE_OF_CREDIT';
  useEffect(() => {
    const needData =
      isLoanAccount || isMortgageAccount || isLineOfCreditAccount || isAssetAccount;
    if (!needData) return;

    const loadData = async () => {
      try {
        const [categoriesData, accountsData] = await Promise.all([
          categoriesApi.getAll(),
          accountsApi.getAll(false),
        ]);
        setCategories(categoriesData);
        if (accountsData) {
          // Filter out loan and mortgage accounts from source account options
          setAccounts(accountsData.filter(a => a.accountType !== 'LOAN' && a.accountType !== 'MORTGAGE'));
        }

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

  const handleViewLoanDetails = () => {
    if (account) {
      const accountId = account.id;
      // Close the modal first so its history entry is cleaned up before
      // navigating. Without this, the Modal's unmount cleanup calls
      // history.back() which navigates away from the account detail page.
      onCancel();
      setTimeout(() => {
        router.push(`/accounts/${accountId}#rate-history`);
      }, 100);
    }
  };

  const [showExportModal, setShowExportModal] = useState(false);

  // Handle interest category selection (for loan/mortgage)
  const handleInterestCategoryChange = (categoryId: string) => {
    setSelectedInterestCategoryId(categoryId);
    setValue('interestCategoryId', categoryId || '', { shouldDirty: true, shouldValidate: true });
  };

  const handleInterestBookingModeChange = (mode: InterestBookingMode) => {
    setInterestBookingMode(mode);
    setValue('interestBookingMode', mode, { shouldDirty: true, shouldValidate: true });
  };

  // Overpayment recognition: category and payee that mark a payment as a
  // standalone overpayment (100% principal). Saved with the account on submit.
  const handleOverpaymentCategoryChange = (categoryId: string) => {
    setSelectedOverpaymentCategoryId(categoryId);
    setValue('overpaymentCategoryId', categoryId || '', { shouldDirty: true, shouldValidate: true });
  };

  const handleOverpaymentPayeeChange = (payeeId: string) => {
    setSelectedOverpaymentPayeeId(payeeId);
    setValue('overpaymentPayeeId', payeeId || '', { shouldDirty: true, shouldValidate: true });
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
    <form onSubmit={handleSubmit(handleValidatedSubmit)} className="space-y-4">
      <Input
        label={t('form.accountName')}
        error={errors.name?.message}
        {...register('name')}
      />

      <Select
        label={t('form.accountType')}
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
          label={(isLoanAccount || isMortgageAccount) ? t('form.institutionRequired') : t('form.institution')}
          placeholder={t('form.institutionPlaceholder')}
          options={institutionOptions}
          value={selectedInstitutionId}
          initialDisplayValue={initialInstitutionName}
          onChange={handleInstitutionChange}
          onCreateNew={handleInstitutionCreate}
          allowCustomValue
          valueIsId
          usePortal
          alwaysShowSubtitle
          error={errors.institutionId?.message}
        />
      </div>

      {/* Credit Limit and Interest Rate - hide for loans, mortgages, and assets */}
      {!isAssetAccount && (
        <div className="grid grid-cols-2 gap-4">
          {!isLoanAccount && !isMortgageAccount && (
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

      {/* Foreign Currency Conversion Fee: the bank's FX fee (a percentage),
          folded into the converted amount on foreign-entered transactions. */}
      <div className="space-y-3" {...tourAnchor(TOUR_ANCHORS.accountFxFeePercent)}>
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t('form.fxFeeTitle')}
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label={`${t('form.fxFeePercent')} (%)`}
            type="number"
            step="0.01"
            min="0"
            max="100"
            placeholder={t('form.fxFeePercentPlaceholder')}
            error={errors.fxFeePercent?.message}
            {...register('fxFeePercent', { valueAsNumber: true })}
          />
        </div>
      </div>

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
          interestBookingMode={interestBookingMode}
          handleInterestBookingModeChange={handleInterestBookingModeChange}
          selectedOverpaymentCategoryId={selectedOverpaymentCategoryId}
          handleOverpaymentCategoryChange={handleOverpaymentCategoryChange}
          selectedOverpaymentPayeeId={selectedOverpaymentPayeeId}
          handleOverpaymentPayeeChange={handleOverpaymentPayeeChange}
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
          onViewLoanDetails={account ? handleViewLoanDetails : undefined}
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
          interestBookingMode={interestBookingMode}
          handleInterestBookingModeChange={handleInterestBookingModeChange}
          selectedOverpaymentCategoryId={selectedOverpaymentCategoryId}
          handleOverpaymentCategoryChange={handleOverpaymentCategoryChange}
          selectedOverpaymentPayeeId={selectedOverpaymentPayeeId}
          handleOverpaymentPayeeChange={handleOverpaymentPayeeChange}
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
