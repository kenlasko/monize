'use client';

import { FALLBACK_DEFAULT_CURRENCY } from '@/lib/default-currency';
import { useState, useEffect, useMemo, useRef, MutableRefObject } from 'react';
import { useForm, useWatch, Controller, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { MAX_REMINDER_DAYS_BEFORE } from '@/lib/scheduled-reminder-bounds';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { TagForm } from '@/components/tags/TagForm';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows, toCreateSplitData } from '@/components/transactions/SplitEditor';
import { bookSplitRowsAtMinorUnit } from '@/lib/minor-unit-booking';
import { CurrencyPickerButton } from '@/components/transactions/CurrencyPickerButton';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { investmentsApi } from '@/lib/investments';
import { getLocalDateString } from '@/lib/utils';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { createCategoryFromInput } from '@/lib/category-create';
import { accountsApi } from '@/lib/accounts';
import { tagsApi } from '@/lib/tags';
import { ScheduledTransaction, FrequencyType, FREQUENCY_VALUES } from '@/types/scheduled-transaction';
import { InvestmentAction, Security } from '@/types/investment';
import { baseInvestmentAction } from '@/lib/investment-actions';
import { Transaction } from '@/types/transaction';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { Tag } from '@/types/tag';
import { useTagPickerOptions } from '@/hooks/useTagPickerOptions';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents, getCurrencySymbol, FX_RATE_DISPLAY_DECIMALS } from '@/lib/format';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import { getErrorMessage } from '@/lib/errors';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { totalFromQuantity, quantityFromTotal, roundPrice, usableClose } from '@/lib/investmentFold';
import { createLogger } from '@/lib/logger';

import { optionalUuid, optionalString, optionalNumber } from '@/lib/zod-helpers';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { TRANSACTION_NOTE_MAX_LENGTH } from '@/lib/transaction-note';

const logger = createLogger('ScheduledTxForm');

export type ScheduledTransactionMode = 'transaction' | 'split' | 'transfer' | 'investment';


// Mirrors visibility rules in InvestmentTransactionForm — keep in sync.
const SECURITY_REQUIRED_ACTIONS: InvestmentAction[] = [
  'BUY', 'SELL', 'DIVIDEND', 'CAPITAL_GAIN', 'RETURN_OF_CAPITAL', 'SPLIT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES',
];
const QUANTITY_PRICE_ACTIONS: InvestmentAction[] = ['BUY', 'SELL', 'REINVEST'];
const QUANTITY_ONLY_ACTIONS: InvestmentAction[] = ['ADD_SHARES', 'REMOVE_SHARES', 'SPLIT'];
const AMOUNT_ONLY_ACTIONS: InvestmentAction[] = ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'RETURN_OF_CAPITAL'];
const FUNDING_ACCOUNT_ACTIONS: InvestmentAction[] = ['BUY', 'SELL'];

const SCHEDULABLE_INVESTMENT_ACTIONS: InvestmentAction[] = [
  'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES',
  // Money's distribution vocabulary (issue #1149): schedulable like their base.
  'REINVEST_INTEREST', 'REINVEST_CAPITAL_GAIN_SHORT', 'REINVEST_CAPITAL_GAIN_LONG',
  'CAPITAL_GAIN_SHORT', 'CAPITAL_GAIN_LONG', 'REDEEM',
  // A fund's regular return of capital (issue #1800).
  'RETURN_OF_CAPITAL',
];

