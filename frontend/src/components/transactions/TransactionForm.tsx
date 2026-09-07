'use client';

import { useState, useEffect, useMemo, useRef, useCallback, MutableRefObject } from 'react';
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
import { CurrencyPickerButton } from './CurrencyPickerButton';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { useDisableTransactionSplit } from '@/store/tourStore';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import {
  FX_RATE_DISPLAY_DECIMALS,
  getCurrencySymbol,
  roundToCents,
  roundToDecimals,
} from '@/lib/format';
import {
  getRememberedTransactionCurrency,
  rememberTransactionCurrency,
} from '@/lib/lastTransactionCurrency';
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
import { createCategoryFromInput } from '@/lib/category-create';
import { accountsApi } from '@/lib/accounts';
import { delegationApi, JointReferenceData } from '@/lib/delegation';
import { tagsApi } from '@/lib/tags';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { Account, TransferCandidate } from '@/types/account';
import { Tag } from '@/types/tag';
import { ReactivatePayeeDialog } from '@/components/payees/ReactivatePayeeDialog';
import { ContactLookupDialog } from '@/components/payees/ContactLookupDialog';
import { useContactLookupAvailable } from '@/hooks/useContactLookupAvailable';
import { usePayeeContactLookup } from '@/hooks/usePayeeContactLookup';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { AttachmentsSection } from './AttachmentsSection';
import { attachmentsApi } from '@/lib/attachments';
import type { StagedAttachment } from '@/types/attachment';
import { optionalUuid, optionalString } from '@/lib/zod-helpers';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import {
  TRANSACTION_SUBMIT_MODE_KEY,
  useTransactionSubmitMode,
} from '@/hooks/useTransactionSubmitMode';

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

/**
 * Sign a freshly entered amount magnitude according to a category: an income
 * category makes it positive, an expense category negative. An explicit sign
 * toggle -- the magnitude is unchanged from `reference`, so the user just
 * flipped the sign -- is preserved so a manual override is respected. Shared by
 * the account-currency and foreign-currency amount inputs so both behave
 * identically. With no category (or no reference), the value is returned as-is.
 */
function signAmountByCategory(
  value: number,
  reference: number | undefined,
  category: Category | undefined,
): number {
  const referenceAbs = reference !== undefined ? Math.abs(reference) : 0;
  const isJustSignChange = referenceAbs === Math.abs(value) && referenceAbs !== 0;
  if (isJustSignChange || !category) return value;
  return category.isIncome ? Math.abs(value) : -Math.abs(value);
}

/**
 * A reconciled transaction was matched against a statement during
 * reconciliation. Only the date and amount feed that match, so editing other
 * fields (payee, category, notes, reference) leaves the reconciliation intact
 * and should save without a warning. Returns true only when the submitted date
 * or amount differs from the original, in which case the edit is gated behind a
 * confirmation. Amounts are compared in integer cents at the same 2-decimal
 * precision the form loads them with, so float drift never triggers a warning.
 */
function reconciledEditAffectsReconciliation(
  original: Transaction,
  data: TransactionFormData,
): boolean {
  const dateChanged = data.transactionDate !== original.transactionDate;
  // Mirror the form's defaultValues normalization: transfers always load an
  // absolute amount, everything else keeps its sign.
  const originalAmount = original.isTransfer
    ? Math.abs(Math.round(Number(original.amount) * 100) / 100)
    : Math.round(Number(original.amount) * 100) / 100;
  const amountChanged =
    Math.round(Number(data.amount) * 100) !== Math.round(originalAmount * 100);
  return dateChanged || amountChanged;
}

interface TransactionFormProps {
  transaction?: Transaction;
  duplicateFrom?: Transaction;
  defaultAccountId?: string;
  defaultCategoryId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
  /**
   * Called after a successful create when the user chose "Create & New": the
   * form has already reset itself for the next entry, so the host keeps the
   * modal open and uses this only to refresh whatever it shows behind. Leave it
   * off and the submit button offers no such option.
   */
  onCreateAndNew?: () => void;
}

interface TransactionFormFieldsProps extends TransactionFormProps {
  /** Set by the wrapper below; carries the account the entry was filed against. */
  onCreateAnother?: (accountId: string) => void;
}

// Transaction mode type
type TransactionMode = 'normal' | 'split' | 'transfer';

