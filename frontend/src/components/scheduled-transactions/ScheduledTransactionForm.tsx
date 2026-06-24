'use client';

import { useState, useEffect, useMemo, MutableRefObject } from 'react';
import { useForm, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { TagForm } from '@/components/tags/TagForm';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows, toCreateSplitData } from '@/components/transactions/SplitEditor';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { getLocalDateString } from '@/lib/utils';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { accountsApi } from '@/lib/accounts';
import { tagsApi } from '@/lib/tags';
import { ScheduledTransaction, FrequencyType, FREQUENCY_LABELS } from '@/types/scheduled-transaction';
import { InvestmentAction, Security } from '@/types/investment';
import { Transaction } from '@/types/transaction';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { Tag } from '@/types/tag';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents, getCurrencySymbol } from '@/lib/format';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { getErrorMessage } from '@/lib/errors';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';

import { optionalUuid, optionalString, optionalNumber } from '@/lib/zod-helpers';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const logger = createLogger('ScheduledTxForm');

export type ScheduledTransactionMode = 'transaction' | 'split' | 'transfer' | 'investment';


// Mirrors visibility rules in InvestmentTransactionForm — keep in sync.
const SECURITY_REQUIRED_ACTIONS: InvestmentAction[] = [
  'BUY', 'SELL', 'DIVIDEND', 'CAPITAL_GAIN', 'SPLIT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES',
];
const QUANTITY_PRICE_ACTIONS: InvestmentAction[] = ['BUY', 'SELL', 'REINVEST'];
const QUANTITY_ONLY_ACTIONS: InvestmentAction[] = ['ADD_SHARES', 'REMOVE_SHARES', 'SPLIT'];
const AMOUNT_ONLY_ACTIONS: InvestmentAction[] = ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN'];
const FUNDING_ACCOUNT_ACTIONS: InvestmentAction[] = ['BUY', 'SELL'];

const SCHEDULABLE_INVESTMENT_ACTIONS: InvestmentAction[] = [
  'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES',
];