const buildScheduledTransactionSchema = (t: (key: string) => string) => z.object({
  accountId: z.string().uuid('Please select an account'),
  name: z.string().min(1, t('validation.nameRequired')),
  payeeId: optionalUuid,
  payeeName: optionalString,
  categoryId: optionalUuid,
  amount: z.number({ error: 'Amount is required' }),
  currencyCode: z.string().default(FALLBACK_DEFAULT_CURRENCY),
  description: optionalString,
  referenceNumber: optionalString,
  frequency: z.enum(FREQUENCY_VALUES),
  nextDueDate: z.string().min(1, t('validation.dueDateRequired')),
  endDate: optionalString,
  occurrencesRemaining: optionalNumber,
  isActive: z.boolean().default(true),
  autoPost: z.boolean().default(false),
  // Bounded like the server bounds it: the value reaches a date computation, and
  // an out-of-range one used to come back as a raw 400 from a form that had
  // happily accepted it (issue #1247 review).
  reminderDaysBefore: z
    .number()
    .min(0)
    .max(MAX_REMINDER_DAYS_BEFORE, {
      message: `Must be ${MAX_REMINDER_DAYS_BEFORE} days or fewer`,
    })
    .default(3),
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
  const accountOptionLabel = useAccountOptionLabel();
  const { defaultCurrency, formatCurrency, formatNumber, formatPrice } = useNumberFormat();
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
  // True only once a price request completes and returns no usable close -- the
  // one state that means "this security genuinely has no price history". Kept
  // apart from marketPrice == null, which is also the loading window and a failed
  // lookup: a failed lookup is not an empty dataset (docs/frontend/api-and-cache.md).
  const [priceHistoryEmpty, setPriceHistoryEmpty] = useState(false);
  const [investmentTotalValue, setInvestmentTotalValue] = useState<number | ''>(() => {
    const q = scheduledTransaction?.investmentQuantity;
    const p = scheduledTransaction?.investmentPrice;
    const c = scheduledTransaction?.investmentCommission ?? 0;
    if (q != null && p != null) {
      const sign = baseInvestmentAction(scheduledTransaction?.investmentAction as InvestmentAction ?? 'BUY') === 'SELL' ? -1 : 1;
      return totalFromQuantity(Number(q), Number(p), sign, Number(c));
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
  // A stored template is priced at 4dp (a LINEAR mortgage installment is
  // 864.5833 + 306.0625 = 1,170.6458); the form edits it in the currency's
  // smallest unit, lines and parent alike, or saving a cents parent over the
  // 4dp lines is refused (issue #1581).
  const [bookedTemplate] = useState(() =>
    scheduledTransaction?.splits && scheduledTransaction.splits.length > 0 && !isScheduledTransfer(scheduledTransaction)
      ? bookSplitRowsAtMinorUnit(
          toSplitRows(scheduledTransaction.splits),
          Number(scheduledTransaction.amount),
          scheduledTransaction.currencyCode,
          scheduledTransaction.splits,
        )
      : null,
  );
  const [splits, setSplits] = useState<SplitRow[]>(
    bookedTemplate
      ? bookedTemplate.rows
      : scheduledTransaction?.splits && scheduledTransaction.splits.length > 0 && !isScheduledTransfer(scheduledTransaction)
        ? toSplitRows(scheduledTransaction.splits)
        : templateTransaction?.splits && templateTransaction.splits.length > 0 && !templateTransaction.isTransfer
          ? toSplitRows(templateTransaction.splits)
          : []
  );

  const {
    register,
    handleSubmit,
    setValue,
    control,
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
            : (bookedTemplate?.parentAmount ?? Math.round(Number(scheduledTransaction.amount) * 100) / 100),
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

  const watchedAccountId = useWatch({ control, name: 'accountId' });
  const watchedAmount = useWatch({ control, name: 'amount' });
  const watchedFrequency = useWatch({ control, name: 'frequency' });
  const watchedCurrencyCode = useWatch({ control, name: 'currencyCode' });
  const watchedIsActive = useWatch({ control, name: 'isActive' });
  const watchedNextDueDate = useWatch({ control, name: 'nextDueDate' });
  const watchedAutoPost = useWatch({ control, name: 'autoPost' });

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

  // ── Foreign-currency entry ────────────────────────────────────────────────
  //
  // Mirrors TransactionForm: `entryCurrency` is the currency the amount is
  // typed in ('' means the account currency), `foreignAmount` is that typed
  // amount, and `fxRate` is account-currency units per 1 unit of it. What
  // differs is which rate: a schedule is future-dated, so there is no rate for
  // its due date. The latest available rate converts the estimate stored in
  // `amount` (the figure the bills list and forecast chart read, refreshed
  // nightly by the backend), and the rate for the posting date is looked up
  // again when an occurrence actually posts.
  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === watchedAccountId),
    [accounts, watchedAccountId],
  );
  const accountCurrency =
    selectedAccount?.currencyCode || watchedCurrencyCode || defaultCurrency;

  const [entryCurrency, setEntryCurrency] = useState<string>(
    scheduledTransaction?.originalCurrencyCode || '',
  );
  const [foreignAmount, setForeignAmount] = useState<number | undefined>(
    scheduledTransaction?.originalAmount != null
      ? Number(scheduledTransaction.originalAmount)
      : undefined,
  );
  const [fxRate, setFxRate] = useState<number | null>(
    scheduledTransaction?.originalCurrencyCode
      ? Number(scheduledTransaction.exchangeRate)
      : null,
  );
  const [fxRateLoading, setFxRateLoading] = useState(false);
  // Guards the rate-fetch effect from clobbering a rate the user typed in.
  const rateOverriddenRef = useRef(false);

  // Only a plain scheduled transaction can be entered in another currency: a
  // transfer already has cross-currency handling per leg, an investment carries
  // its own rate, and split amounts are stored in the account currency and
  // could not be re-derived when the rate moves. The backend rejects the
  // combination too.
  const isForeign =
    mode === 'transaction' &&
    !!entryCurrency &&
    entryCurrency.toUpperCase() !== accountCurrency.toUpperCase();

  const fxFeePercent = selectedAccount?.fxFeePercent ?? undefined;
  const convertedBase =
    isForeign && foreignAmount !== undefined && fxRate != null
      ? roundToCents(foreignAmount * fxRate)
      : undefined;
  const fxFeeApplies =
    isForeign && convertedBase !== undefined && !!fxFeePercent && fxFeePercent > 0;
  const fxFeeAmount = fxFeeApplies
    ? -roundToCents((Math.abs(convertedBase as number) * (fxFeePercent as number)) / 100)
    : 0;
  const fxTotal =
    convertedBase !== undefined ? roundToCents(convertedBase + fxFeeAmount) : undefined;

  // Derive the account-currency `amount` from the foreign amount and rate,
  // folding in the account's foreign-transaction fee. Matches `recomputeFx` in
  // TransactionForm and `applyFxConversion` on the backend.
  const recomputeFx = (fAmount: number | undefined, rate: number | null) => {
    if (fAmount === undefined || rate == null) return;
    const base = roundToCents(fAmount * rate);
    const fee =
      fxFeePercent && fxFeePercent > 0
        ? -roundToCents((Math.abs(base) * fxFeePercent) / 100)
        : 0;
    setValue('amount', roundToCents(base + fee), {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const handleForeignAmountChange = (value: number | undefined) => {
    const rounded = value === undefined ? undefined : roundToCents(value);
    setForeignAmount(rounded);
    recomputeFx(rounded, fxRate);
  };

  // '' (or the account currency) resets to an ordinary account-currency
  // schedule, clearing the foreign fields.
  const handleEntryCurrencyChange = (code: string) => {
    rateOverriddenRef.current = false;
    if (!code || code.toUpperCase() === accountCurrency.toUpperCase()) {
      setEntryCurrency('');
      setForeignAmount(undefined);
      setFxRate(null);
      return;
    }
    setEntryCurrency(code);
    // Seed the foreign amount from whatever is in the amount field so the
    // conversion has something to show before the user types.
    if (foreignAmount === undefined && watchedAmount) {
      setForeignAmount(watchedAmount);
    }
  };

  // Re-sign the foreign amount when the category changes, so an expense
  // category flips it negative exactly as the account-currency path does.
  const resignForeignAmount = (category: Category) => {
    if (category.effectiveAutoSign === false) return;
    if (foreignAmount === undefined || foreignAmount === 0) return;
    const signed = category.isIncome ? Math.abs(foreignAmount) : -Math.abs(foreignAmount);
    if (signed !== foreignAmount) {
      setForeignAmount(signed);
      recomputeFx(signed, fxRate);
    }
  };

  // Fetch the latest available rate for (entryCurrency -> account currency).
  // `getRateForDate` with today's date carries the most recent stored rate
  // forward over weekends and holidays, which is the right answer for a
  // future-dated schedule -- there is no rate for its due date yet.
  useEffect(() => {
    if (!isForeign || rateOverriddenRef.current) return;
    let cancelled = false;
    setFxRateLoading(true);
    exchangeRatesApi
      .getRateForDate(entryCurrency, accountCurrency, getLocalDateString())
      .then((rate) => {
        if (cancelled) return;
        setFxRate(rate);
        setFxRateLoading(false);
        recomputeFx(foreignAmount, rate);
      })
      .catch(() => {
        if (cancelled) return;
        setFxRate(null);
        setFxRateLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // foreignAmount/recomputeFx are read fresh inside the callback; amount edits
    // recompute synchronously via handleForeignAmountChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isForeign, entryCurrency, accountCurrency]);

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
      accountOptionLabel,
    ),
    [accounts, accountOptionLabel]
  );

  // Investment-mode accounts: only brokerage (share-holding) accounts.
  const investmentAccountOptions = useMemo(() =>
    buildAccountDropdownOptions(
      accounts,
      (a) => !a.isClosed && a.accountSubType === 'INVESTMENT_BROKERAGE',
      accountOptionLabel,
    ),
    [accounts, accountOptionLabel]
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
      accountOptionLabel,
    ),
    [accounts, watchedAccountId, accountOptionLabel]
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
      accountOptionLabel,
    ),
    [accounts, watchedAccountId, accountOptionLabel]
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
  const { tagOptions, tagUsage } = useTagPickerOptions(tags);

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

  // Whether the current action has a Price field the market close can fill. Used
  // as the fetch dependency instead of the raw action so toggling *within* the
  // quantity-price set (BUY <-> SELL <-> REINVEST, same security) does not
  // re-issue the request -- the close is action-independent; only a flip in
  // price-field applicability changes what the fetch should do.
  const isQuantityPriceAction = QUANTITY_PRICE_ACTIONS.includes(baseInvestmentAction(investmentAction));

  // When the chosen security changes, fetch its most recent close price so we
  // can auto-fill the Price field and back-derive quantity from Total Value. Only
  // a quantity-price action has a Price field to fill; amount-only (DIVIDEND ...)
  // and quantity-only (ADD_SHARES ...) actions never use a close, so skip the
  // request for them -- matching the two dialogs, which gate the fetch the same way.
  //
  // Each change of those inputs resets what the last answer left behind, during
  // render (the "info from previous render" pattern) rather than in the effect:
  // no request, no close; and "no price history" is a completed-empty result,
  // not the loading window and not a failed lookup.
  const wantsMarketPrice =
    mode === 'investment' && !!investmentSecurityId && isQuantityPriceAction;
  const priceRequestKey = `${mode}|${investmentSecurityId}|${isQuantityPriceAction}`;
  const [priceRequestFor, setPriceRequestFor] = useState(priceRequestKey);
  if (priceRequestFor !== priceRequestKey) {
    setPriceRequestFor(priceRequestKey);
    if (!wantsMarketPrice) setMarketPrice(null);
    setPriceHistoryEmpty(false);
  }
  useEffect(() => {
    if (mode !== 'investment' || !investmentSecurityId || !isQuantityPriceAction) {
      return;
    }
    let cancelled = false;
    investmentsApi.getSecurityPrices(investmentSecurityId, { limit: 1 })
      .then((prices) => {
        if (cancelled) return;
        const close = usableClose(prices);
        setMarketPrice(close ? close.price : null);
        setPriceHistoryEmpty(close === null);
      })
      .catch((err) => {
        if (cancelled) return;
        setMarketPrice(null);
        // A failed lookup is not an empty dataset -- leave the hint off.
        setPriceHistoryEmpty(false);
        logger.warn?.('Failed to fetch latest price', err);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, investmentSecurityId, isQuantityPriceAction]);

  const investmentSign = baseInvestmentAction(investmentAction) === 'SELL' ? -1 : 1;

  // A close rounded for display (6dp). marketPrice is already null unless it is a
  // usable positive number (usableClose rejects zero/negative/NaN before it is
  // set), so a plain null check is all that is needed here.
  const roundedMarketPrice = marketPrice != null ? roundPrice(marketPrice) : null;

  // The price a keystroke folds against: a typed price, else the market close.
  // Fall back to the *rounded* close (not raw marketPrice) so a derived quantity
  // or total is computed from the same 6dp price the field auto-fills and the
  // placeholder shows -- otherwise a >6dp close would compute against one number
  // and display another.
  const effectiveInvestmentPrice =
    investmentPrice !== '' && Number(investmentPrice) > 0
      ? Number(investmentPrice)
      : roundedMarketPrice ?? 0;

  // If the user hasn't typed a price, auto-fill from the latest market close
  // once it arrives, and reconcile the rest of the triple: an entered Total
  // Value is preserved and the quantity re-derived from it (total-first, the way
  // this form treats a typed total everywhere else), so a close landing after
  // the user typed a budget does not silently change the amount invested.
  // Otherwise fill the total from an entered quantity. Uses the "info from
  // previous render" pattern so we don't violate react-hooks/set-state-in-effect.
  const [lastSeenMarketPrice, setLastSeenMarketPrice] = useState<number | null>(null);
  if (marketPrice !== lastSeenMarketPrice) {
    setLastSeenMarketPrice(marketPrice);
    // Only a quantity-price action has a Price field to fill, and only a usable
    // positive close is worth writing -- both guards match the two dialogs, so a
    // dividend never stores a spurious price and a zero/NaN quote never cascades
    // into the fold.
    if (
      QUANTITY_PRICE_ACTIONS.includes(baseInvestmentAction(investmentAction)) &&
      roundedMarketPrice != null &&
      (investmentPrice === '' || investmentPrice === 0)
    ) {
      setInvestmentPrice(roundedMarketPrice);
      const commission = investmentCommission === '' ? 0 : Number(investmentCommission);
      if (investmentTotalValue !== '') {
        setInvestmentQuantity(
          quantityFromTotal(Number(investmentTotalValue), roundedMarketPrice, investmentSign, commission),
        );
      } else if (investmentQuantity !== '') {
        setInvestmentTotalValue(
          totalFromQuantity(Number(investmentQuantity), roundedMarketPrice, investmentSign, commission),
        );
      }
    }
  }

  const handleTotalValueChange = (raw: number | undefined) => {
    if (raw === undefined) {
      setInvestmentTotalValue('');
      return;
    }
    setInvestmentTotalValue(raw);
    if (effectiveInvestmentPrice > 0) {
      const commission =
        investmentCommission === '' ? 0 : Number(investmentCommission);
      setInvestmentQuantity(
        quantityFromTotal(raw, effectiveInvestmentPrice, investmentSign, commission),
      );
    }
  };

  const handleQuantityChange = (raw: number | undefined) => {
    const qty = raw ?? '';
    setInvestmentQuantity(qty);
    if (qty !== '' && effectiveInvestmentPrice > 0) {
      const commission =
        investmentCommission === '' ? 0 : Number(investmentCommission);
      setInvestmentTotalValue(
        totalFromQuantity(Number(qty), effectiveInvestmentPrice, investmentSign, commission),
      );
    }
  };

  const handlePriceChange = (raw: number | undefined) => {
    const price = raw ?? '';
    setInvestmentPrice(price);
    if (price !== '' && Number(price) > 0) {
      const commission =
        investmentCommission === '' ? 0 : Number(investmentCommission);
      // If the user has a total in mind, keep it and re-derive quantity. Otherwise
      // re-derive total from quantity * price.
      if (investmentTotalValue !== '') {
        setInvestmentQuantity(
          quantityFromTotal(Number(investmentTotalValue), Number(price), investmentSign, commission),
        );
      } else if (investmentQuantity !== '') {
        setInvestmentTotalValue(
          totalFromQuantity(Number(investmentQuantity), Number(price), investmentSign, commission),
        );
      }
    }
  };

  // The commission folds into the displayed Total Value and submit persists from
  // the same formula, so a fee change has to move the shown total too -- otherwise
  // the user confirms one cash figure while the saved schedule uses another.
  const handleCommissionChange = (raw: number | undefined) => {
    const commission = raw ?? '';
    setInvestmentCommission(commission);
    if (investmentQuantity !== '' && effectiveInvestmentPrice > 0) {
      setInvestmentTotalValue(
        totalFromQuantity(
          Number(investmentQuantity),
          effectiveInvestmentPrice,
          investmentSign,
          commission === '' ? 0 : Number(commission),
        ),
      );
    }
  };

  // A BUY folds the commission in with a +sign, a SELL with a -sign, so flipping
  // the action changes the total even when quantity, price and fee are untouched.
  // Recompute the shown total with the new sign so it agrees with what submit
  // will persist.
  const handleInvestmentActionChange = (nextAction: InvestmentAction) => {
    setInvestmentAction(nextAction);
    // Clear fields the new action's UI does not show, so a hidden stale value is
    // not submitted: a security carried into INTEREST would settle the cash in
    // the security's currency, and a funding account carried out of BUY/SELL
    // would misroute it (issue #1154 review).
    if (!SECURITY_REQUIRED_ACTIONS.includes(nextAction)) {
      setInvestmentSecurityId('');
    }
    if (!FUNDING_ACCOUNT_ACTIONS.includes(nextAction)) {
      setInvestmentFundingAccountId('');
    }
    if (
      QUANTITY_PRICE_ACTIONS.includes(baseInvestmentAction(nextAction)) &&
      investmentQuantity !== '' &&
      effectiveInvestmentPrice > 0
    ) {
      const nextSign = baseInvestmentAction(nextAction) === 'SELL' ? -1 : 1;
      const commission =
        investmentCommission === '' ? 0 : Number(investmentCommission);
      setInvestmentTotalValue(
        totalFromQuantity(Number(investmentQuantity), effectiveInvestmentPrice, nextSign, commission),
      );
    }
  };

  // The auto-filled price belonged to the previously selected security. Clear it
  // (and the seen-market-price latch) on a security change so the newly chosen
  // security's close fills the field, rather than the old quote lingering because
  // the field is non-empty and the auto-fill only writes into an empty one.
  //
  // Clear the Total Value too, and keep the quantity: the total was derived from
  // the *previous* security's price, so it is not a budget to preserve. Leaving
  // it makes the new security's total-first auto-fill rescale the share count the
  // user entered (10 shares silently becoming 4 to hold a stale $ total). With
  // the total cleared the auto-fill falls to its quantity branch and recomputes
  // the total from the shares at the new price.
  const handleInvestmentSecurityChange = (securityId: string) => {
    setInvestmentSecurityId(securityId);
    setInvestmentPrice('');
    setInvestmentTotalValue('');
    setMarketPrice(null);
    setLastSeenMarketPrice(null);
    // Clear the previous security's "no history" verdict too, or it would flash
    // the hint against the newly chosen security until the new fetch resolves.
    setPriceHistoryEmpty(false);
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
        setAccounts(accountsData.filter((account) => !account.managedPurpose));
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

          // Adjust amount sign based on default category type. While entering a
          // foreign currency the typed amount is the foreign one -- re-sign that
          // and let the conversion re-derive the account-currency amount.
          const category = categories.find((c) => c.id === payee.defaultCategoryId);
          if (category && isForeign) {
            resignForeignAmount(category);
          } else if (category && watchedAmount !== undefined && watchedAmount !== 0) {
            const absAmount = Math.abs(watchedAmount);
            // Automatic sign off for this category: keep the typed sign.
            const newAmount = category.effectiveAutoSign !== false
              ? (category.isIncome ? absAmount : -absAmount)
              : watchedAmount;
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
      if (mode !== 'transfer' && category && isForeign) {
        // The typed amount is the foreign one; re-sign it and let the
        // conversion re-derive the account-currency amount.
        resignForeignAmount(category);
      } else if (mode !== 'transfer' && category && watchedAmount !== undefined && watchedAmount !== 0) {
        const absAmount = Math.abs(watchedAmount);
        // Automatic sign off for this category: keep the typed sign.
        const newAmount = category.effectiveAutoSign !== false
          ? (category.isIncome ? absAmount : -absAmount)
          : watchedAmount;
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

  // Create a category from text typed into any of this form's category pickers
  // -- the Category field, and each split line's own picker. Returns the
  // created category so a split line can assign it to the row that asked; null
  // means nothing was created (blank input, or the request failed).
  const createCategoryFromTypedName = async (name: string): Promise<Category | null> => {
    try {
      const result = await createCategoryFromInput(name, categories);
      if (!result) return null;
      setCategories((prev) => [...prev, ...result.created]);
      toast.success(t('form.toasts.categoryCreated', { name: result.displayName }));
      return result.category;
    } catch (error) {
      logger.error('Failed to create category:', error);
      toast.error(getErrorMessage(error, t('form.toasts.categoryCreateFailed')));
      return null;
    }
  };

  const handleCategoryCreate = async (name: string) => {
    const newCategory = await createCategoryFromTypedName(name);
    if (!newCategory) return;
    setSelectedCategoryId(newCategory.id);
    setValue('categoryId', newCategory.id, { shouldDirty: true, shouldValidate: true });
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
    // A foreign entry without a rate would save whatever happens to be in the
    // account-currency amount field -- refuse rather than guess.
    if (isForeign && (fxRate == null || foreignAmount === undefined)) {
      toast.error(t('form.toasts.fxRateRequired'));
      return;
    }

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
      if (SECURITY_REQUIRED_ACTIONS.includes(baseInvestmentAction(investmentAction)) && !investmentSecurityId) {
        toast.error(t('form.toasts.securityRequired'));
        return;
      }
      if (QUANTITY_PRICE_ACTIONS.includes(baseInvestmentAction(investmentAction))) {
        if (!investmentQuantity || Number(investmentQuantity) <= 0) {
          toast.error(t('form.toasts.quantityRequired'));
          return;
        }
        if (!investmentPrice || Number(investmentPrice) <= 0) {
          toast.error(t('form.toasts.priceRequired'));
          return;
        }
      } else if (QUANTITY_ONLY_ACTIONS.includes(baseInvestmentAction(investmentAction))) {
        if (!investmentQuantity || Number(investmentQuantity) <= 0) {
          toast.error(t('form.toasts.quantityRequired'));
          return;
        }
      } else if (AMOUNT_ONLY_ACTIONS.includes(baseInvestmentAction(investmentAction))) {
        if (
          investmentTotalAmount === '' ||
          investmentTotalAmount === undefined ||
          Number(investmentTotalAmount) <= 0
        ) {
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
          splits: toCreateSplitData(splits, { includeSourceIdentity: true }),
        };
      } else if (mode === 'investment') {
        // Estimate display amount from quantity*price (or totalAmount).
        const estQty = investmentQuantity === '' ? 0 : Number(investmentQuantity);
        const estPrice = investmentPrice === '' ? 0 : Number(investmentPrice);
        const estTotal = investmentTotalAmount === '' ? 0 : Number(investmentTotalAmount);
        const estCommission = investmentCommission === '' ? 0 : Number(investmentCommission);
        let displayAmount = formData.amount;
        if (QUANTITY_PRICE_ACTIONS.includes(baseInvestmentAction(investmentAction))) {
          const sign = baseInvestmentAction(investmentAction) === 'SELL' ? 1 : -1;
          displayAmount = sign * (estQty * estPrice + (sign === -1 ? estCommission : -estCommission));
        } else if (AMOUNT_ONLY_ACTIONS.includes(baseInvestmentAction(investmentAction))) {
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
          // For an action whose UI has no security field, omit the key rather
          // than sending null. The backend clears a hidden security on the
          // action transition (BUY -> INTEREST with the key omitted), so a
          // fresh switch is still cleaned -- but a deliberately-stored
          // security-specific INTEREST survives a later presentation-only edit
          // instead of being destroyed by every save (issue #1154 re-review).
          // Both membership checks are base-normalized so the Money-vocabulary
          // refinements (REDEEM, CAPITAL_GAIN_SHORT/LONG, REINVEST_*) behave
          // exactly as their base action (issue #1149).
          investmentSecurityId: SECURITY_REQUIRED_ACTIONS.includes(baseInvestmentAction(investmentAction))
            ? investmentSecurityId || undefined
            : undefined,
          // Send an explicit null (not undefined) when the action does not use a
          // funding account, so editing an existing schedule away from BUY/SELL
          // clears the stored account. Omitting the key would leave the stale
          // value in place and misroute the posted cash (issue #1154).
          investmentFundingAccountId: FUNDING_ACCOUNT_ACTIONS.includes(baseInvestmentAction(investmentAction)) && investmentFundingAccountId
            ? investmentFundingAccountId
            : null,
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
          // Foreign-currency entry: send the trio, or explicit nulls when the
          // schedule used to carry one and the user switched back to the
          // account currency (undefined would leave the old values in place).
          ...(isForeign && foreignAmount !== undefined && fxRate != null
            ? {
                originalAmount: foreignAmount,
                originalCurrencyCode: entryCurrency,
                exchangeRate: fxRate,
              }
            : scheduledTransaction?.originalCurrencyCode
              ? { originalAmount: null, originalCurrencyCode: null, exchangeRate: 1 }
              : {}),
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

  const frequencyOptions = FREQUENCY_VALUES.map((value) => ({
    value,
    label: t(`frequency.${value}`),
  }));

  // Conversion caption under the Amount field while entering another currency.
  // It says what the account will be charged today and at what rate, and is
  // explicit that this is an estimate: the schedule is future-dated, so the
  // figure tracks the market daily and the rate on the posting date is what
  // ends up on the transaction.
  const renderFxCaption = () => (
    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
      {fxRate != null && fxTotal !== undefined ? (
        <span>
          {t('form.fx.estimateCaption', {
            total: formatCurrency(fxTotal, accountCurrency),
            from: entryCurrency,
            rate: formatNumber(fxRate, FX_RATE_DISPLAY_DECIMALS),
            to: accountCurrency,
          })}
        </span>
      ) : !fxRateLoading ? (
        <span className="text-amber-600 dark:text-amber-400">
          {t('form.fx.noRateWarning', { from: entryCurrency, to: accountCurrency })}
        </span>
      ) : null}
      {fxFeeApplies && (
        <span>
          {' '}
          {t('form.fx.feeCaption', {
            percent: formatNumber(fxFeePercent as number, 2),
            fee: formatCurrency(Math.abs(fxFeeAmount), accountCurrency),
          })}
        </span>
      )}
    </p>
  );

  // Shared End Condition section
  const renderEndCondition = (_idSuffix: string) => {
    if (watchedFrequency === 'ONCE') return null;
    return (
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('form.endConditionTitle')}
        </h3>
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
              <Controller
                name="occurrencesRemaining"
                control={control}
                render={({ field }) => (
                  <NumericInput
                    decimalPlaces={0}
                    min={1}
                    placeholder={t('form.occurrencesPlaceholder')}
                    error={errors.occurrencesRemaining?.message}
                    value={field.value}
                    onChange={field.onChange}
                    name={field.name}
                    onBlur={field.onBlur}
                    ref={field.ref}
                  />
                )}
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
          checked={!!watchedIsActive}
          onChange={(next) => setValue('isActive', next, { shouldDirty: true })}
          label={t('form.activeLabel')}
        />
        <span className="block text-sm text-gray-900 dark:text-gray-100">
          {t('form.activeLabel')}
        </span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <ToggleSwitch
          checked={!!watchedAutoPost}
          onChange={(next) => setValue('autoPost', next, { shouldDirty: true })}
          label={t('form.autoPostLabel')}
        />
        <span className="block text-sm text-gray-900 dark:text-gray-100">
          {t('form.autoPostLabel')}
        </span>
      </label>
    </div>
  );

  // Shared footer: Active/Auto-post toggles and the Cancel/Submit buttons share
  // one row (toggles left, actions right), stacking on narrow screens.
  const renderFooter = (idSuffix: string) => (
    <div className="flex flex-col gap-4 pt-4 sm:flex-row sm:items-center sm:justify-between">
      {renderOptions(idSuffix)}
      <FormActions
        onCancel={onCancel}
        submitLabel={scheduledTransaction ? t('form.submitUpdate') : t('form.submitCreate')}
        isSubmitting={isLoading}
        className="pt-0"
      />
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
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {t('form.descriptionLabel')}
      </label>
      <textarea
        rows={2}
        maxLength={TRANSACTION_NOTE_MAX_LENGTH}
        className="block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:ring-blue-500"
        {...register('description')}
      />
      {errors.description && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">
          {errors.description.message}
        </p>
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

      {/* Row 1: Name */}
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
              valueIsId
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
                    valueIsId
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
            <div>
              {/* items-stretch + min-w-0, the same row NormalTransactionFields
                  and SplitTransactionFields use, so the picker button is the
                  height of the Amount input beside it. */}
              <div className="flex items-stretch space-x-2">
                <CurrencyPickerButton
                  value={entryCurrency}
                  accountCurrencyCode={accountCurrency}
                  onChange={handleEntryCurrencyChange}
                  disabled={isLoading}
                />
                <div className="flex-1 min-w-0">
                  <CurrencyInput
                    label={
                      isForeign
                        ? t('form.fx.amountInCurrency', { currency: entryCurrency })
                        : t('form.amountLabel')
                    }
                    prefix={getCurrencySymbol(isForeign ? entryCurrency : accountCurrency)}
                    value={isForeign ? foreignAmount : watchedAmount}
                    onChange={
                      isForeign
                        ? handleForeignAmountChange
                        : (value) => setValue('amount', value ?? 0, { shouldValidate: true })
                    }
                    allowSignToggle
                    error={errors.amount?.message}
                  />
                </div>
              </div>
              {isForeign && renderFxCaption()}
            </div>
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
            <Controller
              name="reminderDaysBefore"
              control={control}
              render={({ field }) => (
                <NumericInput
                  label={t('form.remindDaysBeforeLabel')}
                  decimalPlaces={0}
                  min={0}
                  max={MAX_REMINDER_DAYS_BEFORE}
                  error={errors.reminderDaysBefore?.message}
                  value={field.value}
                  onChange={field.onChange}
                  name={field.name}
                  onBlur={field.onBlur}
                  ref={field.ref}
                />
              )}
            />
          </div>

          {/* Tags */}
          {renderTags()}

          {/* Row 6: End Condition */}
          {renderEndCondition('Tx')}

          {/* Row 7: Description */}
          {renderDescription()}

          {/* Row 8: Active/Auto-post and actions */}
          {renderFooter('Tx')}
        </div>
      )}

      {/* Row 1: Name */}
      {mode === 'split' && (
        <div className="space-y-4">
          {/* Row 2: Account, Next Due Date */}
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
              valueIsId
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
              maxLength={TRANSACTION_NOTE_MAX_LENGTH}
              error={errors.description?.message}
              {...register('description')}
            />
          </div>

          {/* Row 5: Split Editor */}
          <div className="border-t dark:border-gray-700 pt-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {t('form.splitTransactionTitle')}
              </h3>
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
              tagUsage={tagUsage}
              accounts={accounts}
              sourceAccountId={watchedAccountId || ''}
              parentAccountSubType={
                accounts.find((a) => a.id === watchedAccountId)?.accountSubType ?? null
              }
              transactionAmount={watchedAmount || 0}
              onTransactionAmountChange={handleTransactionAmountChange}
              currencyCode={watchedCurrencyCode || defaultCurrency}
              onConvertToRegular={handleConvertToRegular}
              onCreateCategory={createCategoryFromTypedName}
              transactionDate={watchedNextDueDate}
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
            <Controller
              name="reminderDaysBefore"
              control={control}
              render={({ field }) => (
                <NumericInput
                  label={t('form.remindDaysBeforeLabel')}
                  decimalPlaces={0}
                  min={0}
                  max={MAX_REMINDER_DAYS_BEFORE}
                  error={errors.reminderDaysBefore?.message}
                  value={field.value}
                  onChange={field.onChange}
                  name={field.name}
                  onBlur={field.onBlur}
                  ref={field.ref}
                />
              )}
            />
          </div>

          {/* ==================== Transfer Tab ==================== */}
          {renderEndCondition('Split')}

          {/* Row 1: Name */}
          {renderFooter('Split')}
        </div>
      )}

      {/* Row 1: Name */}
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
              valueIsId
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
                valueIsId
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
            <Controller
              name="reminderDaysBefore"
              control={control}
              render={({ field }) => (
                <NumericInput
                  label={t('form.remindDaysBeforeLabel')}
                  decimalPlaces={0}
                  min={0}
                  max={MAX_REMINDER_DAYS_BEFORE}
                  error={errors.reminderDaysBefore?.message}
                  value={field.value}
                  onChange={field.onChange}
                  name={field.name}
                  onBlur={field.onBlur}
                  ref={field.ref}
                />
              )}
            />
          </div>

          {/* Tags */}
          {renderTags()}

          {/* Row 7: End Condition */}
          {renderEndCondition('Transfer')}

          {/* Row 8: Description */}
          {renderDescription()}

          {/* Row 9: Active/Auto-post and actions */}
          {renderFooter('Transfer')}
        </div>
      )}

      {/* Row 1: Name */}
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

          {/* Row 2: Account, Next Due Date */}
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
            <DateInput
              label={t('form.nextDueDateLabel')}
              error={errors.nextDueDate?.message}
              onDateChange={(date) => setValue('nextDueDate', date, { shouldDirty: true, shouldValidate: true })}
              {...register('nextDueDate')}
            />
          </div>

          {/* Row 3: Action, Security (Security when required) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.actionLabel')}
              value={investmentAction}
              onChange={(e) => handleInvestmentActionChange(e.target.value as InvestmentAction)}
              options={SCHEDULABLE_INVESTMENT_ACTIONS.map(a => ({
                value: a,
                label: t(`form.investmentActionLabels.${a}` as Parameters<typeof t>[0]),
              }))}
            />
            {SECURITY_REQUIRED_ACTIONS.includes(baseInvestmentAction(investmentAction)) && (
              <Select
                label={t('form.securityLabel')}
                value={investmentSecurityId}
                onChange={(e) => handleInvestmentSecurityChange(e.target.value)}
                options={[
                  { value: '', label: t('form.securityPlaceholder') },
                  ...securityOptions,
                ]}
              />
            )}
          </div>

          {/* Row 4: Quantity / Price / Commission (action-conditional) */}
          {QUANTITY_PRICE_ACTIONS.includes(baseInvestmentAction(investmentAction)) && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <NumericInput
                  label={t('form.quantityLabel')}
                  decimalPlaces={8}
                  min={0}
                  value={investmentQuantity === '' ? undefined : investmentQuantity}
                  onChange={handleQuantityChange}
                />
                <NumericInput
                  label={t('form.pricePerShareLabel')}
                  decimalPlaces={6}
                  min={0}
                  placeholder={
                    roundedMarketPrice != null
                      ? t('form.latestPlaceholder', { price: formatPrice(roundedMarketPrice) })
                      : undefined
                  }
                  value={investmentPrice === '' ? undefined : investmentPrice}
                  onChange={handlePriceChange}
                />
                <NumericInput
                  label={t('form.commissionLabel')}
                  decimalPlaces={4}
                  min={0}
                  value={investmentCommission === '' ? undefined : investmentCommission}
                  onChange={handleCommissionChange}
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
                {FUNDING_ACCOUNT_ACTIONS.includes(baseInvestmentAction(investmentAction)) && (
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
              </div>
              {investmentSecurityId && priceHistoryEmpty && investmentPrice === '' && (
                <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                  {t('form.noPriceHistory')}
                </p>
              )}
            </>
          )}

          {QUANTITY_ONLY_ACTIONS.includes(baseInvestmentAction(investmentAction)) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <NumericInput
                label={t('form.quantityLabel')}
                decimalPlaces={8}
                min={0}
                value={investmentQuantity === '' ? undefined : investmentQuantity}
                onChange={(value) => setInvestmentQuantity(value ?? '')}
              />
            </div>
          )}

          {AMOUNT_ONLY_ACTIONS.includes(baseInvestmentAction(investmentAction)) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <CurrencyInput
                label={t('form.totalAmountLabel')}
                prefix={currencySymbol}
                value={typeof investmentTotalAmount === 'number' ? investmentTotalAmount : undefined}
                onChange={(value) => setInvestmentTotalAmount(value ?? '')}
                allowNegative={false}
              />
            </div>
          )}

          {/* Row 4: Frequency, Remind Days Before */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Select
              label={t('form.frequencyLabel')}
              error={errors.frequency?.message}
              value={watchedFrequency || 'MONTHLY'}
              options={frequencyOptions}
              {...register('frequency')}
            />
            <Controller
              name="reminderDaysBefore"
              control={control}
              render={({ field }) => (
                <NumericInput
                  label={t('form.remindDaysBeforeLabel')}
                  decimalPlaces={0}
                  min={0}
                  max={MAX_REMINDER_DAYS_BEFORE}
                  error={errors.reminderDaysBefore?.message}
                  value={field.value}
                  onChange={field.onChange}
                  name={field.name}
                  onBlur={field.onBlur}
                  ref={field.ref}
                />
              )}
            />
          </div>

          {/* Tags */}
          {renderTags()}

          {/* End condition */}
          {renderEndCondition('Inv')}

          {/* Description */}
          {renderDescription()}

          {/* Active / Auto-post and actions */}
          {renderFooter('Inv')}
        </div>
      )}
    </form>
  );
}