function TransactionFormFields({ transaction, duplicateFrom, defaultAccountId, defaultCategoryId, onSuccess, onCancel, onDirtyChange, submitRef, onCreateAnother }: TransactionFormFieldsProps) {
  const t = useTranslations('transactions');
  const { defaultCurrency, formatCurrency, formatNumber } = useNumberFormat();
  const showCreatedAt = usePreferencesStore((s) => s.preferences?.showCreatedAt ?? false);
  const timeFormat = usePreferencesStore((s) => s.preferences?.timeFormat ?? '24h');
  const timezonePref = usePreferencesStore((s) => s.preferences?.timezone);
  const [isLoading, setIsLoading] = useState(false);
  // What the submit button does once a *new* transaction has been created.
  // Only offered when creating and only when the host can keep the window open;
  // an edit always hands back to the page.
  const [submitMode, setSubmitMode] = useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY);
  const canCreateAnother = !transaction && !!onCreateAnother;
  // Files chosen in the New Transaction window before the transaction exists;
  // uploaded once it has been created. Empty (and unused) when editing.
  const [stagedAttachments, setStagedAttachments] = useState<
    StagedAttachment[]
  >([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transferCandidates, setTransferCandidates] = useState<
    TransferCandidate[]
  >([]);
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

  // ─── new payee's contact details ──────────────────────────────────────
  //
  // Creating a payee here gives it a name and nothing else, so the lookup runs
  // on the payee that was just created and offers what it found. Nothing is
  // stored until the user confirms: the create tells the server not to run its
  // own background lookup (`deferContactLookup`), because two lookups would be
  // two paid calls and the second one would write values behind the dialogue
  // the user is still reading.
  const payeeLookupEnabled = usePreferencesStore(
    (s) => s.preferences?.payeeContactLookupEnabled ?? false,
  );
  const { available: lookupAvailable } = useContactLookupAvailable();
  // Both conditions, because either one missing makes the lookup impossible:
  // the preference is the user asking for it, the provider is what answers.
  const offerContactLookup = payeeLookupEnabled && lookupAvailable;
  const contactLookup = usePayeeContactLookup({
    onApplied: (saved) =>
      setPayees((prev) => prev.map((p) => (p.id === saved.id ? saved : p))),
  });

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
  // A tour can grey out Split; false whenever no such tour is running.
  const splitDisabled = useDisableTransactionSplit();

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

  // Foreign-currency entry state. `entryCurrency` is the currency the user is
  // typing the amount in ('' means the account currency -- an ordinary
  // transaction). `foreignAmount` is that typed amount; `fxRate` is the rate
  // (account-currency units per 1 unit of entryCurrency). On a new transaction
  // the entry currency is seeded from the sticky remembered currency; when
  // editing/duplicating a foreign transaction it comes from the source.
  const [entryCurrency, setEntryCurrency] = useState<string>(
    initSource?.originalCurrencyCode || (initSource ? '' : getRememberedTransactionCurrency()),
  );
  const [foreignAmount, setForeignAmount] = useState<number | undefined>(
    initSource?.originalAmount != null ? Number(initSource.originalAmount) : undefined,
  );
  const [fxRate, setFxRate] = useState<number | null>(
    initSource?.originalCurrencyCode ? Number(initSource.exchangeRate) : null,
  );
  // Starts true when editing an existing foreign transaction so a later date fix
  // does not clobber the bank's stored rate.
  const rateOverriddenRef = useRef<boolean>(!!initSource?.originalCurrencyCode);
  const [fxRateLoading, setFxRateLoading] = useState(false);
  // True when the last lookup errored rather than returning an answer. Kept
  // apart from `fxRate === null` so a throttled or offline request is not
  // reported to the user as "no exchange rate exists".
  const [fxRateLookupFailed, setFxRateLookupFailed] = useState(false);

  // Note: CurrencyInput components manage their own display state internally

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    getValues,
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
  const watchedDate = watch('transactionDate');

  // Foreign-currency entry is active only for non-transfer transactions whose
  // entry currency differs from the account currency. Transfers already have
  // their own cross-currency handling, so the picker is hidden there.
  const selectedAccount = accounts.find((a) => a.id === watchedAccountId);

  // ── Joint accounts ──
  // A joint row belongs to the sharing owner, so the pickers must offer the
  // OWNER's categories/payees (served by the grant-gated reference-data
  // endpoint), and per-user extras (tags, splits, attachments) are hidden.
  // The payload is kept with the account id that requested it, so a stale
  // response for a previously selected account is never offered as current.
  const selectedIsJoint = !!selectedAccount?.isJoint;
  const [jointRef, setJointRef] = useState<{
    accountId: string;
    data: JointReferenceData;
  } | null>(null);
  useEffect(() => {
    if (!selectedIsJoint || !watchedAccountId) return;
    let cancelled = false;
    delegationApi
      .getJointReferenceData(watchedAccountId)
      .then((data) => {
        if (!cancelled) setJointRef({ accountId: watchedAccountId, data });
      })
      .catch((error) => {
        logger.error(error);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedIsJoint, watchedAccountId]);
  const jointRefData =
    selectedIsJoint && jointRef?.accountId === watchedAccountId
      ? jointRef.data
      : null;
  const accountCurrency =
    selectedAccount?.currencyCode || watchedCurrencyCode || defaultCurrency;
  const isForeign =
    mode !== 'transfer' &&
    !!entryCurrency &&
    entryCurrency.toUpperCase() !== accountCurrency.toUpperCase();

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

  // Joint context swaps the picker sources for the owner's lists. While the
  // owner lists are still loading the pickers are empty rather than showing
  // the caller's own (unusable) reference data.
  const effectiveCategories = useMemo(
    () =>
      selectedIsJoint
        ? ((jointRefData?.categories ?? []) as unknown as typeof categories)
        : categories,
    [selectedIsJoint, jointRefData, categories],
  );
  const effectivePayees = useMemo(
    () =>
      selectedIsJoint
        ? ((jointRefData?.payees ?? []) as unknown as typeof payees)
        : payees,
    [selectedIsJoint, jointRefData, payees],
  );

  // Memoize category tree to avoid rebuilding on every render
  const categoryTree = useMemo(
    () => buildCategoryTree(effectiveCategories),
    [effectiveCategories],
  );

  // Memoize category options for combobox
  const categoryOptions = useMemo(() => categoryTree.map(({ category }) => {
    const parentCategory = category.parentId
      ? effectiveCategories.find(c => c.id === category.parentId)
      : null;
    return {
      value: category.id,
      label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
    };
  }), [categoryTree, effectiveCategories]);

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
      // Cross-owner transfer targets; a failure only hides the extra group.
      accountsApi.getTransferCandidates().catch(() => []),
    ])
      .then(async ([accountsData, categoriesData, payeesData, tagsData, aliasesData, candidatesData]) => {
        setAccounts(accountsData);
        setTransferCandidates(candidatesData);
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
  // the history popover next to the Payee field). Resets status to
  // UNRECONCILED, otherwise mirrors duplicateFrom behaviour. When the source
  // is a split, the form switches into split mode and the splits state is
  // restored so the user gets back the same split breakdown.
  //
  // Quick-fill copies what the source row SAYS, never the context the user is
  // entering in. Three fields are therefore left exactly as the form holds
  // them:
  //  - accountId: the recents list is global, so a chosen row often belongs to
  //    a different account than the one the user opened the form on, and
  //    silently moving the entry there is never what they asked for.
  //  - currencyCode: it follows from that account (see the currencyCode effect
  //    above), and taking the source's code would denominate the amount in a
  //    currency the account does not hold.
  //  - transactionDate: the date on screen is the user's - either the one they
  //    typed or the remembered last-entry date - so a batch of receipts dated
  //    last week stays dated last week. The old reset to today was the worse
  //    half of this: DateInput is uncontrolled here (it renders its own state
  //    and only reads the DOM on mount), so setValue moved the SUBMITTED date
  //    without moving the box, and the user saved a date the screen never
  //    showed. The source row's own date is not copied either: it is when that
  //    transaction happened, not when this one did.
  const handleQuickFill = (source: Transaction) => {
    const amount = Math.round(Number(source.amount) * 100) / 100;
    setValue('payeeId', source.payeeId || undefined, { shouldDirty: true });
    setValue('payeeName', source.payeeName || '', { shouldDirty: true });
    setValue('categoryId', source.categoryId || '', { shouldDirty: true });
    setValue('amount', amount, { shouldDirty: true, shouldValidate: true });
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

        // Adjust amount sign based on default category type (re-signs the
        // foreign amount too when entering a foreign currency).
        const category = categories.find(c => c.id === payee.defaultCategoryId);
        if (category) {
          resignActiveAmount(category);
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

      const newPayee = await payeesApi.create({
        name: name.trim(),
        ...(offerContactLookup ? { deferContactLookup: true } : {}),
      });
      // Add to payees list
      setPayees(prev => [...prev, newPayee]);
      // Select the new payee
      setSelectedPayeeId(newPayee.id);
      setValue('payeeId', newPayee.id, { shouldDirty: true, shouldValidate: true });
      setValue('payeeName', newPayee.name, { shouldDirty: true, shouldValidate: true });
      toast.success(t('form.toasts.payeeCreated', { name }));
      if (offerContactLookup) {
        // The user did not ask for this lookup by name, so a "nothing found"
        // or a failure stays quiet -- they came here to enter a transaction.
        void contactLookup.lookUp(newPayee, { announce: false });
      }
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
      // handleAmountChange. Re-signs the foreign amount when entering a foreign
      // currency, so the behaviour matches account-currency entry.
      // `effectiveCategories`, not `categories`: on a joint account the picker
      // offers the OWNER's list, so the caller's own list cannot resolve the id
      // and the income/expense sign was never applied there.
      const category = effectiveCategories.find(c => c.id === categoryId);
      if (category && mode === 'normal') {
        resignActiveAmount(category);
      }
    } else {
      // Custom value being typed - don't create yet, just track the name
      // Category will be created when user clicks "Create" option
      setSelectedCategoryId('');
      setValue('categoryId', '', { shouldDirty: true, shouldValidate: true });
    }
  };

  // The category whose income/expense flag drives the amount sign: the selected
  // category in normal mode, the first split's category in split mode.
  const activeSigningCategory = (): Category | undefined => {
    if (mode === 'split') {
      return splits.length > 0 && splits[0].categoryId
        ? effectiveCategories.find((c) => c.id === splits[0].categoryId)
        : undefined;
    }
    return selectedCategoryId
      ? effectiveCategories.find((c) => c.id === selectedCategoryId)
      : undefined;
  };

  // Handle amount change - adjust sign based on selected category
  // Only auto-adjust when the absolute value changes, not when user explicitly changes sign
  const handleAmountChange = (value: number | undefined) => {
    if (value === undefined || value === 0) {
      setValue('amount', value ?? 0, { shouldValidate: true });
      return;
    }
    const category = mode === 'normal' ? activeSigningCategory() : undefined;
    setValue('amount', signAmountByCategory(value, watchedAmount, category), {
      shouldValidate: true,
    });
  };

  // Handle split total amount change - same pattern as handleAmountChange
  // Auto-adjust sign based on first split's category, but respect explicit sign changes
  const handleSplitTotalChange = (value: number | undefined) => {
    if (value === undefined || value === 0) {
      setValue('amount', value ?? 0, { shouldValidate: true });
      return;
    }
    const category =
      splits.length > 0 && splits[0].categoryId
        ? categories.find((c) => c.id === splits[0].categoryId)
        : undefined;
    setValue('amount', signAmountByCategory(value, watchedAmount, category), {
      shouldValidate: true,
    });
  };

  // ── Foreign-currency entry helpers ──────────────────────────────────────
  //
  // When a foreign currency is chosen, the Amount input edits the foreign total
  // (`foreignAmount`); the account-currency `amount` is derived from it and the
  // fetched rate. When the account has a foreign-transaction fee configured, that
  // fee is folded into the amount (no split is created):
  //   base = round(foreignAmount x rate)
  //   fee  = -round(|base| x feePercent / 100)
  //   amount = base + fee

  // The converted account-currency base shown in the FX panel (before fee), the
  // fee itself, and the resulting total charged to the account.
  const convertedBase =
    isForeign && foreignAmount !== undefined && fxRate != null
      ? roundToCents(foreignAmount * fxRate)
      : undefined;
  const fxFeePercent = selectedAccount?.fxFeePercent ?? undefined;
  const fxFeeApplies =
    isForeign && convertedBase !== undefined && !!fxFeePercent && fxFeePercent > 0;
  const fxFeeAmount = fxFeeApplies
    ? -roundToCents((Math.abs(convertedBase as number) * (fxFeePercent as number)) / 100)
    : 0;
  const fxTotal =
    convertedBase !== undefined
      ? roundToCents(convertedBase + fxFeeAmount)
      : undefined;

  // Recompute the account-currency `amount` from the foreign amount and rate.
  // The bank's foreign-transaction fee (when the account has one) is folded into
  // the amount; no split is created. `overrideBase` forces the converted base
  // (used when the user edits the converted-base field directly).
  const recomputeFx = (
    fAmount: number | undefined,
    rate: number | null,
    overrideBase?: number,
  ) => {
    if (fAmount === undefined || rate == null) return;
    const base =
      overrideBase !== undefined ? overrideBase : roundToCents(fAmount * rate);
    const feePercent = selectedAccount?.fxFeePercent;
    const fee =
      feePercent && feePercent > 0
        ? -roundToCents((Math.abs(base) * feePercent) / 100)
        : 0;
    setValue('amount', roundToCents(base + fee), {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  // Amount input change while entering in a foreign currency. The foreign amount
  // is signed by the active category exactly as the account-currency input does
  // (income positive, expense negative, explicit sign toggle preserved), then
  // the converted account-currency amount is derived from it.
  const handleForeignAmountChange = (value: number | undefined) => {
    if (value === undefined || value === 0) {
      setForeignAmount(value);
      recomputeFx(value, fxRate);
      return;
    }
    const category = mode === 'transfer' ? undefined : activeSigningCategory();
    const signed = signAmountByCategory(value, foreignAmount, category);
    setForeignAmount(signed);
    recomputeFx(signed, fxRate);
  };

  // Re-sign the amount already entered when the category changes, so choosing an
  // expense category flips it negative (income positive). Operates on the
  // foreign amount when entering a foreign currency (and re-derives the
  // converted amount), otherwise on the account-currency amount. Mirrors the
  // sign adjustment the account-currency flow applies on category change.
  const resignActiveAmount = (category: Category) => {
    if (isForeign) {
      if (foreignAmount === undefined || foreignAmount === 0) return;
      const signed = category.isIncome
        ? Math.abs(foreignAmount)
        : -Math.abs(foreignAmount);
      if (signed !== foreignAmount) {
        setForeignAmount(signed);
        recomputeFx(signed, fxRate);
      }
      return;
    }
    if (watchedAmount === undefined || watchedAmount === 0) return;
    const signed = category.isIncome
      ? Math.abs(watchedAmount)
      : -Math.abs(watchedAmount);
    if (signed !== watchedAmount) {
      setValue('amount', signed, { shouldDirty: true, shouldValidate: true });
    }
  };

  // User edited the converted account-currency total (fee included) directly ->
  // back the fee out to the pre-fee base, derive the rate (10 dp) so it
  // round-trips, mark the rate overridden, and recompute.
  const handleConvertedTotalOverride = (total: number | undefined) => {
    if (total === undefined || !foreignAmount) return;
    // A total equal to the one the fetched rate already produces is the field
    // handing back what it was displaying, not an override. Deriving from it
    // would replace the fetched 10dp rate with one reverse-engineered from a
    // cents-rounded total and pin it against the date. Mirrors the same guard
    // in PostTransactionDialog's `handleConvertedTotalChange`.
    if (fxTotal !== undefined && total === fxTotal) return;
    const feePercent = selectedAccount?.fxFeePercent;
    let base = total;
    if (feePercent && feePercent > 0) {
      // total = base - |base| * p; solve for base by its (matching) sign.
      const p = feePercent / 100;
      base = roundToCents(total >= 0 ? total / (1 - p) : total / (1 + p));
    }
    const newRate = roundToDecimals(base / foreignAmount, 10);
    rateOverriddenRef.current = true;
    setFxRate(newRate);
    recomputeFx(foreignAmount, newRate, base);
  };

  // Currency picker selection. '' (or the account currency) resets to an
  // ordinary account-currency transaction, clearing the FX fields.
  const handleEntryCurrencyChange = (code: string) => {
    rateOverriddenRef.current = false;
    setFxRateLookupFailed(false);
    if (!code || code.toUpperCase() === accountCurrency.toUpperCase()) {
      setEntryCurrency('');
      setForeignAmount(undefined);
      setFxRate(null);
      return;
    }
    setEntryCurrency(code);
    // Seed the foreign amount from whatever is currently in the amount field so
    // the converted base has something to compute from before the user types.
    if (foreignAmount === undefined && watchedAmount) {
      setForeignAmount(watchedAmount);
    }
    // The rate-fetch effect fires on the entryCurrency change.
  };

  // Fetch the rate for (entryCurrency -> account currency) on the transaction
  // date, debounced. Skipped while the rate is user-overridden so a date tweak
  // does not discard the bank's stored rate.
  useEffect(() => {
    if (!isForeign || rateOverriddenRef.current || !watchedDate) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      setFxRateLoading(true);
      exchangeRatesApi
        .getRateForDate(entryCurrency, accountCurrency, watchedDate)
        .then((rate) => {
          if (cancelled) return;
          setFxRate(rate);
          // The server answered: a null here really does mean no rate exists
          // for this pair and date, so the warning below is a fact.
          setFxRateLookupFailed(false);
          setFxRateLoading(false);
          recomputeFx(foreignAmount, rate);
        })
        .catch(() => {
          if (cancelled) return;
          // The request itself failed (offline, throttled, timed out). That is
          // not evidence about the rate, so the panel goes blank rather than
          // claiming none exists -- the user can still type the converted
          // total, which derives a rate.
          setFxRate(null);
          setFxRateLookupFailed(true);
          setFxRateLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // recomputeFx/foreignAmount are intentionally read fresh inside the callback;
    // amount edits recompute synchronously via handleForeignAmountChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isForeign, entryCurrency, accountCurrency, watchedDate]);

  // Create a category from text typed into any of this form's category
  // pickers -- the Category field, and each split line's own picker. Returns
  // the created category so a split line can assign it to the row that asked;
  // null means nothing was created (blank input, the request failed, or the
  // account moved out from under it).
  //
  // A joint row belongs to the sharing owner and may only carry the OWNER's
  // category ids, so on a joint account this creates on the owner's ledger
  // through the capability-gated endpoint -- `categoriesApi.create` writes to
  // the CALLER's, which put an id the owner does not own on the form. Parents
  // are matched against whichever list the pickers are showing, so a
  // `Parent: Child` typed on a joint account reuses the owner's parent.
  const createCategoryFromTypedName = async (name: string): Promise<Category | null> => {
    // The request's own account, kept beside its response: which ledger the
    // create lands on is decided here, and nothing later may read it off a
    // selection that has since moved.
    const originAccountId = watchedAccountId;
    const jointAccountId = selectedIsJoint ? originAccountId : undefined;
    try {
      const result = await createCategoryFromInput(
        name,
        effectiveCategories,
        jointAccountId ? { jointAccountId } : {},
      );
      if (!result) return null;
      if (jointAccountId) {
        setJointRef(prev =>
          prev?.accountId === jointAccountId
            ? {
                ...prev,
                data: {
                  ...prev.data,
                  categories: [
                    ...prev.data.categories,
                    ...result.created.map(c => ({
                      id: c.id,
                      name: c.name,
                      parentId: c.parentId,
                      icon: c.icon,
                      color: c.color,
                      isIncome: c.isIncome,
                      isSystem: c.isSystem,
                    })),
                  ],
                },
              }
            : prev,
        );
      } else {
        setCategories(prev => [...prev, ...result.created]);
      }
      toast.success(t('form.toasts.categoryCreated', { name: result.displayName }));
      // The category exists either way and is recorded on its own ledger's
      // list above -- but only the account that asked may adopt the id. A
      // create that lands after the user picked another account would put an
      // id from one ledger onto a row in another.
      if (getValues('accountId') !== originAccountId) return null;
      return result.category;
    } catch (error) {
      logger.error('Failed to create category:', error);
      toast.error(getErrorMessage(error, t('form.toasts.categoryCreateFailed')));
      return null;
    }
  };

  // Handle creating a new category - called when user clicks "Create" in dropdown
  // Supports "Parent: Child" format to create subcategories
  // On a joint account the option is offered only when the owner granted the
  // delegation's categories-can-create capability (the same flag the server
  // re-checks on the owner-ledger endpoint); withholding the creator is what
  // removes "+ Create" from every one of this form's category pickers at once.
  // While the reference data is still loading the flag is unknown, so the
  // option stays out rather than being offered and then refused.
  //
  // "Not joint" is also the shape of "the account list has not arrived yet",
  // and the two must not be confused: offering the creator while the selected
  // id is still unresolved flashed "+ Create" onto a joint account and pointed
  // it at the CALLER's ledger for as long as it took to find out. An unknown
  // answer withholds, exactly as a refused one does.
  const categoryCreationAllowed = selectedIsJoint
    ? !!jointRefData?.categoriesCanCreate
    : !watchedAccountId || !!selectedAccount;
  const jointSafeCategoryCreator = categoryCreationAllowed
    ? createCategoryFromTypedName
    : undefined;

  // Undefined when the capability is absent, for the reason above -- which is
  // what takes "+ Create" out of the Category field and the transfer form's,
  // exactly as it does out of the split lines.
  const handleCategoryCreate = jointSafeCategoryCreator
    ? async (name: string) => {
        const newCategory = await jointSafeCategoryCreator(name);
        if (!newCategory) return;
        setSelectedCategoryId(newCategory.id);
        setValue('categoryId', newCategory.id, { shouldDirty: true, shouldValidate: true });
        categoryWasAutoSetRef.current = false;
      }
    : undefined;

  // Created At override (only when editing and preference is enabled)
  const userTimezone = resolveTimezone(timezonePref);
  const { dateFormat, formatDate } = useDateFormat();
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

  // Holds the validated form data while the user confirms editing a reconciled
  // transaction; null when no such confirmation is pending.
  const [reconciledConfirmData, setReconciledConfirmData] =
    useState<TransactionFormData | null>(null);

  // Upload any files staged in the New Transaction window to the freshly
  // created transaction. The transaction already exists at this point, so a
  // failed upload is reported but never rolls back the save.
  const uploadStagedAttachments = async (newTransactionId: string) => {
    if (stagedAttachments.length === 0) return;
    let failed = 0;
    for (const { file, original } of stagedAttachments) {
      try {
        // Both halves of a scan pair go in ONE request: the server writes them
        // in one transaction, so uploading the original separately would leave
        // a window where the pair is half stored.
        await attachmentsApi.upload(newTransactionId, file, original);
      } catch (error) {
        failed += 1;
        logger.error('Failed to upload staged attachment:', error);
      }
    }
    if (failed > 0) {
      toast.error(t('form.toasts.attachmentsUploadFailed', { count: failed }));
    }
  };

  const modeLabel = t(mode === 'transfer' ? 'form.modeLabel.transfer' : 'form.modeLabel.transaction');
  // The two behaviours the create button can carry. Order is fixed: 'close'
  // first, because it is what the button did before this choice existed.
  const submitOptions = [
    {
      id: 'close',
      label: t('form.submitCreate', { mode: modeLabel }),
      description: t('form.submitCreateDescription'),
    },
    {
      id: 'new',
      label: t('form.submitCreateAndNew', { mode: modeLabel }),
      description: t('form.submitCreateAndNewDescription'),
    },
  ];

  /**
   * Hand back to the host after a successful *create*. With "Create & New"
   * selected the form restarts in place (the wrapper remounts it, pre-filled
   * with this account and the date just used) and the modal stays open;
   * otherwise this is the ordinary `onSuccess` that closes it.
   */
  const finishAfterCreate = (accountId: string) => {
    if (canCreateAnother && submitMode === 'new') {
      onCreateAnother?.(accountId);
      return;
    }
    onSuccess?.();
  };

  const performSubmit = async (data: TransactionFormData) => {
    // Joint accounts: a free-text payee would auto-create on the OWNER's
    // ledger, which needs the delegation's payees-can-create capability. The
    // server enforces this too; refusing here keeps the form's state intact.
    if (
      selectedIsJoint &&
      mode !== 'transfer' &&
      !data.payeeId &&
      data.payeeName?.trim() &&
      !jointRefData?.payeesCanCreate
    ) {
      toast.error(t('form.toasts.jointPayeeCreateNotGranted'));
      return;
    }
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
          onSuccess?.();
        } else {
          const transfer = await transactionsApi.createTransfer(transferData);
          toast.success(t('form.toasts.transferCreated'));
          rememberTransactionDate(LAST_TRANSACTION_DATE_KEY, data.transactionDate);
          // Attach staged files to the "from" leg (the account being edited).
          await uploadStagedAttachments(transfer.fromTransaction.id);
          finishAfterCreate(data.accountId);
        }
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

      // Foreign-currency entry: require a rate (fetched or user-overridden) so we
      // never persist a foreign transaction with a silent 1.0 conversion.
      if (isForeign && (fxRate == null || foreignAmount === undefined)) {
        toast.error(t('form.toasts.fxRateRequired'));
        setIsLoading(false);
        return;
      }

      // FX fields flow onto the transaction. When editing away from a foreign
      // entry, send explicit nulls so the stored metadata is cleared.
      const fxFields = isForeign
        ? {
            originalAmount: foreignAmount,
            originalCurrencyCode: entryCurrency,
            exchangeRate: fxRate ?? undefined,
          }
        : transaction?.originalCurrencyCode
          ? { originalAmount: null, originalCurrencyCode: null }
          : {};

      const payload = {
        ...data,
        ...fxFields,
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
        onSuccess?.();
      } else {
        const created = await transactionsApi.create(payload);
        toast.success(t('form.toasts.transactionCreated'));
        rememberTransactionDate(LAST_TRANSACTION_DATE_KEY, data.transactionDate);
        // Remember the entry currency so the next new transaction pre-selects it
        // ('' when the account currency was used, which clears the stickiness).
        rememberTransactionCurrency(isForeign ? entryCurrency : '');
        await uploadStagedAttachments(created.id);
        finishAfterCreate(data.accountId);
      }
    } catch (error) {
      logger.error('Submit error:', error);
      toast.error(getErrorMessage(error, t('form.toasts.saveFailed')));
    } finally {
      setIsLoading(false);
    }
  };

  // Editing a reconciled transaction's date or amount silently changes a record
  // that was matched against a statement, so confirm before saving. Edits that
  // leave the date and amount untouched (e.g. fixing a payee or category) don't
  // affect the reconciliation and save without a prompt. New/duplicated
  // transactions start UNRECONCILED, so this only gates genuine edits.
  const onSubmit = async (data: TransactionFormData) => {
    if (
      transaction?.status === TransactionStatus.RECONCILED &&
      reconciledEditAffectsReconciliation(transaction, data)
    ) {
      setReconciledConfirmData(data);
      return;
    }
    await performSubmit(data);
  };

  const handleReconciledConfirm = async () => {
    const data = reconciledConfirmData;
    setReconciledConfirmData(null);
    if (data) await performSubmit(data);
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

  // Currency picker button, placed left of the Amount input (normal/split only).
  const currencyPickerSlot =
    mode !== 'transfer' ? (
      <CurrencyPickerButton
        value={entryCurrency}
        accountCurrencyCode={accountCurrency}
        onChange={handleEntryCurrencyChange}
        disabled={isLoading}
        anchorProps={tourAnchor(TOUR_ANCHORS.transactionCurrencyField)}
      />
    ) : undefined;

  // While entering a foreign currency, the converted account-currency amount
  // (fee included) sits directly beside the Amount input (same width). The rate
  // and fee text render together on one line below, spanning both columns.
  const convertedAmountSlot = isForeign ? (
    // Mounts only while entering a foreign currency, so a guided tour can watch
    // this anchor to detect that the user actually picked one (its `appear`
    // advance) -- covering both an existing currency and the Add-currency flow.
    <div {...tourAnchor(TOUR_ANCHORS.transactionConvertedAmount)}>
      <CurrencyInput
        label={t('form.fx.totalInCurrency', { currency: accountCurrency })}
        prefix={getCurrencySymbol(accountCurrency)}
        value={fxTotal}
        onChange={handleConvertedTotalOverride}
        allowSignToggle
      />
    </div>
  ) : undefined;

  const fxCaptionSlot = isForeign ? (
    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
      {fxRate != null ? (
        <span>
          {t('form.fx.rateCaption', {
            from: entryCurrency,
            rate: formatNumber(fxRate, FX_RATE_DISPLAY_DECIMALS),
            to: accountCurrency,
            date: watchedDate ? formatDate(watchedDate) : watchedDate,
          })}
        </span>
      ) : !fxRateLoading && !fxRateLookupFailed ? (
        // Only when the server answered "none". A failed request says nothing
        // about whether a rate exists, so it shows no caption rather than a
        // claim it cannot support.
        <span className="text-amber-600 dark:text-amber-400">
          {t('form.fx.noRateWarning', {
            from: entryCurrency,
            to: accountCurrency,
            date: watchedDate ? formatDate(watchedDate) : watchedDate,
          })}
        </span>
      ) : null}
      {fxFeeApplies && fxTotal !== undefined && (
        <span>
          {' '}
          {t('form.fx.feeCaption', {
            percent: formatNumber(
              fxFeePercent as number,
              // Keep the fee percent's own precision (up to 4 dp) instead of
              // forcing trailing zeros, while still using the locale separators.
              Math.min(4, (String(fxFeePercent).split('.')[1] || '').length),
            ),
            fee: formatCurrency(Math.abs(fxFeeAmount), accountCurrency),
          })}
        </span>
      )}
    </p>
  ) : undefined;

  return (
    <form
      {...tourAnchor(TOUR_ANCHORS.transactionForm)}
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-4"
    >
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
          {/* Greyed out while a tour asks for the simple form, so the
              walkthrough cannot be derailed into a mode it does not cover. */}
          <button
            type="button"
            onClick={() => handleModeChange('split')}
            disabled={splitDisabled || selectedIsJoint}
            title={
              selectedIsJoint
                ? t('form.jointSplitDisabled')
                : splitDisabled
                  ? t('form.splitDisabledDuringTour')
                  : undefined
            }
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              mode === 'split'
                ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:hover:bg-transparent'
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
          payees={effectivePayees}
          payeeAliasMap={payeeAliasMap}
          categoryOptions={categoryOptions}
          handlePayeeChange={handlePayeeChange}
          handlePayeeCreate={handlePayeeCreate}
          handleCategoryChange={handleCategoryChange}
          handleCategoryCreate={handleCategoryCreate}
          handleAmountChange={isForeign ? handleForeignAmountChange : handleAmountChange}
          handleModeChange={handleModeChange}
          onQuickFill={!transaction && !duplicateFrom ? handleQuickFill : undefined}
          transaction={transaction}
          createdAtSlot={createdAtSlot}
          currencyPickerSlot={currencyPickerSlot}
          convertedAmountSlot={convertedAmountSlot}
          fxCaptionSlot={fxCaptionSlot}
          amountValue={isForeign ? foreignAmount : undefined}
          amountCurrencyCode={isForeign ? entryCurrency : undefined}
          amountLabel={isForeign ? t('form.fx.totalInCurrency', { currency: entryCurrency }) : undefined}
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
          payees={effectivePayees}
          handlePayeeChange={handlePayeeChange}
          handlePayeeCreate={handlePayeeCreate}
          handleAmountChange={isForeign ? handleForeignAmountChange : handleSplitTotalChange}
          onQuickFill={!transaction && !duplicateFrom ? handleQuickFill : undefined}
          transaction={transaction}
          createdAtSlot={createdAtSlot}
          currencyPickerSlot={currencyPickerSlot}
          convertedAmountSlot={convertedAmountSlot}
          fxCaptionSlot={fxCaptionSlot}
          amountValue={isForeign ? foreignAmount : undefined}
          amountCurrencyCode={isForeign ? entryCurrency : undefined}
          amountLabel={isForeign ? t('form.fx.totalInCurrency', { currency: entryCurrency }) : undefined}
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
          transferCandidates={transferCandidates.filter(
            (c) => !accounts.some((a) => a.id === c.id),
          )}
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
          payees={effectivePayees}
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
            categories={effectiveCategories}
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
            displayCurrencyCode={isForeign ? entryCurrency : undefined}
            displayRate={isForeign ? (fxRate ?? undefined) : undefined}
            onCreateCategory={jointSafeCategoryCreator}
          />
        </div>
      )}

      {/* Tags (per-user, so hidden on a joint account's owner-owned rows) */}
      {!selectedIsJoint && (
        <MultiSelect
          label={t('form.fields.tags')}
          options={tagOptions}
          value={selectedTagIds}
          onChange={setSelectedTagIds}
          placeholder={t('form.placeholders.selectTags')}
          onCreateNew={() => setShowTagForm(true)}
          createNewLabel={t('form.placeholders.createNewTag')}
        />
      )}

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

      {/* Attachments. When editing, they are managed directly against the
          saved transaction; when creating, files are staged client-side and
          uploaded once the transaction has been created. Attachments are
          per-user, so they are not offered on a joint account's rows. */}
      {selectedIsJoint ? null : transaction ? (
        <AttachmentsSection transactionId={transaction.id} />
      ) : (
        <AttachmentsSection
          stagedFiles={stagedAttachments}
          onStagedFilesChange={setStagedAttachments}
        />
      )}

      {/* Actions. anchorProps, not a wrapper, so a guided tour rings the
          Cancel/Save pair rather than the full-width row around it. */}
      <FormActions
        anchorProps={tourAnchor(TOUR_ANCHORS.transactionFormActions)}
        onCancel={onCancel}
        submitLabel={t(transaction ? 'form.submitUpdate' : 'form.submitCreate', { mode: modeLabel })}
        isSubmitting={isLoading}
        submitOptions={canCreateAnother ? submitOptions : undefined}
        selectedSubmitOptionId={submitMode}
        onSubmitOptionChange={(id) => setSubmitMode(id === 'new' ? 'new' : 'close')}
        submitOptionsLabel={t('form.submitOptions')}
      />

      {/* What the lookup found for the payee just created -- an offer, saved
          only for the fields the user ticks. */}
      {contactLookup.target && (
        <ContactLookupDialog
          isOpen
          payee={contactLookup.target}
          suggestions={contactLookup.candidates}
          saving={contactLookup.saving}
          onCancel={contactLookup.dismiss}
          onConfirm={contactLookup.apply}
        />
      )}

      {/* Reactivate Payee Dialog */}
      <ReactivatePayeeDialog
        isOpen={showReactivateDialog}
        payee={inactivePayeeMatch}
        onReactivate={handleReactivatePayee}
        onCancel={handleCancelReactivation}
        isReactivating={isReactivating}
      />

      {/* Warn before saving edits to a reconciled transaction */}
      <ConfirmDialog
        isOpen={reconciledConfirmData !== null}
        title={t('form.reconciledConfirm.title')}
        message={t('form.reconciledConfirm.message')}
        confirmLabel={t('form.reconciledConfirm.confirm')}
        variant="warning"
        pushHistory
        onConfirm={handleReconciledConfirm}
        onCancel={() => setReconciledConfirmData(null)}
      />
    </form>
  );
}

/**
 * The transaction form as every caller sees it.
 *
 * Its only job beyond rendering the fields is "Create & New": when the user
 * asks to keep entering, the form has to go back to exactly the state a freshly
 * opened window would be in. The fields component carries a great deal of
 * derived state -- mode, splits, tags, the FX pair, staged attachments, the
 * payee reactivation flow -- so it is restarted by remounting it under a new
 * key rather than by a field-by-field reset that would quietly miss one of
 * them. The account just used is passed back in as the default (the date and
 * entry currency come from the same remembered values a fresh open reads), so
 * the next entry starts where the last one left off.
 */
export function TransactionForm(props: TransactionFormProps) {
  const { onCreateAndNew, defaultAccountId, defaultCategoryId } = props;
  const [restart, setRestart] = useState<{ n: number; accountId: string } | null>(null);

  const handleCreateAnother = useCallback(
    (accountId: string) => {
      setRestart((prev) => ({ n: (prev?.n ?? 0) + 1, accountId }));
      onCreateAndNew?.();
    },
    [onCreateAndNew],
  );

  return (
    <TransactionFormFields
      {...props}
      key={restart?.n ?? 0}
      // A restarted form is a blank new entry, not another copy of whatever the
      // first one was duplicated from.
      duplicateFrom={restart ? undefined : props.duplicateFrom}
      defaultAccountId={restart?.accountId ?? defaultAccountId}
      // The host's default category belongs to the account the host named (an
      // asset account's own category). Once the user has filed an entry against
      // a different account, it no longer applies.
      defaultCategoryId={
        restart && restart.accountId !== defaultAccountId ? undefined : defaultCategoryId
      }
      onCreateAnother={onCreateAndNew ? handleCreateAnother : undefined}
    />
  );
}
