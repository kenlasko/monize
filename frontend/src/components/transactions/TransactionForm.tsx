'use client';

import { useState, useEffect, useMemo, useRef, MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import { useForm, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Select } from '@/components/ui/Select';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows, toCreateSplitData } from './SplitEditor';
import { NormalTransactionFields } from './NormalTransactionFields';
import { SplitTransactionFields } from './SplitTransactionFields';
import { TransferTransactionFields } from './TransferTransactionFields';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { Modal } from '@/components/ui/Modal';
import { TagForm } from '@/components/tags/TagForm';
import { transactionsApi } from '@/lib/transactions';
import { getLocalDateString, resolveTimezone, isoToDatetimeLocal, datetimeLocalToIso, formatDatetimeLocal, parseDatetimeFromFormat } from '@/lib/utils';
import {
  LAST_TRANSACTION_DATE_KEY,
  getRememberedTransactionDate,
  rememberTransactionDate,
} from '@/lib/lastTransactionDate';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { accountsApi } from '@/lib/accounts';
import { tagsApi } from '@/lib/tags';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { Tag } from '@/types/tag';
import { ReactivatePayeeDialog } from '@/components/payees/ReactivatePayeeDialog';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { optionalUuid, optionalString } from '@/lib/zod-helpers';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const logger = createLogger('TransactionForm');

const buildTransactionSchema = (t: (key: string) => string) => z.object({
  accountId: z.string().uuid('Please select an account'),
  transactionDate: z.string().min(1, t('validation.dateRequired')),
  payeeId: optionalUuid,
  payeeName: optionalString,
  categoryId: optionalUuid,
  amount: z.number({ error: 'Amount is required' }),
  currencyCode: z.string().default('CAD'),
  description: optionalString,
  referenceNumber: optionalString,
  status: z.nativeEnum(TransactionStatus).default(TransactionStatus.UNRECONCILED),
});

type TransactionFormData = z.infer<ReturnType<typeof buildTransactionSchema>>;