const buildScheduledTransactionSchema = (t: (key: string) => string) => z.object({
  accountId: z.string().uuid('Please select an account'),
  name: z.string().min(1, t('validation.nameRequired')),
  payeeId: optionalUuid,
  payeeName: optionalString,
  categoryId: optionalUuid,
  amount: z.number({ error: 'Amount is required' }),
  currencyCode: z.string().default('CAD'),
  description: optionalString,
  referenceNumber: optionalString,
  frequency: z.enum(['ONCE', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'EVERY4WEEKS', 'SEMIMONTHLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
  nextDueDate: z.string().min(1, t('validation.dueDateRequired')),
  endDate: optionalString,
  occurrencesRemaining: optionalNumber,
  isActive: z.boolean().default(true),
  autoPost: z.boolean().default(false),
  reminderDaysBefore: z.number().min(0).default(3),
});

type ScheduledTransactionFormData = z.infer<ReturnType<typeof buildScheduledTransactionSchema>>;

interface ScheduledTransactionFormProps {
  scheduledTransaction?: ScheduledTransaction;
  templateTransaction?: Transaction;
  // Prefill hints for a brand-new schedule (ignored when editing an existing
  // schedule or building from a template). Used by the post-reconciliation
  // flow to seed a liability payment transfer.
  initialMode?: ScheduledTransactionMode;
  initialAmount?: number;
  initialTransferAccountId?: string;
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
  templateTransaction,
  initialMode,
  initialAmount,
  initialTransferAccountId,
  onSuccess,
  onCancel,
  onDirtyChange,
  submitRef,
}: ScheduledTransactionFormProps) {
  const t = useTranslations('scheduledTransactions');
  const { defaultCurrency } = useNumberFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [allPayees, setAllPayees] = useState<Payee[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(
    scheduledTransaction?.tagIds || templateTransaction?.tags?.map(t => t.id) || []
  );
  const [showTagForm, setShowTagForm] = useState(false);

  // Determine initial mode
  const getInitialMode = (): ScheduledTransactionMode => {
    if (scheduledTransaction?.isInvestment) return 'investment';
    if (isScheduledTransfer(scheduledTransaction)) return 'transfer';
    if (templateTransaction?.isTransfer) return 'transfer';
    if (scheduledTransaction?.isSplit && !isScheduledTransfer(scheduledTransaction)) return 'split';
    if (templateTransaction?.isSplit) return 'split';
    // Prefill hint only applies when building a brand-new schedule
    if (!scheduledTransaction && !templateTransaction && initialMode) return initialMode;
    return 'transaction';
  };

  const [mode, setMode] = useState<ScheduledTransactionMode>(getInitialMode());

  // Investment-mode state
  const [securities, setSecurities] = useState<Security[]>([]);
  const [investmentAction, setInvestmentAction] = useState<InvestmentAction>(
    (scheduledTransaction?.investmentAction as InvestmentAction | null) ?? 'BUY',
  );
  const [investmentSecurityId, setInvestmentSecurityId] = useState<string>(
    scheduledTransaction?.investmentSecurityId || '',
  );
  const [investmentFundingAccountId, setInvestmentFundingAccountId] = useState<string>(
    scheduledTransaction?.investmentFundingAccountId || '',
  );
  const [investmentQuantity, setInvestmentQuantity] = useState<number | ''>(
    scheduledTransaction?.investmentQuantity != null ? Number(scheduledTransaction.investmentQuantity) : '',
  );
  const [investmentPrice, setInvestmentPrice] = useState<number | ''>(
    scheduledTransaction?.investmentPrice != null ? Number(scheduledTransaction.investmentPrice) : '',
  );
  const [investmentCommission, setInvestmentCommission] = useState<number | ''>(
    scheduledTransaction?.investmentCommission != null ? Number(scheduledTransaction.investmentCommission) : '',
  );
  const [investmentTotalAmount, setInvestmentTotalAmount] = useState<number | ''>(
    scheduledTransaction?.investmentTotalAmount != null ? Number(scheduledTransaction.investmentTotalAmount) : '',
  );

  // BUY/SELL/REINVEST helpers: latest market price (used when Price is blank)
  // and a computed Total Value bound to (qty * price (+/-) commission).
  const [marketPrice, setMarketPrice] = useState<number | null>(null);
  const [investmentTotalValue, setInvestmentTotalValue] = useState<number | ''>(() => {
    const q = scheduledTransaction?.investmentQuantity;
    const p = scheduledTransaction?.investmentPrice;
    const c = scheduledTransaction?.investmentCommission ?? 0;
    if (q != null && p != null) {
      const sign = scheduledTransaction?.investmentAction === 'SELL' ? -1 : 1;
      return Math.round((Number(q) * Number(p) + sign * Number(c)) * 10000) / 10000;
    }
    return '';
  });
  const [transferToAccountId, setTransferToAccountId] = useState<string>(
    getTransferAccountId(scheduledTransaction)
    || (templateTransaction?.isTransfer ? templateTransaction.linkedTransaction?.accountId ?? '' : '')
    || (!scheduledTransaction && !templateTransaction ? initialTransferAccountId ?? '' : '')
  );

  const [selectedPayeeId, setSelectedPayeeId] = useState<string>(
    scheduledTransaction?.payeeId || templateTransaction?.payeeId || ''
  );
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    scheduledTransaction?.categoryId || templateTransaction?.categoryId || ''
  );
  const [useEndDate, setUseEndDate] = useState<boolean>(!!scheduledTransaction?.endDate);
  const [useOccurrences, setUseOccurrences] = useState<boolean>(
    scheduledTransaction?.occurrencesRemaining !== null &&
    scheduledTransaction?.occurrencesRemaining !== undefined
  );
  const [splits, setSplits] = useState<SplitRow[]>(
    scheduledTransaction?.splits && scheduledTransaction.splits.length > 0 && !isScheduledTransfer(scheduledTransaction)
      ? toSplitRows(scheduledTransaction.splits)
      : templateTransaction?.splits && templateTransaction.splits.length > 0 && !templateTransaction.isTransfer
        ? toSplitRows(templateTransaction.splits)
        : []
  );

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<ScheduledTransactionFormData>({
    resolver: zodResolver(buildScheduledTransactionSchema(t)) as Resolver<ScheduledTransactionFormData>,
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
      : templateTransaction
        ? {
            accountId: templateTransaction.accountId,
            name: templateTransaction.payeeName || '',
            payeeId: templateTransaction.payeeId || '',
            payeeName: templateTransaction.payeeName || '',
            categoryId: templateTransaction.categoryId || '',
            amount: templateTransaction.isTransfer
              ? Math.abs(Math.round(Number(templateTransaction.amount) * 100) / 100)
              : Math.round(Number(templateTransaction.amount) * 100) / 100,
            currencyCode: templateTransaction.currencyCode,
            description: templateTransaction.description || '',
            referenceNumber: '',
            frequency: 'MONTHLY' as FrequencyType,
            nextDueDate: getLocalDateString(),
            isActive: true,
            autoPost: false,
            reminderDaysBefore: 3,
          }
        : {
            amount: initialAmount,
            currencyCode: defaultCurrency,
            frequency: 'MONTHLY' as FrequencyType,
            nextDueDate: getLocalDateString(),
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
    buildAccountDropdownOptions(
      accounts,
      (a) => !a.isClosed && a.accountType !== 'ASSET' && a.accountSubType !== 'INVESTMENT_BROKERAGE',
      (a) => `${a.name} (${a.currencyCode})`,
    ),
    [accounts]
  );

  // Investment-mode accounts: only brokerage (share-holding) accounts.
  const investmentAccountOptions = useMemo(() =>
    buildAccountDropdownOptions(
      accounts,
      (a) => !a.isClosed && a.accountSubType === 'INVESTMENT_BROKERAGE',
      (a) => `${a.name} (${a.currencyCode})`,
    ),
    [accounts]
  );

  // Funding account options: anything that can carry cash, except the
  // brokerage's paired cash side and asset/brokerage accounts. Mirrors the
  // filtering in InvestmentTransactionForm.
  const fundingAccountOptions = useMemo(() =>
    buildAccountDropdownOptions(
      accounts,
      (a) =>
        !a.isClosed &&
        a.id !== watchedAccountId &&
        a.accountType !== 'ASSET' &&
        a.accountSubType !== 'INVESTMENT_BROKERAGE' &&
        a.accountSubType !== 'INVESTMENT_CASH',
      (a) => `${a.name} (${a.currencyCode})`,
    ),
    [accounts, watchedAccountId]
  );

  const securityOptions = useMemo(() =>
    securities
      .filter(s => s.isActive)
      .map(s => ({
        value: s.id,
        label: s.symbol ? `${s.symbol} — ${s.name}` : s.name,
      })),
    [securities]
  );

  // Memoize transfer To account options
  const transferToAccountOptions = useMemo(() =>
    buildAccountDropdownOptions(
      accounts,
      (a) =>
        !a.isClosed &&
        a.id !== watchedAccountId &&
        a.accountType !== 'ASSET' &&
        a.accountSubType !== 'INVESTMENT_BROKERAGE',
      (a) => `${a.name} (${a.currencyCode})`,
    ),
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

  // Memoize tag options
  const tagOptions = useMemo(() =>
    [...tags]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map(tag => ({ value: tag.id, label: tag.name })),
    [tags]
  );

  // Load securities lazily — only fetch when the user actually enters investment mode.
  useEffect(() => {
    if (mode !== 'investment' || securities.length > 0) return;
    investmentsApi.getSecurities()
      .then(setSecurities)
      .catch((err) => {
        toast.error(getErrorMessage(err, t('form.toasts.loadSecuritiesFailed')));
        logger.error(err);
      });
  }, [mode, securities.length, t]);

  // When the chosen security changes, fetch its most recent close price so we
  // can auto-fill the Price field and back-derive quantity from Total Value.
  useEffect(() => {
    if (mode !== 'investment' || !investmentSecurityId) {
      setMarketPrice(null);
      return;
    }
    let cancelled = false;
    investmentsApi.getSecurityPrices(investmentSecurityId, 1)
      .then((prices) => {
        if (cancelled) return;
        const latest = prices[0];
        setMarketPrice(latest ? Number(latest.closePrice) : null);
      })
      .catch((err) => {
        if (cancelled) return;
        setMarketPrice(null);
        logger.warn?.('Failed to fetch latest price', err);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, investmentSecurityId]);

  // If the user hasn't typed a price, auto-fill from the latest market price
  // once it arrives. Don't clobber an already-entered price. Uses the
  // "info from previous render" pattern so we don't violate
  // react-hooks/set-state-in-effect.
  const [lastSeenMarketPrice, setLastSeenMarketPrice] = useState<number | null>(null);
  if (marketPrice !== lastSeenMarketPrice) {
    setLastSeenMarketPrice(marketPrice);
    if (
      marketPrice != null &&
      (investmentPrice === '' || investmentPrice === 0)
    ) {
      setInvestmentPrice(Math.round(marketPrice * 1_000_000) / 1_000_000);
    }
  }

  const effectiveInvestmentPrice =
    investmentPrice !== '' && Number(investmentPrice) > 0
      ? Number(investmentPrice)
      : marketPrice ?? 0;
  const investmentSign = investmentAction === 'SELL' ? -1 : 1;

  const handleTotalValueChange = (raw: number | undefined) => {
    if (raw === undefined) {
      setInvestmentTotalValue('');
      return;
    }
    setInvestmentTotalValue(raw);
    if (effectiveInvestmentPrice > 0) {
      const commission =
        investmentCommission === '' ? 0 : Number(investmentCommission);
      const cost = raw - investmentSign * commission;
      const qty = Math.max(0, cost / effectiveInvestmentPrice);
      setInvestmentQuantity(Math.round(qty * 100_000_000) / 100_000_000);
    }
  };

  const handleQuantityChange = (raw: string) => {
    const qty = raw === '' ? '' : Number(raw);
    setInvestmentQuantity(qty);
    if (qty !== '' && effectiveInvestmentPrice > 0) {
      const commission =
        investmentCommission === '' ? 0 : Number(investmentCommission);
      const total = Number(qty) * effectiveInvestmentPrice + investmentSign * commission;
      setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
    }
  };

  const handlePriceChange = (raw: string) => {
    const price = raw === '' ? '' : Number(raw);
    setInvestmentPrice(price);
    if (price !== '' && Number(price) > 0) {
      const commission =
        investmentCommission === '' ? 0 : Number(investmentCommission);
      // If the user has a total in mind, keep it and re-derive quantity. Otherwise
      // re-derive total from quantity * price.
      if (investmentTotalValue !== '') {
        const cost = Number(investmentTotalValue) - investmentSign * commission;
        const qty = Math.max(0, cost / Number(price));
        setInvestmentQuantity(Math.round(qty * 100_000_000) / 100_000_000);
      } else if (investmentQuantity !== '') {
        const total =
          Number(investmentQuantity) * Number(price) + investmentSign * commission;
        setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
      }
    }
  };

  // Load accounts, categories, active payees on mount
  // When editing, also fetch the scheduled transaction's payee if it's inactive
  useEffect(() => {
    Promise.all([
      accountsApi.getAll(),
      categoriesApi.getAll(),
      payeesApi.getAll('active'),
      tagsApi.getAll(),
    ])
      .then(async ([accountsData, categoriesData, payeesData, tagsData]) => {
        setAccounts(accountsData);
        setCategories(categoriesData);
        setTags(tagsData);

        // If editing and the payee isn't in the active list, fetch it so it shows in the dropdown
        if (scheduledTransaction?.payeeId && !payeesData.some(p => p.id === scheduledTransaction.payeeId)) {
          try {
            const existingPayee = await payeesApi.getById(scheduledTransaction.payeeId);
            const merged = [...payeesData, existingPayee];
            setPayees(merged);
            setAllPayees(merged);
          } catch {
            setPayees(payeesData);
            setAllPayees(payeesData);
          }
        } else {
          setPayees(payeesData);
          setAllPayees(payeesData);
        }
      })
      .catch((error) => {
        toast.error(getErrorMessage(error, t('form.toasts.loadFormDataFailed')));
        logger.error(error);
      });
  }, [scheduledTransaction?.payeeId, t]);

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
      // A transfer may keep an optional category (#743), so it is not cleared
      // here -- the user sets it in the transfer tab's optional Category field.
      if (watchedAmount < 0) {
        setValue('amount', Math.abs(watchedAmount), { shouldDirty: true });
      }
    } else if (newMode === 'investment') {
      setSplits([]);
      setSelectedCategoryId('');
      setValue('categoryId', '', { shouldDirty: true });
      setTransferToAccountId('');
      // The Investment tab has no Amount field, but the Zod schema still
      // requires amount to be a number. Seed it so validation passes; it
      // will be replaced at submit time with the computed display amount.
      if (
        watchedAmount === undefined ||
        watchedAmount === null ||
        Number.isNaN(watchedAmount)
      ) {
        setValue('amount', 0, { shouldDirty: false, shouldValidate: false });
      }
      // If the currently-selected account isn't a brokerage account, clear it
      // so the user picks one from the brokerage-only dropdown.
      const acc = accounts.find(a => a.id === watchedAccountId);
      if (acc && acc.accountSubType !== 'INVESTMENT_BROKERAGE') {
        setValue('accountId', '', { shouldDirty: true });
      }
    } else {
      // 'transaction'
      setSplits([]);
      setTransferToAccountId('');
    }
  };

  // Convert a split scheduled transaction back to a regular one, adopting the
  // category of the split that remains after the user deletes one of the final
  // two splits.
  const handleConvertToRegular = (categoryId?: string) => {
    setMode('transaction');
    setSplits([]);
    setTransferToAccountId('');
    setSelectedCategoryId(categoryId || '');
    setValue('categoryId', categoryId || '', { shouldDirty: true });
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
      toast.success(t('form.toasts.payeeCreated', { name }));
    } catch (error) {
      logger.error('Failed to create payee:', error);
      toast.error(getErrorMessage(error, t('form.toasts.payeeCreateFailed')));
    }
  };

  const handleCategoryChange = (categoryId: string, _name: string) => {
    if (categoryId) {
      setSelectedCategoryId(categoryId);
      setValue('categoryId', categoryId, { shouldDirty: true, shouldValidate: true });

      // Adjust amount sign based on category type -- but never in transfer mode,
      // where the amount is always a positive magnitude (negated on submit) and
      // the category is just a label that does not drive income/expense sign.
      const category = categories.find((c) => c.id === categoryId);
      if (mode !== 'transfer' && category && watchedAmount !== undefined && watchedAmount !== 0) {
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
      toast.success(t('form.toasts.categoryCreated', { name }));
    } catch (error) {
      logger.error('Failed to create category:', error);
      toast.error(getErrorMessage(error, t('form.toasts.categoryCreateFailed')));
    }
  };

  const handleTransactionAmountChange = (amount: number) => {
    const rounded = roundToCents(amount);
    setValue('amount', rounded, { shouldDirty: true, shouldValidate: true });
  };

  const handleTagCreate = async (data: { name: string; color?: string; icon?: string }) => {
    const cleanedData = {
      ...data,
      color: data.color || undefined,
      icon: data.icon || undefined,
    };
    const newTag = await tagsApi.create(cleanedData);
    setTags(prev => [...prev, newTag]);
    setSelectedTagIds(prev => [...prev, newTag.id]);
    toast.success(t('form.toasts.tagCreated', { name: newTag.name }));
    setShowTagForm(false);
  };

  const onSubmit = async (data: ScheduledTransactionFormData) => {
    // Validate transfer destination
    if (mode === 'transfer') {
      if (!transferToAccountId) {
        toast.error(t('form.toasts.selectTransferDestination'));
        return;
      }
      if (transferToAccountId === data.accountId) {
        toast.error(t('form.toasts.differentTransferAccounts'));
        return;
      }
    }

    // Validate splits if in split mode
    if (mode === 'split') {
      if (splits.length < 2) {
        toast.error(t('form.toasts.splitsMinimum'));
        return;
      }
      const splitsTotal = splits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
      const remaining = Math.abs(Number(data.amount) - splitsTotal);
      if (remaining >= 0.01) {
        toast.error(t('form.toasts.splitsTotal'));
        return;
      }
    }

    // Validate investment mode required fields per action
    if (mode === 'investment') {
      const acc = accounts.find(a => a.id === data.accountId);
      if (!acc || acc.accountSubType !== 'INVESTMENT_BROKERAGE') {
        toast.error(t('form.toasts.brokerageAccountRequired'));
        return;
      }
      if (SECURITY_REQUIRED_ACTIONS.includes(investmentAction) && !investmentSecurityId) {
        toast.error(t('form.toasts.securityRequired'));
        return;
      }
      if (QUANTITY_PRICE_ACTIONS.includes(investmentAction)) {
        if (!investmentQuantity || Number(investmentQuantity) <= 0) {
          toast.error(t('form.toasts.quantityRequired'));
          return;
        }
        if (!investmentPrice || Number(investmentPrice) <= 0) {
          toast.error(t('form.toasts.priceRequired'));
          return;
        }
      } else if (QUANTITY_ONLY_ACTIONS.includes(investmentAction)) {
        if (!investmentQuantity || Number(investmentQuantity) <= 0) {
          toast.error(t('form.toasts.quantityRequired'));
          return;
        }
      } else if (AMOUNT_ONLY_ACTIONS.includes(investmentAction)) {
        if (investmentTotalAmount === '' || investmentTotalAmount === undefined) {
          toast.error(t('form.toasts.totalAmountRequired'));
          return;
        }
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
        tagIds: selectedTagIds.length > 0 ? selectedTagIds : [],
      };

      if (mode === 'transfer') {
        // Amount should be negative (money leaving source account)
        const transferAmount = -Math.abs(Number(formData.amount));
        payload = {
          ...payload,
          amount: transferAmount,
          isTransfer: true,
          transferAccountId: transferToAccountId,
          isInvestment: false,
          // A transfer may carry an optional category (#743), applied to both
          // legs when the schedule posts.
          categoryId: selectedCategoryId || undefined,
          splits: undefined,
        };
      } else if (mode === 'split') {
        payload = {
          ...payload,
          isTransfer: false,
          transferAccountId: undefined,
          isInvestment: false,
          categoryId: undefined,
          splits: toCreateSplitData(splits),
        };
      } else if (mode === 'investment') {
        // Estimate display amount from quantity*price (or totalAmount).
        const estQty = investmentQuantity === '' ? 0 : Number(investmentQuantity);
        const estPrice = investmentPrice === '' ? 0 : Number(investmentPrice);
        const estTotal = investmentTotalAmount === '' ? 0 : Number(investmentTotalAmount);
        const estCommission = investmentCommission === '' ? 0 : Number(investmentCommission);
        let displayAmount = formData.amount;
        if (QUANTITY_PRICE_ACTIONS.includes(investmentAction)) {
          const sign = investmentAction === 'SELL' ? 1 : -1;
          displayAmount = sign * (estQty * estPrice + (sign === -1 ? estCommission : -estCommission));
        } else if (AMOUNT_ONLY_ACTIONS.includes(investmentAction)) {
          displayAmount = estTotal;
        } else {
          displayAmount = 0;
        }
        payload = {
          ...payload,
          amount: roundToCents(displayAmount),
          isTransfer: false,
          transferAccountId: undefined,
          isInvestment: true,
          investmentAction,
          investmentSecurityId: investmentSecurityId || undefined,
          investmentFundingAccountId: FUNDING_ACCOUNT_ACTIONS.includes(investmentAction) && investmentFundingAccountId
            ? investmentFundingAccountId
            : undefined,
          investmentQuantity: investmentQuantity === '' ? undefined : Number(investmentQuantity),
          investmentPrice: investmentPrice === '' ? undefined : Number(investmentPrice),
          investmentCommission: investmentCommission === '' ? undefined : Number(investmentCommission),
          investmentTotalAmount: investmentTotalAmount === '' ? undefined : Number(investmentTotalAmount),
          categoryId: undefined,
          payeeId: undefined,
          payeeName: undefined,
          splits: undefined,
        };
      } else {
        payload = {
          ...payload,
          isTransfer: false,
          transferAccountId: undefined,
          isInvestment: false,
          // Editing a previously-split scheduled transaction in regular mode:
          // send an explicit empty array so the backend clears the splits and
          // sets isSplit=false. `undefined` would leave the splits untouched.
          splits: scheduledTransaction?.isSplit ? [] : undefined,
        };
      }

      if (scheduledTransaction) {
        await scheduledTransactionsApi.update(scheduledTransaction.id, payload);
        toast.success(t('form.toasts.updated'));
      } else {
        await scheduledTransactionsApi.create(payload);
        toast.success(t('form.toasts.created'));
      }
      onSuccess?.();
    } catch (error) {
      logger.error('Submit error:', error);
      toast.error(getErrorMessage(error, t('form.toasts.saveFailed')));
    } finally {
      setIsLoading(false);
    }
  };
  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const frequencyOptions = Object.keys(FREQUENCY_LABELS).map((value) => ({
    value,
    label: t(`frequency.${value}`),
  }));

  // Shared End Condition section
  const renderEndCondition = (_idSuffix: string) => {
    if (watchedFrequency === 'ONCE') return null;
    return (
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('form.endConditionTitle')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="flex items-center gap-2 mb-2 cursor-pointer w-fit">
              <ToggleSwitch
                checked={useEndDate}
                onChange={(next) => {
                  setUseEndDate(next);
                  if (next) setUseOccurrences(false);
                }}
                label={t('form.endByDateLabel')}
              />
              <span className="block text-sm text-gray-900 dark:text-gray-100">
                {t('form.endByDateLabel')}
              </span>
            </label>
            {useEndDate && (
              <DateInput
                label={t('form.endDateLabel')}
                error={errors.endDate?.message}
                onDateChange={(date) => setValue('endDate', date, { shouldDirty: true, shouldValidate: true })}
                {...register('endDate')}
              />
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 mb-2 cursor-pointer w-fit">
              <ToggleSwitch
                checked={useOccurrences}
                onChange={(next) => {
                  setUseOccurrences(next);
                  if (next) setUseEndDate(false);
                }}
                label={t('form.numberOfOccurrencesLabel')}
              />
              <span className="block text-sm text-gray-900 dark:text-gray-100">
                {t('form.numberOfOccurrencesLabel')}
              </span>
            </label>
            {useOccurrences && (
              <Input
                type="number"
                min={1}
                placeholder={t('form.occurrencesPlaceholder')}
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
  const renderOptions = (_idSuffix: string) => (
    <div className="flex items-center space-x-6">
      <label className="flex items-center gap-2 cursor-pointer">
        <ToggleSwitch
          checked={!!watch('isActive')}
          onChange={(next) => setValue('isActive', next, { shouldDirty: true })}
          label={t('form.activeLabel')}
        />
        <span className="block text-sm text-gray-900 dark:text-gray-100">
          {t('form.activeLabel')}
        </span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <ToggleSwitch
          checked={!!watch('autoPost')}
          onChange={(next) => setValue('autoPost', next, { shouldDirty: true })}
          label={t('form.autoPostLabel')}
        />
        <span className="block text-sm text-gray-900 dark:text-gray-100">
          {t('form.autoPostLabel')}
        </span>
      </label>
    </div>
  );

  // Shared Tags section
  const renderTags = () => (
    <>
      <MultiSelect
        label={t('form.tagsLabel')}
        options={tagOptions}
        value={selectedTagIds}
        onChange={setSelectedTagIds}
        placeholder={t('form.tagsPlaceholder')}
        onCreateNew={() => setShowTagForm(true)}
        createNewLabel={t('form.createTagLabel')}
      />
      <Modal isOpen={showTagForm} onClose={() => setShowTagForm(false)} maxWidth="lg" allowOverflow pushHistory className="p-6">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          {t('form.newTagTitle')}
        </h2>
        <TagForm
          onSubmit={handleTagCreate}
          onCancel={() => setShowTagForm(false)}
        />
      </Modal>
    </>
  );

  // Shared Description textarea section
  const renderDescription = () => (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.descriptionLabel')}</label>
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
        {(['transaction', 'split', 'transfer', 'investment'] as const).map((tabMode) => (
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
            {t(`form.tabs.${tabMode}` as Parameters<typeof t>[0])}
          </button>
        ))}
      </div>

      {/* ==================== Transaction Tab ==================== */}
      {mode === 'transaction' && (
        <div className="space-y-4">
          {/* Row 1: Name */}
          <Input
            label={t('form.nameLabel')}
            type="text"
            placeholder={t('form.namePlaceholderTransaction')}
            error={errors.name?.message}
            {...register('name')}
          />

          {/* Row 2: Account, Next Due Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.accountLabel')}
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: t('form.accountPlaceholder') },
                ...accountOptions,
              ]}
              {...register('accountId')}
            />
            <DateInput
              label={t('form.nextDueDateLabel')}
              error={errors.nextDueDate?.message}
              onDateChange={(date) => setValue('nextDueDate', date, { shouldDirty: true, shouldValidate: true })}
              {...register('nextDueDate')}
            />
          </div>

          {/* Row 3: Payee, Category + Split Transaction button */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Combobox
              label={t('form.payeeLabel')}
              placeholder={t('form.payeePlaceholder')}
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
                    label={t('form.categoryLabel')}
                    placeholder={t('form.categoryPlaceholder')}
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
                  {t('form.splitTransactionButton')}
                </button>
              </div>
              <button
                type="button"
                onClick={() => handleModeChange('split')}
                className="sm:hidden mt-2 w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
              >
                {t('form.splitTransactionButton')}
              </button>
            </div>
          </div>

          {/* Row 4: Amount, Reference Number */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CurrencyInput
              label={t('form.amountLabel')}
              prefix={currencySymbol}
              value={watchedAmount}
              onChange={(value) => setValue('amount', value ?? 0, { shouldValidate: true })}
              allowSignToggle
              error={errors.amount?.message}
            />
            <Input
              label={t('form.referenceNumberLabel')}
              type="text"
              placeholder={t('form.referenceNumberPlaceholder')}
              error={errors.referenceNumber?.message}
              {...register('referenceNumber')}
            />
          </div>

          {/* Row 5: Frequency, Remind Days Before */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.frequencyLabel')}
              error={errors.frequency?.message}
              value={watchedFrequency || 'MONTHLY'}
              options={frequencyOptions}
              {...register('frequency')}
            />
            <Input
              label={t('form.remindDaysBeforeLabel')}
              type="number"
              min={0}
              error={errors.reminderDaysBefore?.message}
              {...register('reminderDaysBefore', { valueAsNumber: true })}
            />
          </div>

          {/* Tags */}
          {renderTags()}

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
            label={t('form.nameLabel')}
            type="text"
            placeholder={t('form.namePlaceholderTransaction')}
            error={errors.name?.message}
            {...register('name')}
          />

          {/* Row 2: Account, Next Due Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.accountLabel')}
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: t('form.accountPlaceholder') },
                ...accountOptions,
              ]}
              {...register('accountId')}
            />
            <DateInput
              label={t('form.nextDueDateLabel')}
              error={errors.nextDueDate?.message}
              onDateChange={(date) => setValue('nextDueDate', date, { shouldDirty: true, shouldValidate: true })}
              {...register('nextDueDate')}
            />
          </div>

          {/* Row 3: Payee, Total Amount */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Combobox
              label={t('form.payeeLabel')}
              placeholder={t('form.payeePlaceholder')}
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
              label={t('form.totalAmountLabel')}
              prefix={currencySymbol}
              value={watchedAmount}
              onChange={(value) => setValue('amount', value ?? 0, { shouldValidate: true })}
              error={errors.amount?.message}
            />
          </div>

          {/* Row 4: Reference Number, Description */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t('form.referenceNumberLabel')}
              type="text"
              placeholder={t('form.referenceNumberPlaceholder')}
              error={errors.referenceNumber?.message}
              {...register('referenceNumber')}
            />
            <Input
              label={t('form.descriptionLabel')}
              type="text"
              placeholder={t('form.descriptionPlaceholder')}
              error={errors.description?.message}
              {...register('description')}
            />
          </div>

          {/* Row 5: Split Editor */}
          <div className="border-t dark:border-gray-700 pt-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{t('form.splitTransactionTitle')}</h3>
              <button
                type="button"
                onClick={() => handleModeChange('transaction')}
                className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
              >
                {t('form.cancelSplitButton')}
              </button>
            </div>
            <SplitEditor
              splits={splits}
              onChange={setSplits}
              categories={categories}
              tags={tags}
              accounts={accounts}
              sourceAccountId={watchedAccountId || ''}
              parentAccountSubType={
                accounts.find((a) => a.id === watchedAccountId)?.accountSubType ?? null
              }
              transactionAmount={watchedAmount || 0}
              onTransactionAmountChange={handleTransactionAmountChange}
              currencyCode={watchedCurrencyCode || defaultCurrency}
              onConvertToRegular={handleConvertToRegular}
            />
          </div>

          {/* Tags */}
          {renderTags()}

          {/* Row 6: Frequency, Remind Days Before */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.frequencyLabel')}
              error={errors.frequency?.message}
              value={watchedFrequency || 'MONTHLY'}
              options={frequencyOptions}
              {...register('frequency')}
            />
            <Input
              label={t('form.remindDaysBeforeLabel')}
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
            label={t('form.nameLabel')}
            type="text"
            placeholder={t('form.namePlaceholderTransfer')}
            error={errors.name?.message}
            {...register('name')}
          />

          {/* Row 2: Next Due Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <DateInput
              label={t('form.nextDueDateLabel')}
              error={errors.nextDueDate?.message}
              onDateChange={(date) => setValue('nextDueDate', date, { shouldDirty: true, shouldValidate: true })}
              {...register('nextDueDate')}
            />
          </div>

          {/* Row 3: From Account, To Account */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.fromAccountLabel')}
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: t('form.accountPlaceholder') },
                ...accountOptions,
              ]}
              {...register('accountId')}
            />
            <Select
              label={t('form.toAccountLabel')}
              value={transferToAccountId}
              onChange={(e) => setTransferToAccountId(e.target.value)}
              options={[
                { value: '', label: t('form.toAccountPlaceholder') },
                ...transferToAccountOptions,
              ]}
            />
          </div>

          {/* Row 4: Transfer Amount, Reference Number (mirrors the Transaction tab) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CurrencyInput
              label={t('form.transferAmountLabel')}
              prefix={currencySymbol}
              value={watchedAmount}
              onChange={(value) => setValue('amount', value !== undefined ? Math.abs(value) : 0, { shouldValidate: true })}
              allowNegative={false}
              error={errors.amount?.message}
            />
            <Input
              label={t('form.referenceNumberLabel')}
              type="text"
              placeholder={t('form.referenceNumberPlaceholder')}
              error={errors.referenceNumber?.message}
              {...register('referenceNumber')}
            />
          </div>

          {/* Row 5: Payee, Category. An optional category on a transfer surfaces
              it in the monthly category breakdown without counting as
              income/expense (#743). Laid out beside Payee like the Transaction tab. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Combobox
              label={t('form.payeeLabel')}
              placeholder={t('form.payeePlaceholder')}
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
              <Combobox
                label={t('form.transferCategoryLabel')}
                placeholder={t('form.categoryPlaceholder')}
                options={categoryOptions}
                value={selectedCategoryId}
                initialDisplayValue={scheduledTransaction?.category?.name || ''}
                onChange={handleCategoryChange}
                onCreateNew={handleCategoryCreate}
                allowCustomValue={true}
                error={errors.categoryId?.message}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('form.transferCategoryNote')}
              </p>
            </div>
          </div>

          {/* Row 6: Frequency, Remind Days Before */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.frequencyLabel')}
              error={errors.frequency?.message}
              value={watchedFrequency || 'MONTHLY'}
              options={frequencyOptions}
              {...register('frequency')}
            />
            <Input
              label={t('form.remindDaysBeforeLabel')}
              type="number"
              min={0}
              error={errors.reminderDaysBefore?.message}
              {...register('reminderDaysBefore', { valueAsNumber: true })}
            />
          </div>

          {/* Tags */}
          {renderTags()}

          {/* Row 7: End Condition */}
          {renderEndCondition('Transfer')}

          {/* Row 8: Description */}
          {renderDescription()}

          {/* Row 9: Active/Auto-post */}
          {renderOptions('Transfer')}
        </div>
      )}

      {/* ==================== Investment Tab ==================== */}
      {mode === 'investment' && (
        <div className="space-y-4">
          {/* Row 1: Name */}
          <Input
            label={t('form.nameLabel')}
            type="text"
            placeholder={t('form.namePlaceholderInvestment')}
            error={errors.name?.message}
            {...register('name')}
          />

          {/* Row 2: Account, Action */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.investmentAccountLabel')}
              error={errors.accountId?.message}
              value={watchedAccountId || ''}
              options={[
                { value: '', label: t('form.investmentAccountPlaceholder') },
                ...investmentAccountOptions,
              ]}
              {...register('accountId')}
            />
            <Select
              label={t('form.actionLabel')}
              value={investmentAction}
              onChange={(e) => setInvestmentAction(e.target.value as InvestmentAction)}
              options={SCHEDULABLE_INVESTMENT_ACTIONS.map(a => ({
                value: a,
                label: t(`form.investmentActionLabels.${a}` as Parameters<typeof t>[0]),
              }))}
            />
          </div>

          {/* Row 3: Security (when required) */}
          {SECURITY_REQUIRED_ACTIONS.includes(investmentAction) && (
            <Select
              label={t('form.securityLabel')}
              value={investmentSecurityId}
              onChange={(e) => setInvestmentSecurityId(e.target.value)}
              options={[
                { value: '', label: t('form.securityPlaceholder') },
                ...securityOptions,
              ]}
            />
          )}

          {/* Row 4: Quantity / Price / Commission (action-conditional) */}
          {QUANTITY_PRICE_ACTIONS.includes(investmentAction) && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Input
                  label={t('form.quantityLabel')}
                  type="number"
                  step="0.00000001"
                  min={0}
                  value={investmentQuantity}
                  onChange={(e) => handleQuantityChange(e.target.value)}
                />
                <Input
                  label={t('form.pricePerShareLabel')}
                  type="number"
                  step="0.000001"
                  min={0}
                  placeholder={
                    marketPrice != null ? `Latest: ${marketPrice}` : undefined
                  }
                  value={investmentPrice}
                  onChange={(e) => handlePriceChange(e.target.value)}
                />
                <Input
                  label={t('form.commissionLabel')}
                  type="number"
                  step="0.0001"
                  min={0}
                  value={investmentCommission}
                  onChange={(e) =>
                    setInvestmentCommission(
                      e.target.value === '' ? '' : Number(e.target.value),
                    )
                  }
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <CurrencyInput
                  label={t('form.totalValueLabel')}
                  prefix={currencySymbol}
                  value={
                    typeof investmentTotalValue === 'number'
                      ? investmentTotalValue
                      : undefined
                  }
                  onChange={handleTotalValueChange}
                />
              </div>
              {investmentSecurityId && marketPrice == null && (
                <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {t('form.noPriceHistory')}
                </p>
              )}
            </>
          )}

          {QUANTITY_ONLY_ACTIONS.includes(investmentAction) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label={t('form.quantityLabel')}
                type="number"
                step="0.00000001"
                min={0}
                value={investmentQuantity}
                onChange={(e) => setInvestmentQuantity(e.target.value === '' ? '' : Number(e.target.value))}
              />
            </div>
          )}

          {AMOUNT_ONLY_ACTIONS.includes(investmentAction) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <CurrencyInput
                label={t('form.totalAmountLabel')}
                prefix={currencySymbol}
                value={typeof investmentTotalAmount === 'number' ? investmentTotalAmount : undefined}
                onChange={(value) => setInvestmentTotalAmount(value ?? '')}
              />
            </div>
          )}

          {/* Row 5: Funding account (BUY/SELL only) */}
          {FUNDING_ACCOUNT_ACTIONS.includes(investmentAction) && (
            <div>
              <Select
                label={t('form.fundingAccountLabel')}
                value={investmentFundingAccountId}
                onChange={(e) => setInvestmentFundingAccountId(e.target.value)}
                options={[
                  { value: '', label: t('form.fundingAccountPlaceholder') },
                  ...fundingAccountOptions,
                ]}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('form.fundingAccountHelp')}
              </p>
            </div>
          )}

          {/* Row 6: Frequency, Next Due Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.frequencyLabel')}
              error={errors.frequency?.message}
              value={watchedFrequency || 'MONTHLY'}
              options={frequencyOptions}
              {...register('frequency')}
            />
            <DateInput
              label={t('form.nextDueDateLabel')}
              error={errors.nextDueDate?.message}
              onDateChange={(date) => setValue('nextDueDate', date, { shouldDirty: true, shouldValidate: true })}
              {...register('nextDueDate')}
            />
          </div>

          {/* Row 7: Reminder days */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t('form.remindDaysBeforeLabel')}
              type="number"
              min={0}
              error={errors.reminderDaysBefore?.message}
              {...register('reminderDaysBefore', { valueAsNumber: true })}
            />
          </div>

          {/* Tags */}
          {renderTags()}

          {/* End condition */}
          {renderEndCondition('Inv')}

          {/* Description */}
          {renderDescription()}

          {/* Active / Auto-post */}
          {renderOptions('Inv')}
        </div>
      )}

      {/* Actions */}
      <FormActions onCancel={onCancel} submitLabel={scheduledTransaction ? t('form.submitUpdate') : t('form.submitCreate')} isSubmitting={isLoading} />
    </form>
  );
}