interface TransactionFormProps {
  transaction?: Transaction;
  duplicateFrom?: Transaction;
  defaultAccountId?: string;
  defaultCategoryId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

// Transaction mode type
type TransactionMode = 'normal' | 'split' | 'transfer';

export function TransactionForm({ transaction, duplicateFrom, defaultAccountId, defaultCategoryId, onSuccess, onCancel, onDirtyChange, submitRef }: TransactionFormProps) {
  const t = useTranslations('transactions');
  const { defaultCurrency } = useNumberFormat();
  const showCreatedAt = usePreferencesStore((s) => s.preferences?.showCreatedAt ?? false);
  const timeFormat = usePreferencesStore((s) => s.preferences?.timeFormat ?? '24h');
  const timezonePref = usePreferencesStore((s) => s.preferences?.timezone);
  const [isLoading, setIsLoading] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]); // Full list of active payees
  const [payeeAliasMap, setPayeeAliasMap] = useState<Record<string, string[]>>({}); // payeeId -> alias strings
  const [tags, setTags] = useState<Tag[]>([]);
  // initSource: the transaction to pre-fill from (either editing or duplicating)
  const initSource = transaction || duplicateFrom;
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(
    initSource?.tags?.map(t => t.id) || []
  );
  const [selectedPayeeId, setSelectedPayeeId] = useState<string>(initSource?.payeeId || '');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    initSource?.categoryId || (initSource ? '' : defaultCategoryId || '')
  );
  const [, setCategoryName] = useState<string>('');
  // Tracks whether the current categoryId was set by the asset-account auto-fill
  // (so we can clear it when switching away to a non-asset account).
  const categoryWasAutoSetRef = useRef<boolean>(!initSource && !!defaultCategoryId);

  // Reactivation modal state
  const [inactivePayeeMatch, setInactivePayeeMatch] = useState<Payee | null>(null);
  const [showReactivateDialog, setShowReactivateDialog] = useState(false);
  const [isReactivating, setIsReactivating] = useState(false);
  const [pendingPayeeName, setPendingPayeeName] = useState<string>('');

  // Determine initial mode based on transaction or duplicateFrom
  const getInitialMode = (): TransactionMode => {
    if (initSource?.isTransfer) return 'transfer';
    if (initSource?.isSplit) return 'split';
    return 'normal';
  };

  // Transaction mode state (normal, split, or transfer)
  const [mode, setMode] = useState<TransactionMode>(getInitialMode());

  // Split transaction state
  const [isSplitMode, setIsSplitMode] = useState<boolean>(initSource?.isSplit || false);
  const [splits, setSplits] = useState<SplitRow[]>(
    initSource?.splits && initSource.splits.length > 0
      ? toSplitRows(initSource.splits)
      : []
  );

  // For transfers, determine from/to accounts based on amount sign
  // Negative amount = outgoing (from this account), Positive amount = incoming (to this account)
  const getTransferAccounts = () => {
    if (!initSource?.isTransfer || !initSource.linkedTransaction) {
      return { fromAccountId: '', toAccountId: '' };
    }

    const isOutgoing = Number(initSource.amount) < 0;
    if (isOutgoing) {
      // This transaction is the "from" side (money leaving)
      return {
        fromAccountId: initSource.accountId,
        toAccountId: initSource.linkedTransaction.accountId,
      };
    } else {
      // This transaction is the "to" side (money arriving)
      return {
        fromAccountId: initSource.linkedTransaction.accountId,
        toAccountId: initSource.accountId,
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
    // If editing/duplicating a transfer with different currencies, initialize target amount from linked transaction
    if (initSource?.isTransfer && initSource.linkedTransaction) {
      const isOutgoing = Number(initSource.amount) < 0;
      const toTx = isOutgoing ? initSource.linkedTransaction : initSource;
      return Math.abs(Number(toTx.amount));
    }
    return undefined;
  });
  // Transfer payee (optional)
  const [transferPayeeId, setTransferPayeeId] = useState<string>(
    initSource?.isTransfer ? (initSource.payeeId || '') : '',
  );
  const [transferPayeeName, setTransferPayeeName] = useState<string>(
    initSource?.isTransfer ? (initSource.payeeName || '') : '',
  );

  // Note: CurrencyInput components manage their own display state internally

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<TransactionFormData>({
    resolver: zodResolver(buildTransactionSchema(t)) as Resolver<TransactionFormData>,
    defaultValues: initSource
      ? {
          // For transfers, use the "from" account as the primary account
          accountId: initSource.isTransfer && initialTransferAccounts.fromAccountId
            ? initialTransferAccounts.fromAccountId
            : initSource.accountId,
          // For duplicates, use today's date; for edits, use the original date
          transactionDate: duplicateFrom ? getLocalDateString() : initSource.transactionDate,
          payeeId: initSource.payeeId || '',
          payeeName: initSource.payeeName || '',
          categoryId: initSource.categoryId || '',
          // For transfers, always show absolute amount
          amount: initSource.isTransfer
            ? Math.abs(Math.round(Number(initSource.amount) * 100) / 100)
            : Math.round(Number(initSource.amount) * 100) / 100,
          currencyCode: initSource.currencyCode,
          description: initSource.description || '',
          referenceNumber: initSource.referenceNumber || '',
          status: duplicateFrom ? TransactionStatus.UNRECONCILED : (initSource.status || TransactionStatus.UNRECONCILED),
        }
      : {
          accountId: defaultAccountId || '',
          categoryId: defaultCategoryId || '',
          transactionDate: getRememberedTransactionDate(LAST_TRANSACTION_DATE_KEY),
          currencyCode: defaultCurrency,
          status: TransactionStatus.UNRECONCILED,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  const watchedAccountId = watch('accountId');
  const watchedAmount = watch('amount');
  const watchedCurrencyCode = watch('currencyCode');
  const watchedPayeeName = watch('payeeName');

  // Auto-set currencyCode from the selected account, and pre-fill the
  // asset value change category when an ASSET account is selected.
  // The ref tracks whether the current categoryId was set by us, so a manual
  // user choice is preserved when switching accounts (in either direction).
  useEffect(() => {
    if (watchedAccountId && accounts.length > 0) {
      const account = accounts.find(a => a.id === watchedAccountId);
      if (account) {
        setValue('currencyCode', account.currencyCode, { shouldDirty: true });
        if (!initSource) {
          if (account.accountType === 'ASSET' && account.assetCategoryId) {
            if (!selectedCategoryId || categoryWasAutoSetRef.current) {
              setSelectedCategoryId(account.assetCategoryId);
              setValue('categoryId', account.assetCategoryId, { shouldDirty: true });
              categoryWasAutoSetRef.current = true;
            }
          } else if (categoryWasAutoSetRef.current) {
            setSelectedCategoryId('');
            setValue('categoryId', '', { shouldDirty: true });
            categoryWasAutoSetRef.current = false;
          }
        }
      }
    }
  }, [watchedAccountId, accounts, initSource, selectedCategoryId, setValue]);

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

  // Memoize tag options for multiselect
  const tagOptions = useMemo(() =>
    [...tags]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map(tag => ({ value: tag.id, label: tag.name })),
    [tags]
  );

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

  // Convert a split transaction back to a regular one, adopting the category of
  // the split that remains after the user deletes one of the final two splits.
  const handleConvertToRegular = (categoryId?: string) => {
    setMode('normal');
    setIsSplitMode(false);
    setSplits([]);
    setTransferToAccountId('');
    setSelectedCategoryId(categoryId || '');
    setValue('categoryId', categoryId || '', { shouldDirty: true, shouldValidate: true });
  };

  // Set defaultAccountId when it changes (and we're not editing an existing transaction)
  useEffect(() => {
    if (!transaction && defaultAccountId) {
      setValue('accountId', defaultAccountId);
    }
  }, [defaultAccountId, transaction, setValue]);

  // Set defaultCategoryId when it changes (and we're not editing/duplicating)
  useEffect(() => {
    if (!initSource && defaultCategoryId) {
      setValue('categoryId', defaultCategoryId);
      setSelectedCategoryId(defaultCategoryId);
      categoryWasAutoSetRef.current = true;
    }
  }, [defaultCategoryId, initSource, setValue]);

  // Load accounts, categories, active payees on mount
  // When editing, also fetch the transaction's payee if it's inactive so it appears in the dropdown
  useEffect(() => {
    Promise.all([
      accountsApi.getAll(true),
      categoriesApi.getAll(),
      payeesApi.getAll('active'),
      tagsApi.getAll(),
      payeesApi.getAllAliases(),
    ])
      .then(async ([accountsData, categoriesData, payeesData, tagsData, aliasesData]) => {
        setAccounts(accountsData);
        setCategories(categoriesData);
        setTags(tagsData);

        // Build payeeId -> alias strings lookup
        const aliasMap: Record<string, string[]> = {};
        for (const alias of aliasesData) {
          if (!aliasMap[alias.payeeId]) {
            aliasMap[alias.payeeId] = [];
          }
          aliasMap[alias.payeeId].push(alias.alias);
        }
        setPayeeAliasMap(aliasMap);

        // If editing a transaction with a payee that isn't in the active list, fetch it
        if (transaction?.payeeId && !payeesData.some(p => p.id === transaction.payeeId)) {
          try {
            const existingPayee = await payeesApi.getById(transaction.payeeId);
            setPayees([...payeesData, existingPayee]);
          } catch {
            // Payee may have been deleted; just use active list
            setPayees(payeesData);
          }
        } else {
          setPayees(payeesData);
        }
      })
      .catch((error) => {
        toast.error(getErrorMessage(error, t('form.toasts.loadFailed')));
        logger.error(error);
      });
  }, [transaction?.payeeId, t]);

  // Quick-fill the form from a previously entered transaction (chosen from
  // the history popover next to the Payee field). Resets date to today and
  // status to UNRECONCILED, otherwise mirrors duplicateFrom behaviour. When
  // the source is a split, the form switches into split mode and the splits
  // state is restored so the user gets back the same split breakdown.
  const handleQuickFill = (source: Transaction) => {
    const amount = Math.round(Number(source.amount) * 100) / 100;
    setValue('accountId', source.accountId, { shouldDirty: true, shouldValidate: true });
    setValue('transactionDate', getLocalDateString(), { shouldDirty: true, shouldValidate: true });
    setValue('payeeId', source.payeeId || undefined, { shouldDirty: true });
    setValue('payeeName', source.payeeName || '', { shouldDirty: true });
    setValue('categoryId', source.categoryId || '', { shouldDirty: true });
    setValue('amount', amount, { shouldDirty: true, shouldValidate: true });
    setValue('currencyCode', source.currencyCode, { shouldDirty: true });
    setValue('description', source.description || '', { shouldDirty: true });
    setValue('referenceNumber', '', { shouldDirty: true });
    setValue('status', TransactionStatus.UNRECONCILED, { shouldDirty: true });

    setSelectedPayeeId(source.payeeId || '');
    setSelectedCategoryId(source.categoryId || '');
    categoryWasAutoSetRef.current = false;
    setSelectedTagIds(source.tags?.map((t) => t.id) || []);

    if (source.isSplit && source.splits && source.splits.length > 0) {
      setSplits(toSplitRows(source.splits));
      setIsSplitMode(true);
      setMode('split');
    } else {
      setSplits([]);
      setIsSplitMode(false);
      setMode('normal');
    }
  };

  // Handle payee selection
  const handlePayeeChange = (payeeId: string, payeeName: string) => {
    setSelectedPayeeId(payeeId);
    setValue('payeeName', payeeName, { shouldDirty: true });

    if (payeeId) {
      setValue('payeeId', payeeId, { shouldDirty: true });

      // Auto-fill category from payee's default category
      const payee = payees.find(p => p.id === payeeId);
      if (payee?.defaultCategoryId && !selectedCategoryId) {
        setSelectedCategoryId(payee.defaultCategoryId);
        setValue('categoryId', payee.defaultCategoryId, { shouldDirty: true });
        categoryWasAutoSetRef.current = false;

        // Adjust amount sign based on default category type
        const category = categories.find(c => c.id === payee.defaultCategoryId);
        if (category && watchedAmount !== undefined && watchedAmount !== 0) {
          const absAmount = Math.abs(watchedAmount);
          const newAmount = category.isIncome ? absAmount : -absAmount;
          if (newAmount !== watchedAmount) {
            setValue('amount', newAmount, { shouldDirty: true });
          }
        }
      }
    } else {
      // Custom payee name (not in database)
      setValue('payeeId', undefined, { shouldDirty: true });
    }
  };

  // Handle creating a new payee - called when user clicks "Create" in dropdown
  // First checks if name matches an inactive payee and offers reactivation
  const handlePayeeCreate = async (name: string) => {
    if (!name.trim()) return;

    try {
      // Check if this name matches an inactive payee
      const inactiveMatch = await payeesApi.findInactiveByName(name.trim());
      if (inactiveMatch) {
        setInactivePayeeMatch(inactiveMatch);
        setPendingPayeeName(name.trim());
        setShowReactivateDialog(true);
        return;
      }

      const newPayee = await payeesApi.create({ name: name.trim() });
      // Add to payees list
      setPayees(prev => [...prev, newPayee]);
      // Select the new payee
      setSelectedPayeeId(newPayee.id);
      setValue('payeeId', newPayee.id, { shouldDirty: true, shouldValidate: true });
      setValue('payeeName', newPayee.name, { shouldDirty: true, shouldValidate: true });
      toast.success(t('form.toasts.payeeCreated', { name }));
    } catch (error) {
      logger.error('Failed to create payee:', error);
      toast.error(getErrorMessage(error, t('form.toasts.payeeCreateFailed')));
    }
  };

  // Handle reactivating a payee from the reactivation dialog
  const handleReactivatePayee = async () => {
    if (!inactivePayeeMatch) return;

    setIsReactivating(true);
    try {
      const reactivated = await payeesApi.reactivatePayee(inactivePayeeMatch.id);
      // Add to active payees list
      setPayees(prev => [...prev, reactivated]);
      // Select the reactivated payee
      setSelectedPayeeId(reactivated.id);
      setValue('payeeId', reactivated.id, { shouldDirty: true, shouldValidate: true });
      setValue('payeeName', reactivated.name, { shouldDirty: true, shouldValidate: true });

      // Auto-fill category from reactivated payee's default category
      if (reactivated.defaultCategoryId && !selectedCategoryId) {
        setSelectedCategoryId(reactivated.defaultCategoryId);
        setValue('categoryId', reactivated.defaultCategoryId, { shouldDirty: true });
        categoryWasAutoSetRef.current = false;
      }

      toast.success(t('form.toasts.payeeReactivated', { name: reactivated.name }));
      setShowReactivateDialog(false);
      setInactivePayeeMatch(null);
      setPendingPayeeName('');
    } catch (error) {
      logger.error('Failed to reactivate payee:', error);
      toast.error(getErrorMessage(error, t('form.toasts.payeeReactivateFailed')));
    } finally {
      setIsReactivating(false);
    }
  };

  // Handle canceling reactivation - create a new payee with the name instead
  const handleCancelReactivation = () => {
    setShowReactivateDialog(false);
    setInactivePayeeMatch(null);
    // Just set the payee name as a custom value (no payee record)
    setValue('payeeName', pendingPayeeName, { shouldDirty: true });
    setValue('payeeId', undefined, { shouldDirty: true });
    setPendingPayeeName('');
  };

  // Handle category selection - only create when explicitly selected from dropdown
  const handleCategoryChange = (categoryId: string, name: string) => {
    setCategoryName(name);
    categoryWasAutoSetRef.current = false;

    if (categoryId) {
      // Existing category selected
      setSelectedCategoryId(categoryId);
      setValue('categoryId', categoryId, { shouldDirty: true, shouldValidate: true });

      // Adjust amount sign based on category type (income = positive, expense
      // = negative) -- only in normal mode. A transfer amount is always entered
      // as a positive number (the legs' signs are derived on save), so an
      // expense category must not flip it negative or the transfer fails the
      // "amount must be positive" check. Mirrors the mode guard in
      // handleAmountChange.
      const category = categories.find(c => c.id === categoryId);
      if (
        category &&
        mode === 'normal' &&
        watchedAmount !== undefined &&
        watchedAmount !== 0
      ) {
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

  // Handle split total amount change - same pattern as handleAmountChange
  // Auto-adjust sign based on first split's category, but respect explicit sign changes
  const handleSplitTotalChange = (value: number | undefined) => {
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

    // Infer sign from first split's category
    if (splits.length > 0 && splits[0].categoryId) {
      const category = categories.find(c => c.id === splits[0].categoryId);
      if (category) {
        const absAmount = Math.abs(value);
        const newAmount = category.isIncome ? absAmount : -absAmount;
        setValue('amount', newAmount, { shouldValidate: true });
        return;
      }
    }

    // No category on first split, use value as-is
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
      categoryWasAutoSetRef.current = false;

      if (parentId && parentName) {
        toast.success(t('form.toasts.categoryCreated', { name: `${parentName}: ${categoryName}` }));
      } else {
        toast.success(t('form.toasts.categoryCreated', { name: categoryName }));
      }
    } catch (error) {
      logger.error('Failed to create category:', error);
      toast.error(getErrorMessage(error, t('form.toasts.categoryCreateFailed')));
    }
  };

  // Created At override (only when editing and preference is enabled)
  const userTimezone = resolveTimezone(timezonePref);
  const { dateFormat } = useDateFormat();
  const [createdAtValue, setCreatedAtValue] = useState(() => {
    if (!transaction?.createdAt) return '';
    return isoToDatetimeLocal(transaction.createdAt, userTimezone);
  });
  const [createdAtOriginal, setCreatedAtOriginal] = useState(() => {
    if (!transaction?.createdAt) return '';
    return isoToDatetimeLocal(transaction.createdAt, userTimezone);
  });
  const [createdAtDisplay, setCreatedAtDisplay] = useState(() => {
    if (!transaction?.createdAt) return '';
    return formatDatetimeLocal(isoToDatetimeLocal(transaction.createdAt, userTimezone), dateFormat, timeFormat);
  });

  // Recalculate if the timezone preference or date format loads/changes after initial mount
  useEffect(() => {
    if (!transaction?.createdAt) return;
    const dtLocal = isoToDatetimeLocal(transaction.createdAt, userTimezone);
    setCreatedAtValue(dtLocal);
    setCreatedAtOriginal(dtLocal);
    setCreatedAtDisplay(formatDatetimeLocal(dtLocal, dateFormat, timeFormat));
  }, [transaction?.createdAt, userTimezone, dateFormat, timeFormat]);

  // Tag creation modal state
  const [showTagForm, setShowTagForm] = useState(false);

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

  const onSubmit = async (data: TransactionFormData) => {
    setIsLoading(true);
    try {
      // Handle transfer mode
      if (mode === 'transfer') {
        if (!transferToAccountId) {
          toast.error(t('form.toasts.destinationRequired'));
          setIsLoading(false);
          return;
        }
        if (transferToAccountId === data.accountId) {
          toast.error(t('form.toasts.sameAccount'));
          setIsLoading(false);
          return;
        }
        if (data.amount === undefined || data.amount === null || data.amount < 0) {
          toast.error(t('form.toasts.negativeTransfer'));
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
          description: data.description ?? null,
          referenceNumber: data.referenceNumber ?? null,
          status: data.status,
          payeeId: transferPayeeId || null,
          payeeName: transferPayeeName || null,
          // Optional category: lets the transfer surface in the monthly category
          // breakdown without counting as income/expense. null clears it on edit.
          categoryId: data.categoryId || null,
          tagIds: selectedTagIds.length > 0 ? selectedTagIds : [],
        };

        // Include target amount for cross-currency transfers
        if (crossCurrencyInfo && transferTargetAmount !== undefined && transferTargetAmount > 0) {
          transferData.toAmount = transferTargetAmount;
        }

        if (transaction?.isTransfer) {
          if (showCreatedAt && createdAtValue && createdAtValue !== createdAtOriginal) {
            transferData.createdAt = datetimeLocalToIso(createdAtValue, userTimezone);
          }
          await transactionsApi.updateTransfer(transaction.id, transferData);
          toast.success(t('form.toasts.transferUpdated'));
        } else {
          await transactionsApi.createTransfer(transferData);
          toast.success(t('form.toasts.transferCreated'));
          rememberTransactionDate(LAST_TRANSACTION_DATE_KEY, data.transactionDate);
        }
        onSuccess?.();
        return;
      }

      // Prepare splits data. When editing a transaction that was previously a
      // split but is now saved in non-split mode, send an explicit empty array
      // so the backend clears the splits and converts it to a regular one.
      // (`undefined` means "leave splits untouched", which is wrong here.)
      const wasSplit = Boolean(transaction?.isSplit);
      const splitsData = isSplitMode
        ? toCreateSplitData(splits)
        : wasSplit
          ? []
          : undefined;

      // Validate splits sum to amount if in split mode
      if (isSplitMode && splitsData) {
        const splitsTotal = splitsData.reduce((sum, s) => sum + s.amount, 0);
        const roundedSplitsTotal = Math.round(splitsTotal * 100) / 100;
        const roundedAmount = Math.round(data.amount * 100) / 100;
        if (roundedSplitsTotal !== roundedAmount) {
          toast.error(t('form.toasts.splitsNotEqual', { splitTotal: roundedSplitsTotal, txAmount: roundedAmount }));
          setIsLoading(false);
          return;
        }
      }

      const payload = {
        ...data,
        splits: splitsData,
        tagIds: selectedTagIds.length > 0 ? selectedTagIds : [],
        // Clear categoryId for split transactions. For non-split transactions
        // send null (not '' or undefined) when the category was removed: an
        // empty string fails the backend's UUID validation (so the update is
        // rejected and the old category sticks), while undefined is dropped by
        // JSON.stringify (so the backend never learns the category was cleared).
        categoryId: isSplitMode ? undefined : (data.categoryId || null),
        // A cleared payee must be sent as null, not the empty string the
        // combobox yields: '' fails the backend's UUID validation (rejecting
        // the update so the old payee sticks). A typed custom payee keeps its
        // name with a null payeeId so the backend can link or create it.
        payeeId: data.payeeId || null,
        payeeName: data.payeeName || null,
        // Ensure cleared optional fields are sent as null (not undefined)
        // so the backend knows to clear them rather than ignoring the field
        description: data.description ?? null,
        referenceNumber: data.referenceNumber ?? null,
      };

      if (transaction) {
        // Include createdAt override if preference is enabled and value was changed
        const updatePayload: any = { ...payload };
        if (showCreatedAt && createdAtValue && createdAtValue !== createdAtOriginal) {
          updatePayload.createdAt = datetimeLocalToIso(createdAtValue, userTimezone);
        }
        await transactionsApi.update(transaction.id, updatePayload);
        toast.success(t('form.toasts.transactionUpdated'));
      } else {
        await transactionsApi.create(payload);
        toast.success(t('form.toasts.transactionCreated'));
        rememberTransactionDate(LAST_TRANSACTION_DATE_KEY, data.transactionDate);
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

  const createdAtSlot = showCreatedAt && transaction ? (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {t('form.fields.createDate')}
      </label>
      <input
        type="text"
        value={createdAtDisplay}
        onChange={(e) => {
          setCreatedAtDisplay(e.target.value);
          const parsed = parseDatetimeFromFormat(e.target.value, dateFormat);
          if (parsed) {
            setCreatedAtValue(parsed);
          }
        }}
        onBlur={() => {
          const parsed = parseDatetimeFromFormat(createdAtDisplay, dateFormat);
          if (parsed) {
            setCreatedAtValue(parsed);
            setCreatedAtDisplay(formatDatetimeLocal(parsed, dateFormat, timeFormat));
          } else if (createdAtValue) {
            setCreatedAtDisplay(formatDatetimeLocal(createdAtValue, dateFormat, timeFormat));
          }
        }}
        placeholder={`${dateFormat === 'browser' ? 'MM/DD/YYYY' : dateFormat} ${timeFormat === '12h' ? 'h:mm AM/PM' : 'HH:mm'}`}
        className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-400"
      />
    </div>
  ) : undefined;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Mode selector - show for new/duplicate transactions, or non-transfer edits */}
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
            {t('form.modeTransaction')}
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
            {t('form.modeSplit')}
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
            {t('form.modeTransfer')}
          </button>
        </div>
      )}

      {/* Transfer mode indicator for editing existing transfers */}
      {transaction?.isTransfer && (
        <div className="flex items-center space-x-2 pb-2 border-b dark:border-gray-700">
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200">
            {t('form.transferBadge')}
          </span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {t('form.isLinkedTransfer')}
          </span>
        </div>
      )}

      {mode === 'normal' && (
        <NormalTransactionFields
          register={register}
          setValue={setValue}
          errors={errors}
          watchedAccountId={watchedAccountId}
          watchedAmount={watchedAmount}
          watchedCurrencyCode={watchedCurrencyCode}
          watchedPayeeName={watchedPayeeName}
          accounts={accounts}
          selectedPayeeId={selectedPayeeId}
          selectedCategoryId={selectedCategoryId}
          payees={payees}
          payeeAliasMap={payeeAliasMap}
          categoryOptions={categoryOptions}
          handlePayeeChange={handlePayeeChange}
          handlePayeeCreate={handlePayeeCreate}
          handleCategoryChange={handleCategoryChange}
          handleCategoryCreate={handleCategoryCreate}
          handleAmountChange={handleAmountChange}
          handleModeChange={handleModeChange}
          onQuickFill={!transaction && !duplicateFrom ? handleQuickFill : undefined}
          transaction={transaction}
          createdAtSlot={createdAtSlot}
        />
      )}

      {mode === 'split' && (
        <SplitTransactionFields
          register={register}
          setValue={setValue}
          errors={errors}
          watchedAccountId={watchedAccountId}
          watchedAmount={watchedAmount}
          watchedCurrencyCode={watchedCurrencyCode}
          watchedPayeeName={watchedPayeeName}
          accounts={accounts}
          selectedPayeeId={selectedPayeeId}
          payees={payees}
          handlePayeeChange={handlePayeeChange}
          handlePayeeCreate={handlePayeeCreate}
          handleAmountChange={handleSplitTotalChange}
          onQuickFill={!transaction && !duplicateFrom ? handleQuickFill : undefined}
          transaction={transaction}
          createdAtSlot={createdAtSlot}
        />
      )}

      {mode === 'transfer' && (
        <TransferTransactionFields
          register={register}
          errors={errors}
          watchedAccountId={watchedAccountId}
          watchedAmount={watchedAmount}
          watchedCurrencyCode={watchedCurrencyCode}
          accounts={accounts}
          setValue={setValue}
          transferToAccountId={transferToAccountId}
          setTransferToAccountId={setTransferToAccountId}
          transferTargetAmount={transferTargetAmount}
          setTransferTargetAmount={setTransferTargetAmount}
          transferPayeeId={transferPayeeId}
          transferPayeeName={transferPayeeName}
          setTransferPayeeId={setTransferPayeeId}
          setTransferPayeeName={setTransferPayeeName}
          crossCurrencyInfo={crossCurrencyInfo}
          payees={payees}
          payeeAliasMap={payeeAliasMap}
          categoryOptions={categoryOptions}
          selectedCategoryId={selectedCategoryId}
          handleCategoryChange={handleCategoryChange}
          handleCategoryCreate={handleCategoryCreate}
          transaction={transaction}
          createdAtSlot={createdAtSlot}
        />
      )}

      {/* Split Editor - shown when in split mode */}
      {isSplitMode && (
        <div className="border-t dark:border-gray-700 pt-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{t('form.splitSection.title')}</h3>
            <button
              type="button"
              onClick={() => handleSplitModeToggle(false)}
              className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
            >
              {t('form.splitSection.cancelSplit')}
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
            disabled={isLoading}
            onTransactionAmountChange={(amount) => setValue('amount', amount, { shouldDirty: true, shouldValidate: true })}
            currencyCode={watchedCurrencyCode || defaultCurrency}
            onConvertToRegular={handleConvertToRegular}
          />
        </div>
      )}

      {/* Tags */}
      <MultiSelect
        label={t('form.fields.tags')}
        options={tagOptions}
        value={selectedTagIds}
        onChange={setSelectedTagIds}
        placeholder={t('form.placeholders.selectTags')}
        onCreateNew={() => setShowTagForm(true)}
        createNewLabel={t('form.placeholders.createNewTag')}
      />

      {/* Tag Creation Modal */}
      <Modal isOpen={showTagForm} onClose={() => setShowTagForm(false)} maxWidth="lg" allowOverflow pushHistory className="p-6">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          {t('form.newTagTitle')}
        </h2>
        <TagForm
          onSubmit={handleTagCreate}
          onCancel={() => setShowTagForm(false)}
        />
      </Modal>

      {/* Description - only shown when not in split mode (split mode has it inline with Reference Number) */}
      {!isSplitMode && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('form.fields.description')}
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
      )}

      {/* Status selector */}
      <Select
        label={t('form.fields.status')}
        options={[
          { value: TransactionStatus.UNRECONCILED, label: t('form.statusOptions.unreconciled') },
          { value: TransactionStatus.CLEARED, label: t('form.statusOptions.cleared') },
          { value: TransactionStatus.RECONCILED, label: t('form.statusOptions.reconciled') },
          { value: TransactionStatus.VOID, label: t('form.statusOptions.void') },
        ]}
        {...register('status')}
      />

      {/* Actions */}
      <FormActions
        onCancel={onCancel}
        submitLabel={t(transaction ? 'form.submitUpdate' : 'form.submitCreate', { mode: t(mode === 'transfer' ? 'form.modeLabel.transfer' : 'form.modeLabel.transaction') })}
        isSubmitting={isLoading}
      />

      {/* Reactivate Payee Dialog */}
      <ReactivatePayeeDialog
        isOpen={showReactivateDialog}
        payee={inactivePayeeMatch}
        onReactivate={handleReactivatePayee}
        onCancel={handleCancelReactivation}
        isReactivating={isReactivating}
      />
    </form>
  );
}
