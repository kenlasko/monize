'use client';

import { useState, useEffect, useMemo, useCallback, useRef, MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import { useForm, useWatch, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { SecurityForm } from '@/components/securities/SecurityForm';
import {
  BOND_SERIES_ERROR_CODES,
  BondSeriesSelect,
  bondSeriesKind,
  useBondSeriesOptions,
} from './BondSeriesSelect';
import { BondRedemptionInfo } from './BondRedemptionInfo';
import {
  redemptionRequestKey,
  useBondRedemptionSplit,
  type RedemptionSplitRequest,
} from './useBondRedemptionSplit';
import { investmentsApi } from '@/lib/investments';
import {
  LAST_INVESTMENT_TRANSACTION_DATE_KEY,
  getRememberedTransactionDate,
  rememberTransactionDate,
} from '@/lib/lastTransactionDate';
import { Account } from '@/types/account';
import { TransactionStatus } from '@/types/transaction';
import {
  InvestmentAction,
  InvestmentTransaction,
  Security,
  CreateSecurityData,
  Holding,
} from '@/types/investment';
import {
  getCurrencySymbol,
  roundToDecimals,
  roundFxRate,
  FX_RATE_DISPLAY_DECIMALS,
} from '@/lib/format';
import { getErrorCode, getErrorMessage } from '@/lib/errors';
import {
  baseInvestmentAction,
  redemptionTotalWithInterest,
  supportsAccruedInterest,
} from '@/lib/investment-actions';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { useDateFormat } from '@/hooks/useDateFormat';
import { createLogger } from '@/lib/logger';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import {
  INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY,
  useTransactionSubmitMode,
} from '@/hooks/useTransactionSubmitMode';
import { TRANSACTION_NOTE_MAX_LENGTH } from '@/lib/transaction-note';

const logger = createLogger('InvestmentTxForm');

/**
 * Exported for its own spec. `InvestmentTransactionForm.test.tsx` mocks
 * `zodResolver` away, so nothing in that file exercises a single rule in here;
 * the schema is tested directly instead of through a form that cannot see it.
 */
export const buildInvestmentTransactionSchema = (t: (key: string) => string) => z.object({
  accountId: z.string().min(1, t('validation.accountRequired')),
  // 'TRANSFER' is a UI-only action that creates a TRANSFER_OUT + TRANSFER_IN
  // pair on the backend; it is offered only when creating, not editing.
  action: z.enum([
    'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'SPLIT',
    'TRANSFER_IN', 'TRANSFER_OUT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES',
    'REINVEST_INTEREST', 'REINVEST_CAPITAL_GAIN_SHORT', 'REINVEST_CAPITAL_GAIN_LONG',
    'CAPITAL_GAIN_SHORT', 'CAPITAL_GAIN_LONG', 'REDEEM', 'RETURN_OF_CAPITAL',
    'TRANSFER',
  ]),
  transactionDate: z.string().min(1, t('validation.dateRequired')),
  securityId: z.string().optional(),
  // The bond series of a share-moving row of a program-linked security.
  // Undefined is "not chosen" (an acquisition is prefilled from the date); ''
  // is the reader's "determine it" / "oldest first".
  bondInstrumentId: z.string().optional(),
  fundingAccountId: z.string().optional(),
  // Destination account for a TRANSFER (the source is `accountId`).
  destinationAccountId: z.string().optional(),
  quantity: z.coerce.number().min(0).optional(),
  price: z.coerce.number().min(0).optional(),
  commission: z.coerce.number().min(0).optional(),
  accruedInterest: z.coerce.number().min(0).optional(),
  exchangeRate: z.coerce.number().gt(0).optional(),
  description: z.string().optional(),
  status: z.nativeEnum(TransactionStatus).default(TransactionStatus.UNRECONCILED),
  // SPLIT-only fields, combined into `quantity` (the ratio) on submit.
  splitNewShares: z.coerce.number().gt(0).optional(),
  splitOldShares: z.coerce.number().gt(0).optional(),
}).superRefine((data, ctx) => {
  // An acquisition states what it cost. The backend refuses a BUY or REINVEST
  // priced at zero or left blank on every path that writes one -- a zero-cost
  // purchase is not a concept this application has, and shares that arrived
  // without a cost are ADD_SHARES -- so the field says so here rather than
  // letting the save go out and come back as a generic 400 toast. `price` is
  // shared with actions that legitimately allow zero (a SPLIT's optional new
  // price, the amount-only actions that borrow the field), so the rule is keyed
  // on the action instead of tightened on the field.
  const base = data.action === 'TRANSFER' ? 'TRANSFER' : baseInvestmentAction(data.action);
  if (base !== 'BUY' && base !== 'REINVEST') return;
  if (data.price !== undefined && data.price > 0) return;
  ctx.addIssue({
    code: 'custom',
    path: ['price'],
    message: t('validation.acquisitionPriceRequired'),
  });
});

type InvestmentTransactionFormData = z.infer<ReturnType<typeof buildInvestmentTransactionSchema>>;

interface InvestmentTransactionFormProps {
  accounts: Account[];
  allAccounts?: Account[];  // All accounts for funding dropdown (if not provided, uses accounts)
  transaction?: InvestmentTransaction;
  defaultAccountId?: string;
  /**
   * The day a new trade is filed under, `YYYY-MM-DD`.
   *
   * Read only in create mode, and only when set: the calendar's "New investment
   * transaction on this day" means the day the reader clicked, which is not the
   * date the last entry was filed under. An edit keeps the row's own date, and a
   * form opened anywhere else keeps the remembered one.
   */
  defaultDate?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onConversionStateChange?: (needsConversion: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
  /**
   * Called after a successful create when the user chose "Create & New": the
   * form has already reset itself for the next entry, so the host keeps the
   * modal open and uses this only to refresh whatever it shows behind. Leave it
   * off and the submit button offers no such option.
   */
  onCreateAndNew?: () => void;
}

interface InvestmentTransactionFormFieldsProps
  extends InvestmentTransactionFormProps {
  /** Set by the wrapper below; carries the account the entry was filed against. */
  onCreateAnother?: (accountId: string) => void;
}

// Actions that require a security selection. Transfers (the combined create
// action and the TRANSFER_IN/TRANSFER_OUT edit legs) render their own security
// + quantity + cost fields via `transferMode`, so they're excluded here.
// Every list below is written over base actions and consulted through
// `actionIn`, so a Money-vocabulary refinement (REDEEM, CAPITAL_GAIN_SHORT/
// LONG, REINVEST_*) behaves exactly as its base without each list restating
// the whole family.
const actionIn = (action: InvestmentAction, list: InvestmentAction[]): boolean =>
  list.includes(baseInvestmentAction(action));

const securityRequiredActions: InvestmentAction[] = ['BUY', 'SELL', 'DIVIDEND', 'CAPITAL_GAIN', 'RETURN_OF_CAPITAL', 'SPLIT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES'];

// Actions that require quantity and price
const quantityPriceActions: InvestmentAction[] = ['BUY', 'SELL', 'REINVEST'];

// Actions that only need quantity (no price, no cash effect)
const quantityOnlyActions: InvestmentAction[] = ['ADD_SHARES', 'REMOVE_SHARES'];

// Actions that only need an amount (no quantity/price)
const amountOnlyActions: InvestmentAction[] = ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'RETURN_OF_CAPITAL'];

// Actions that can have an external funding account (where funds come from/go to)
const fundingAccountActions: InvestmentAction[] = ['BUY', 'SELL'];

// Actions that deposit cash into an account and can target a destination cash
// account other than the brokerage's linked cash account (e.g. a dividend paid
// directly into a chequing account).
const cashDestinationActions: InvestmentAction[] = ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'RETURN_OF_CAPITAL'];

// Actions that post a cash transaction against the cash/funding account.
// Only these need exchange rate handling when security and cash currencies differ.
const cashPostingActions: InvestmentAction[] = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'INTEREST',
  'CAPITAL_GAIN',
  'RETURN_OF_CAPITAL',
];

/**
 * Decide what to pre-fill the SPLIT form's "new shares" field with for an
 * already-stored transaction. We deliberately avoid showing a ratio when
 * the stored quantity looks like noise from an older buggy import (e.g. a
 * raw Quicken-tenths value such as 5, 10, 20, 30) so the form never
 * "assumes" a split for the user. Recognised user-friendly ratios -- a
 * positive non-integer (1.5, 0.5, 0.333...) or a small forward integer
 * (2/3/4) -- are treated as intentional and re-displayed as-is.
 */
function deriveSplitNewSharesDefault(
  storedQuantity: number | null | undefined,
): number | undefined {
  if (storedQuantity === null || storedQuantity === undefined) return undefined;
  const q = Number(storedQuantity);
  if (!Number.isFinite(q) || q <= 0) return undefined;
  if (!Number.isInteger(q)) return q; // e.g. 1.5, 0.5
  if (q === 2 || q === 3 || q === 4) return q;
  return undefined;
}

function deriveSplitOldSharesDefault(
  storedQuantity: number | null | undefined,
): number | undefined {
  return deriveSplitNewSharesDefault(storedQuantity) === undefined ? undefined : 1;
}

function InvestmentTransactionFormFields({
  accounts,
  allAccounts,
  transaction,
  defaultAccountId,
  defaultDate,
  onSuccess,
  onCancel,
  onDirtyChange,
  onConversionStateChange,
  submitRef,
  onCreateAnother,
}: InvestmentTransactionFormFieldsProps) {
  const t = useTranslations('investments');
  // Status strings are shared with the cash register's form.
  const tStatus = useTranslations('transactions');
  // Embedded inside a split transaction: the parent owns account, date and
  // status; the backend refuses direct changes to them.
  const isEmbedded = !!transaction?.transactionSplitId;
  const actionLabels: Record<InvestmentAction, string> = {
    BUY: t('transactionForm.actionBuy'),
    SELL: t('transactionForm.actionSell'),
    DIVIDEND: t('transactionForm.actionDividend'),
    INTEREST: t('transactionForm.actionInterest'),
    CAPITAL_GAIN: t('transactionForm.actionCapitalGain'),
    SPLIT: t('transactionForm.actionSplit'),
    TRANSFER_IN: t('transactionForm.actionTransferIn'),
    TRANSFER_OUT: t('transactionForm.actionTransferOut'),
    REINVEST: t('transactionForm.actionReinvest'),
    ADD_SHARES: t('transactionForm.actionAddShares'),
    REMOVE_SHARES: t('transactionForm.actionRemoveShares'),
    REINVEST_INTEREST: t('transactionForm.actionReinvestInterest'),
    REINVEST_CAPITAL_GAIN_SHORT: t('transactionForm.actionReinvestCapitalGainShort'),
    REINVEST_CAPITAL_GAIN_LONG: t('transactionForm.actionReinvestCapitalGainLong'),
    CAPITAL_GAIN_SHORT: t('transactionForm.actionCapitalGainShort'),
    CAPITAL_GAIN_LONG: t('transactionForm.actionCapitalGainLong'),
    REDEEM: t('transactionForm.actionRedeem'),
    RETURN_OF_CAPITAL: t('transactionForm.actionReturnOfCapital'),
  };
  const { defaultCurrency, formatCurrency, formatShareQuantity, formatPrice } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [isLoading, setIsLoading] = useState(false);
  // What the submit button does once a *new* transaction has been created.
  // Kept under its own key: entering a batch of trades and entering a batch of
  // everyday transactions are different habits.
  const [submitMode, setSubmitMode] = useTransactionSubmitMode(
    INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY,
  );
  const canCreateAnother = !transaction && !!onCreateAnother;
  const [securities, setSecurities] = useState<Security[]>([]);
  const [securitiesLoaded, setSecuritiesLoaded] = useState(false);
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  // The server's refusal about the bond series, said under the series select.
  const [bondSeriesError, setBondSeriesError] = useState<string | null>(null);
  // Holding state replayed up to the SPLIT's transaction date, used for the
  // "Before" line in the holding preview. Null means "no holding history at
  // that date" (don't render the preview).
  const [splitHoldingAt, setSplitHoldingAt] = useState<{
    quantity: number;
    averageCost: number;
  } | null>(null);
  // Current holdings in the TRANSFER source account. Drives the security
  // dropdown (only securities actually held can be transferred) and the
  // cost-per-share prefill + available-quantity check.
  const [transferSourceHoldings, setTransferSourceHoldings] = useState<
    Holding[]
  >([]);
  // When editing a transfer leg, the paired (linked) leg -- so the form can
  // show and edit both the source and destination accounts.
  const [transferLinkedLeg, setTransferLinkedLeg] =
    useState<InvestmentTransaction | null>(null);

  // Filter to only show brokerage accounts (sorted)
  const brokerageAccounts = useMemo(
    () => accounts
      .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [accounts]
  );

  // All accounts that can be used as funding source/destination (sorted)
  // Excludes brokerage accounts, cash accounts, and asset accounts
  const fundingAccounts = useMemo(
    () => [...(allAccounts || accounts)]
      .filter((a) =>
        a.accountSubType !== 'INVESTMENT_BROKERAGE' &&
        a.accountType !== 'CASH' &&
        a.accountType !== 'ASSET'
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
    [allAccounts, accounts]
  );

  // Accounts that can receive cash deposits (dividend, interest, capital gain)
  const cashDestinationAccountsList = useMemo(
    () => [...(allAccounts || accounts)]
      .filter((a) =>
        a.accountType === 'CHEQUING' ||
        a.accountType === 'SAVINGS' ||
        a.accountType === 'CASH' ||
        a.accountSubType === 'INVESTMENT_CASH'
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
    [allAccounts, accounts]
  );

  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    formState: { errors, isDirty },
  } = useForm<InvestmentTransactionFormData>({
    resolver: zodResolver(buildInvestmentTransactionSchema(t)) as Resolver<InvestmentTransactionFormData>,
    defaultValues: transaction
      ? {
          accountId: transaction.accountId,
          action: transaction.action,
          transactionDate: transaction.transactionDate,
          securityId: transaction.securityId || transaction.security?.id || '',
          bondInstrumentId: transaction.bondInstrumentId ?? '',
          fundingAccountId: transaction.fundingAccountId || '',
          // The destination account for a transfer leg is resolved from the
          // paired (linked) leg once it loads; start empty so the field is
          // known to react-hook-form from the first render.
          destinationAccountId: '',
          quantity: transaction.quantity ?? 0,
          // For amount-only actions, use totalAmount as the price field value
          price: actionIn(transaction.action, amountOnlyActions)
            ? (transaction.totalAmount ?? 0)
            : (transaction.price ?? 0),
          commission: transaction.commission ?? 0,
          accruedInterest: transaction.accruedInterest ?? 0,
          exchangeRate: transaction.exchangeRate ?? 1,
          description: transaction.description || '',
          // Rows from a backend that predates the column have no status;
          // absent means "no information", shown as the default.
          status: transaction.status || TransactionStatus.UNRECONCILED,
          // For SPLIT, only pre-fill the new/old shares from a stored ratio
          // when the ratio looks like a value the user (or the current QIF
          // parser) actually entered: a positive non-integer or one of a
          // small set of plausible integer ratios (2, 3, 4). Anything else
          // (zero, null, or a suspicious integer like 5/10/20 -- common
          // residue from older buggy split imports) is left blank so the
          // user has to fill it in explicitly. We never assume a default.
          splitNewShares:
            transaction.action === 'SPLIT'
              ? deriveSplitNewSharesDefault(transaction.quantity)
              : undefined,
          splitOldShares:
            transaction.action === 'SPLIT'
              ? deriveSplitOldSharesDefault(transaction.quantity)
              : undefined,
        }
      : {
          accountId: defaultAccountId || '',
          action: 'BUY',
          transactionDate:
            defaultDate ||
            getRememberedTransactionDate(LAST_INVESTMENT_TRANSACTION_DATE_KEY),
          fundingAccountId: '',
          destinationAccountId: '',
          quantity: undefined,
          price: undefined,
          commission: undefined,
          exchangeRate: undefined,
          description: '',
          status: TransactionStatus.UNRECONCILED,
          splitNewShares: undefined,
          splitOldShares: undefined,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  const watchedAccountId = useWatch({ control, name: 'accountId' });
  const watchedAction = useWatch({ control, name: 'action' }) as InvestmentAction;
  // 'TRANSFER' is a UI-only action and is not part of InvestmentAction, so it
  // never matches any of the classification arrays below; transfer fields are
  // rendered from this flag instead.
  const isTransfer = (watchedAction as string) === 'TRANSFER';
  // Editing an existing transfer leg (the action is one of the real
  // TRANSFER_IN/OUT values, not the UI-only 'TRANSFER').
  // An imported TRANSFER_IN with no paired leg is one row, not a pair: it is
  // edited and saved like any single transaction, so it can be given a series.
  const isUnpairedTransferIn =
    !!transaction &&
    transaction.action === 'TRANSFER_IN' &&
    !transaction.linkedTransactionId &&
    (watchedAction as string) === 'TRANSFER_IN';
  const isTransferEditing =
    !!transaction &&
    !isUnpairedTransferIn &&
    ((watchedAction as string) === 'TRANSFER_IN' ||
      (watchedAction as string) === 'TRANSFER_OUT');
  // Source-account holdings are relevant both when creating a transfer and when
  // editing one (to validate the available quantity).
  const transferActive = isTransfer || isTransferEditing;
  const watchedSecurityId = useWatch({ control, name: 'securityId' });
  const watchedBondInstrumentId = useWatch({ control, name: 'bondInstrumentId' });
  const watchedDestinationAccountId = useWatch({ control, name: 'destinationAccountId' });
  const watchedFundingAccountId = useWatch({ control, name: 'fundingAccountId' });
  const watchedQuantity = Number(useWatch({ control, name: 'quantity' })) || 0;
  const watchedPrice = Number(useWatch({ control, name: 'price' })) || 0;
  const watchedCommission = Number(useWatch({ control, name: 'commission' })) || 0;
  const watchedAccruedInterest = Number(useWatch({ control, name: 'accruedInterest' })) || 0;
  const watchedExchangeRate = Number(useWatch({ control, name: 'exchangeRate' })) || 0;
  const watchedTransactionDate = useWatch({ control, name: 'transactionDate' });
  const watchedSplitNewShares = Number(useWatch({ control, name: 'splitNewShares' })) || 0;
  const watchedSplitOldShares = Number(useWatch({ control, name: 'splitOldShares' })) || 0;
  const splitRatio =
    watchedSplitOldShares > 0 ? watchedSplitNewShares / watchedSplitOldShares : 0;

  const allAccountsSource = allAccounts || accounts;

  // Derive currency from selected account
  const accountCurrency = useMemo(() => {
    if (watchedAccountId) {
      const account = accounts.find(a => a.id === watchedAccountId);
      if (account) return account.currencyCode;
    }
    return defaultCurrency;
  }, [watchedAccountId, accounts, defaultCurrency]);

  // Resolve the cash account that will actually receive/provide the funds.
  // For BUY/SELL with a funding account override, or for dividend/interest/
  // capital gain with a destination override, that's the chosen account;
  // otherwise it's the brokerage's linked investment cash account.
  const cashAccount = useMemo(() => {
    if (
      (actionIn(watchedAction, fundingAccountActions) ||
        actionIn(watchedAction, cashDestinationActions)) &&
      watchedFundingAccountId
    ) {
      return allAccountsSource.find((a) => a.id === watchedFundingAccountId) ?? null;
    }
    if (watchedAccountId) {
      const brokerage = allAccountsSource.find((a) => a.id === watchedAccountId);
      if (brokerage?.linkedAccountId) {
        return (
          allAccountsSource.find((a) => a.id === brokerage.linkedAccountId) ?? null
        );
      }
      return brokerage ?? null;
    }
    return null;
  }, [watchedAccountId, watchedFundingAccountId, watchedAction, allAccountsSource]);

  const cashCurrency = cashAccount?.currencyCode ?? accountCurrency;

  // Use security currency when a security is selected, otherwise fall back to account currency
  const transactionCurrency = useMemo(() => {
    if (watchedSecurityId) {
      const security = securities.find(s => s.id === watchedSecurityId);
      if (security) return security.currencyCode;
    }
    return accountCurrency;
  }, [watchedSecurityId, securities, accountCurrency]);
  const originalSecurityId = transaction?.securityId || transaction?.security?.id;
  const bondKindNow = bondSeriesKind(watchedAction);
  const storedBondKind = transaction ? bondSeriesKind(transaction.action) : null;
  // The edited row's own series counts only while the form is still on the row's
  // security and the kind of action it was saved as.
  const storedBondInstrumentId =
    transaction && watchedSecurityId === originalSecurityId && bondKindNow === storedBondKind
      ? (transaction.bondInstrumentId ?? null)
      : null;
  // A program-linked security's share-moving row names the series it acts on.
  const bondSeries = useBondSeriesOptions(
    securities.find((s) => s.id === watchedSecurityId),
    bondKindNow,
    {
      date: watchedTransactionDate,
      accountId: watchedAccountId,
      excludeTransactionId: transaction?.id,
      storedInstrumentId: storedBondInstrumentId,
    },
  );
  // The reader's pick; '' is the default of the kind: the series the server
  // infers from the date (an acquisition) or the oldest lots (a removal).
  const bondSeriesValue = watchedBondInstrumentId ?? '';
  // A series belongs to one security and one direction: another security, or a
  // switch between acquiring, removing and transferring in, starts the choice
  // again -- even when editing, where only the row's own kind restores its value.
  useEffect(() => {
    setValue(
      'bondInstrumentId',
      transaction && watchedSecurityId === originalSecurityId && bondKindNow === storedBondKind
        ? (transaction.bondInstrumentId ?? '')
        : undefined,
      { shouldDirty: false },
    );
  }, [watchedSecurityId, bondKindNow, storedBondKind, originalSecurityId, transaction, setValue]);
  // A redemption of a program-linked bond: once series, date and quantity are
  // set, the server splits what it pays into returned principal and interest and
  // the form suggests both. A person's own edit of either field stands.
  const priceEditedByPerson = useRef(false);
  const interestEditedByPerson = useRef(false);
  // What the person typed, kept as typed: the redemption refill recomputes from
  // it and never from a price an earlier refill wrote.
  const typedPriceBasis = useRef<{ kind: 'price' | 'total'; value: number } | null>(null);
  const redemptionRequest: RedemptionSplitRequest | null =
    (watchedAction as string) === 'REDEEM' &&
    bondSeries?.kind === 'remove' &&
    watchedSecurityId &&
    watchedAccountId &&
    bondSeriesValue &&
    /^\d{4}-\d{2}-\d{2}$/.test(watchedTransactionDate) &&
    Number.isInteger(watchedQuantity) &&
    watchedQuantity > 0
      ? {
          securityId: watchedSecurityId,
          accountId: watchedAccountId,
          bondInstrumentId: bondSeriesValue,
          date: watchedTransactionDate,
          quantity: watchedQuantity,
          excludeTransactionId: transaction?.id,
        }
      : null;
  const redemption = useBondRedemptionSplit(redemptionRequest);
  // An existing redemption opens with the values it stored; only a change of
  // series, date, account or quantity suggests new ones.
  const openRedemptionKey =
    transaction && transaction.action === 'REDEEM' && transaction.bondInstrumentId
      ? redemptionRequestKey({
          securityId: originalSecurityId ?? '',
          accountId: transaction.accountId,
          bondInstrumentId: transaction.bondInstrumentId,
          date: transaction.transactionDate,
          quantity: Number(transaction.quantity),
          excludeTransactionId: transaction.id,
        })
      : null;
  // The opened row's own answer is suppressed once (it seeds the ref); every
  // later answer, including a return to the opened quantity, fills.
  const lastFilledKey = useRef<string | null>(openRedemptionKey);
  useEffect(() => {
    const { key, split } = redemption;
    if (key === null || split === null) return;
    if (key === lastFilledKey.current) return;
    lastFilledKey.current = key;
    if (split.refusal !== null || split.principalReturned === null || split.interest === null) return;
    const quantity = split.quantity;
    if (!priceEditedByPerson.current) {
      setValue('price', roundToDecimals(Number(split.principalReturned) / quantity, 10), {
        shouldDirty: true,
        shouldValidate: true,
      });
    } else if (!interestEditedByPerson.current) {
      // The person fixed the price or the total: the cash they meant stays, so
      // the engine's interest comes out of it and the price follows, instead of
      // the interest being added on top. A typed price means qty x price in cash.
      const basis = typedPriceBasis.current;
      if (!basis) return;
      const commission = Number(getValues('commission') ?? 0);
      const gross =
        basis.kind === 'price'
          ? quantity * basis.value - Number(split.interest)
          : basis.value - Number(split.interest) + commission;
      if (!(gross > 0)) return;
      setValue('price', roundToDecimals(gross / quantity, 10), { shouldDirty: true, shouldValidate: true });
    }
    if (!interestEditedByPerson.current) {
      setValue('accruedInterest', Number(split.interest), { shouldDirty: true, shouldValidate: true });
    }
  }, [redemption, setValue, getValues]);
  const currencySymbol = getCurrencySymbol(transactionCurrency);
  const cashCurrencySymbol = getCurrencySymbol(cashCurrency);

  const needsConversion =
    actionIn(watchedAction, cashPostingActions) &&
    !!transactionCurrency &&
    !!cashCurrency &&
    transactionCurrency !== cashCurrency;

  // Notify the parent so it can resize the modal to fit the conversion section
  useEffect(() => {
    onConversionStateChange?.(needsConversion);
  }, [needsConversion, onConversionStateChange]);

  // Calculate total amount
  const totalAmount = useMemo(() => {
    if (actionIn(watchedAction, quantityPriceActions)) {
      const subtotal = roundToDecimals(watchedQuantity * watchedPrice, 4);
      if (baseInvestmentAction(watchedAction) === 'BUY' || baseInvestmentAction(watchedAction) === 'REINVEST') {
        return roundToDecimals(subtotal + watchedCommission, 4);
      }
      const proceeds = roundToDecimals(subtotal - watchedCommission, 4);
      // The accrued interest arrives with the proceeds, so the figure the user
      // approves is what the cash account will actually receive.
      return supportsAccruedInterest(watchedAction)
        ? redemptionTotalWithInterest(proceeds, watchedAccruedInterest)
        : proceeds;
    }
    return watchedPrice; // For amount-only actions, price is used as the amount
  }, [
    watchedAction,
    watchedQuantity,
    watchedPrice,
    watchedCommission,
    watchedAccruedInterest,
  ]);

  // Set when the person types the rate (or the converted total it derives
  // from). A typed rate survives a pair or date change; a prefilled one does
  // not, because it answered a different question.
  const rateEditedRef = useRef(false);

  // Editing keeps the stored rate on load. `undefined` until the first run that
  // can ask; then the pair-and-day key the stored rate belongs to, or `null`
  // once it has been left (a different pair or day asks again).
  const keptRateKeyRef = useRef<string | null | undefined>(undefined);
  const hasStoredRate =
    !!transaction && !!transaction.exchangeRate && transaction.exchangeRate !== 1;

  // When the currencies match there is nothing to convert: keep the rate at 1
  // so the backend falls back cleanly.
  //
  // Wait until securities have loaded before running: otherwise, when editing
  // an existing cross-currency transaction, the security isn't in the list
  // yet so transactionCurrency falls back to the account currency, making
  // needsConversion transiently false. Without this guard we'd clobber the
  // stored exchangeRate to 1 here.
  useEffect(() => {
    if (!securitiesLoaded || needsConversion) return;
    if (watchedExchangeRate !== 1) {
      setValue('exchangeRate', 1, { shouldDirty: false });
    }
    rateEditedRef.current = false;
  }, [securitiesLoaded, needsConversion, watchedExchangeRate, setValue]);

  // Prefill the exchange rate with the rate for the TRADE DATE (INV-FX-001),
  // never the latest: a BUY dated 2025-01-02 entered today commits the 2025-01-02
  // rate. Keyed on pair and date, so a date change asks again unless the person
  // typed a rate. The answer is adopted only while its key is still the current
  // one (the cleanup cancels a superseded request), and a null answer or a failed
  // request leaves the field unresolved -- 0, which blocks the commit -- rather
  // than falling back to the latest rate.
  useEffect(() => {
    if (!securitiesLoaded || !needsConversion) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(watchedTransactionDate)) return;
    if (rateEditedRef.current) return;
    const rateKey = `${transactionCurrency}->${cashCurrency}@${watchedTransactionDate}`;
    if (keptRateKeyRef.current === undefined) {
      keptRateKeyRef.current = hasStoredRate ? rateKey : null;
    }
    if (keptRateKeyRef.current === rateKey) return;
    keptRateKeyRef.current = null;
    let cancelled = false;
    // The old answer belonged to another pair or day; do not leave it standing
    // while the new one is in flight.
    setValue('exchangeRate', 0, { shouldDirty: false });
    exchangeRatesApi
      .getRateForDate(transactionCurrency, cashCurrency, watchedTransactionDate)
      .then((rate) => {
        if (cancelled || rateEditedRef.current) return;
        if (rate && rate > 0) {
          // Rates are NUMERIC(20,10) and every conversion multiplies at that
          // precision; six is what the field *shows*.
          setValue('exchangeRate', roundFxRate(rate), { shouldDirty: false });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error('Failed to load the exchange rate for the trade date:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    securitiesLoaded,
    needsConversion,
    transactionCurrency,
    cashCurrency,
    watchedTransactionDate,
    hasStoredRate,
    setValue,
  ]);

  /**
   * The cash movement this trade will post, or `null` when the currencies differ
   * and no rate has been resolved.
   *
   * `|| 1` used to stand in for the missing rate, so the preview showed
   * 10 x 100.00 USD as 1,000.00 CAD while the request omitted `exchangeRate`
   * entirely and the server resolved its own dated or latest rate -- persisting
   * 1,350.00 CAD against a preview the user had just confirmed. An unresolved
   * rate is not a rate of one; it is a reason not to commit.
   */
  const convertedAmount = useMemo(() => {
    if (!needsConversion) return totalAmount;
    if (!watchedExchangeRate || watchedExchangeRate <= 0) return null;
    return roundToDecimals(totalAmount * watchedExchangeRate, 4);
  }, [needsConversion, totalAmount, watchedExchangeRate]);

  /** True when the cash leg cannot be priced, so the trade must not be posted. */
  const conversionUnresolved = needsConversion && convertedAmount === null;

  /**
   * The total the row will STORE, which is not always the total on screen: a
   * redemption's proceeds are shown with the accrued interest that arrives
   * with them, and `total_amount` is proceeds (the interest is its own linked
   * row).
   */
  const storedTotalAmount = useMemo(
    () =>
      supportsAccruedInterest(watchedAction)
        ? roundToDecimals(totalAmount - watchedAccruedInterest, 4)
        : totalAmount,
    [watchedAction, totalAmount, watchedAccruedInterest],
  );

  /**
   * The user typed the total, so the total is the fact and the price follows
   * it -- the inverse of the `totalAmount` memo above, at the price column's
   * own ten decimals (INV-TRADE-001).
   *
   * Nothing to derive without shares to divide by, and a total smaller than
   * the commission would imply a negative price, which is not a price; both
   * leave the fields as they are rather than writing a figure nobody meant.
   */
  const handleTotalAmountChange = (value: number | undefined) => {
    if (value === undefined || value === null) return;
    if (!watchedQuantity) return;
    const proceeds = supportsAccruedInterest(watchedAction)
      ? value - watchedAccruedInterest
      : value;
    const base = baseInvestmentAction(watchedAction);
    const gross =
      base === 'BUY' || base === 'REINVEST'
        ? proceeds - watchedCommission
        : proceeds + watchedCommission;
    if (!(gross > 0)) return;
    priceEditedByPerson.current = true;
    typedPriceBasis.current = { kind: 'total', value };
    setValue('price', roundToDecimals(gross / watchedQuantity, 10), {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const handleConvertedAmountChange = (value: number | undefined) => {
    if (!needsConversion || totalAmount === 0) return;
    if (value === undefined || value === null) return;
    const newRate = roundToDecimals(value / totalAmount, 10);
    rateEditedRef.current = true;
    setValue('exchangeRate', newRate, { shouldDirty: true, shouldValidate: true });
  };

  // Load securities — ensure the transaction's security is included even if inactive
  useEffect(() => {
    const loadSecurities = async () => {
      try {
        const data = await investmentsApi.getSecurities();
        if (transaction?.security && !data.some((s) => s.id === transaction.security!.id)) {
          data.push(transaction.security);
        }
        setSecurities(data);
      } catch (error) {
        logger.error('Failed to load securities:', error);
      } finally {
        setSecuritiesLoaded(true);
      }
    };
    loadSecurities();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror the new/old-shares ratio into the underlying `quantity` field that
  // gets posted to the API. Done as an effect so manual edits to either input
  // immediately update the value the form will submit.
  useEffect(() => {
    if (watchedAction !== 'SPLIT') return;
    if (!Number.isFinite(splitRatio) || splitRatio <= 0) return;
    setValue('quantity', splitRatio, { shouldDirty: true, shouldValidate: false });
  }, [watchedAction, splitRatio, setValue]);

  // Clear a stale fundingAccountId when switching to an action that doesn't
  // accept one, so the value doesn't silently carry over to a hidden field.
  useEffect(() => {
    if (
      !actionIn(watchedAction, fundingAccountActions) &&
      !actionIn(watchedAction, cashDestinationActions) &&
      watchedFundingAccountId
    ) {
      setValue('fundingAccountId', '', { shouldDirty: false });
    }
  }, [watchedAction, watchedFundingAccountId, setValue]);

  // Pull the holding state as it was just before this split's transaction
  // date, so the preview's "Before" reflects what the user actually held at
  // that point in time -- not the live holdings (which already include this
  // split and any subsequent activity). Re-fetched whenever the inputs that
  // would change the answer change, and dropped (during render, not in the
  // effect) once there is no split to preview.
  const splitHoldingWanted =
    watchedAction === 'SPLIT' &&
    !!watchedAccountId &&
    !!watchedSecurityId &&
    !!watchedTransactionDate;
  if (!splitHoldingWanted && splitHoldingAt !== null) {
    setSplitHoldingAt(null);
  }
  useEffect(() => {
    if (
      watchedAction !== 'SPLIT' ||
      !watchedAccountId ||
      !watchedSecurityId ||
      !watchedTransactionDate
    ) {
      return;
    }
    let cancelled = false;
    investmentsApi
      .getHoldingAt({
        accountId: watchedAccountId,
        securityId: watchedSecurityId,
        asOfDate: watchedTransactionDate,
        excludeTransactionId: transaction?.id,
      })
      .then((data) => {
        if (!cancelled) setSplitHoldingAt(data);
      })
      .catch((error) => {
        if (!cancelled) {
          setSplitHoldingAt(null);
          logger.error('Failed to load as-of holdings:', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    watchedAction,
    watchedAccountId,
    watchedSecurityId,
    watchedTransactionDate,
    transaction?.id,
  ]);

  // For a TRANSFER, load the source account's current holdings. Only securities
  // actually held there can be transferred, and each holding carries the
  // average cost we use to prefill the cost-per-share. Cleared during render,
  // not in the effect, once there is no transfer source to read.
  if ((!transferActive || !watchedAccountId) && transferSourceHoldings.length > 0) {
    setTransferSourceHoldings([]);
  }
  useEffect(() => {
    if (!transferActive || !watchedAccountId) {
      return;
    }
    let cancelled = false;
    investmentsApi
      .getHoldings(watchedAccountId)
      .then((data) => {
        if (!cancelled) setTransferSourceHoldings(data);
      })
      .catch((error) => {
        if (!cancelled) {
          setTransferSourceHoldings([]);
          logger.error('Failed to load source holdings for transfer:', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [transferActive, watchedAccountId]);

  // When editing a transfer leg, load the paired leg so both the source and
  // destination accounts can be shown. The form's `accountId` always holds the
  // source (TRANSFER_OUT) account and `destinationAccountId` the destination
  // (TRANSFER_IN) account, regardless of which leg was opened. Cleared during
  // render, not in the effect, when the row being edited has no paired leg.
  const hasLinkedLeg =
    !!transaction &&
    (transaction.action === 'TRANSFER_IN' || transaction.action === 'TRANSFER_OUT') &&
    !!transaction.linkedTransactionId;
  if (!hasLinkedLeg && transferLinkedLeg !== null) {
    setTransferLinkedLeg(null);
  }
  useEffect(() => {
    const action = transaction?.action;
    if (
      !transaction ||
      (action !== 'TRANSFER_IN' && action !== 'TRANSFER_OUT') ||
      !transaction.linkedTransactionId
    ) {
      return;
    }
    let cancelled = false;
    investmentsApi
      .getTransaction(transaction.linkedTransactionId)
      .then((linked) => {
        if (cancelled) return;
        setTransferLinkedLeg(linked);
        const sourceId =
          action === 'TRANSFER_OUT' ? transaction.accountId : linked.accountId;
        const destId =
          action === 'TRANSFER_OUT' ? linked.accountId : transaction.accountId;
        setValue('accountId', sourceId);
        setValue('destinationAccountId', destId);
      })
      .catch((error) => {
        if (!cancelled) {
          setTransferLinkedLeg(null);
          logger.error('Failed to load linked transfer leg:', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [transaction, setValue]);

  // Prefill the cost-per-share from the selected source holding's average cost
  // so the original cost basis carries to the destination. Re-runs when the
  // selected security (or the loaded holdings) change; manual edits persist
  // until then.
  const selectedTransferHolding = useMemo(
    () =>
      transferActive && watchedSecurityId
        ? transferSourceHoldings.find((h) => h.securityId === watchedSecurityId)
        : undefined,
    [transferActive, watchedSecurityId, transferSourceHoldings],
  );
  useEffect(() => {
    // Only prefill the cost on a new transfer. When editing, the leg already
    // carries its own cost basis and must not be reset to the current average.
    if (!isTransfer || !selectedTransferHolding) return;
    setValue(
      'price',
      roundToDecimals(Number(selectedTransferHolding.averageCost) || 0, 6),
      { shouldValidate: true },
    );
  }, [isTransfer, selectedTransferHolding, setValue]);

  // Securities available to transfer: only those currently held in the source
  // account. Use the same presence threshold the portfolio/holdings views use
  // (|qty| >= 0.0001) so the list matches what the account actually shows --
  // zero and tiny residual positions left by sells/splits/imports are excluded.
  const transferSecurityOptions = useMemo(
    () =>
      transferSourceHoldings
        .filter((h) => Number(h.quantity) >= 0.0001 && h.security)
        .map((h) => ({
          value: h.securityId,
          label: `${h.security.symbol} - ${h.security.name} (${h.security.currencyCode})`,
        })),
    [transferSourceHoldings],
  );

  // Re-sync form values when editing and securities are loaded
  useEffect(() => {
    if (transaction && securities.length > 0) {
      const securityId = transaction.securityId || transaction.security?.id;
      if (securityId) {
        setValue('securityId', securityId);
      }
    }
  }, [transaction, securities, setValue]);

  const handleSecurityCreated = async (data: CreateSecurityData) => {
    try {
      const created = await investmentsApi.createSecurity(data);
      setSecurities((prev) => [...prev, created]);
      setValue('securityId', created.id);
      setShowSecurityModal(false);
      toast.success(t('transactionForm.toastSecurityCreated'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('transactionForm.toastSecurityCreateFailed')));
      throw error;
    }
  };

  // The two behaviours the create button can carry. Order is fixed: 'close'
  // first, because it is what the button did before this choice existed.
  const submitOptions = [
    {
      id: 'close',
      label: isTransfer
        ? t('transactionForm.submitTransfer')
        : t('transactionForm.submitCreate'),
      description: t('transactionForm.submitCreateDescription'),
    },
    {
      id: 'new',
      label: isTransfer
        ? t('transactionForm.submitTransferAndNew')
        : t('transactionForm.submitCreateAndNew'),
      description: t('transactionForm.submitCreateAndNewDescription'),
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

  const onSubmit = async (data: InvestmentTransactionFormData) => {
    setIsLoading(true);
    setBondSeriesError(null);
    try {
      if (data.action === 'TRANSFER') {
        const quantity = Number(data.quantity) || 0;
        const costPerShare = Number(data.price) || 0;
        if (!data.securityId) {
          toast.error(t('transactionForm.toastSelectSecurity'));
          setIsLoading(false);
          return;
        }
        if (!data.destinationAccountId) {
          toast.error(t('transactionForm.toastSelectDestination'));
          setIsLoading(false);
          return;
        }
        if (data.destinationAccountId === data.accountId) {
          toast.error(t('transactionForm.toastSameAccount'));
          setIsLoading(false);
          return;
        }
        if (quantity <= 0) {
          toast.error(t('transactionForm.toastQuantityRequired'));
          setIsLoading(false);
          return;
        }
        const available = roundToDecimals(
          Number(selectedTransferHolding?.quantity ?? 0),
          8,
        );
        if (selectedTransferHolding && quantity > available) {
          toast.error(t('transactionForm.toastAvailableShares', { available }));
          setIsLoading(false);
          return;
        }
        await investmentsApi.transferSecurity({
          fromAccountId: data.accountId,
          toAccountId: data.destinationAccountId,
          securityId: data.securityId,
          transactionDate: data.transactionDate,
          quantity,
          costPerShare,
          description: data.description,
        });
        toast.success(t('transactionForm.toastTransferred'));
        rememberTransactionDate(
          LAST_INVESTMENT_TRANSACTION_DATE_KEY,
          data.transactionDate,
        );
        finishAfterCreate(data.accountId);
        return;
      }

      // Editing an existing transfer: update the pair via the source (OUT) leg.
      if (
        transaction &&
        !isUnpairedTransferIn &&
        (data.action === 'TRANSFER_IN' || data.action === 'TRANSFER_OUT')
      ) {
        const quantity = Number(data.quantity) || 0;
        const costPerShare = Number(data.price) || 0;
        if (!data.securityId) {
          toast.error(t('transactionForm.toastSelectSecurity'));
          setIsLoading(false);
          return;
        }
        if (!data.destinationAccountId) {
          toast.error(t('transactionForm.toastSelectDestination'));
          setIsLoading(false);
          return;
        }
        if (data.destinationAccountId === data.accountId) {
          toast.error(t('transactionForm.toastSameAccount'));
          setIsLoading(false);
          return;
        }
        if (quantity <= 0) {
          toast.error(t('transactionForm.toastQuantityRequired'));
          setIsLoading(false);
          return;
        }
        // Available-quantity check. The edit reverses this leg before
        // reapplying, so its original quantity is available again on top of the
        // current source holding. Only checked when the source account is
        // unchanged; otherwise the backend's full-history validation is
        // authoritative.
        const originalSourceAccountId =
          transaction.action === 'TRANSFER_OUT'
            ? transaction.accountId
            : transferLinkedLeg?.accountId;
        if (
          selectedTransferHolding &&
          data.accountId === originalSourceAccountId
        ) {
          const available = roundToDecimals(
            Number(selectedTransferHolding.quantity) +
              Number(transaction.quantity ?? 0),
            8,
          );
          if (quantity > available) {
            toast.error(t('transactionForm.toastAvailableShares', { available }));
            setIsLoading(false);
            return;
          }
        }
        const outLegId =
          data.action === 'TRANSFER_OUT'
            ? transaction.id
            : transferLinkedLeg?.id;
        if (!outLegId) {
          toast.error(t('transactionForm.toastPairedLegError'));
          setIsLoading(false);
          return;
        }
        await investmentsApi.updateTransaction(outLegId, {
          accountId: data.accountId,
          destinationAccountId: data.destinationAccountId,
          securityId: data.securityId,
          quantity,
          price: costPerShare,
          transactionDate: data.transactionDate,
          description: data.description,
          status: data.status,
        });
        toast.success(t('transactionForm.toastTransferUpdated'));
        onSuccess?.();
        return;
      }

      const action = data.action as InvestmentAction;
      // A transfer in or an added holding names its series: the server has no
      // date to infer it from, so the form does not send it without one.
      if (bondSeries?.kind === 'select' && !bondSeriesValue) {
        setBondSeriesError(t('transactionForm.bondSeries.required'));
        setIsLoading(false);
        return;
      }
      const postsCash = actionIn(action, cashPostingActions);
      const isSplit = action === 'SPLIT';
      // For splits the new/old-shares inputs are the source of truth; the
      // hidden `quantity` field is kept in sync via effect, but we recompute
      // here so a stale or skipped effect can't post a wrong ratio.
      const splitNew = Number(data.splitNewShares);
      const splitOld = Number(data.splitOldShares);
      const ratio =
        Number.isFinite(splitNew) && Number.isFinite(splitOld) && splitOld > 0
          ? splitNew / splitOld
          : 0;
      if (isSplit && ratio <= 0) {
        toast.error(t('transactionForm.toastSplitRatioRequired'));
        setIsLoading(false);
        return;
      }
      // A cross-currency trade may not be committed on an unresolved rate. The
      // preview would have to invent one, and omitting the field lets the server
      // resolve a different rate than the figure the user just confirmed.
      if (postsCash && conversionUnresolved) {
        toast.error(t('transactionForm.toastExchangeRateRequired'));
        setIsLoading(false);
        return;
      }
      const payload = {
        accountId: data.accountId,
        action,
        transactionDate: data.transactionDate,
        securityId: actionIn(action, securityRequiredActions) || isUnpairedTransferIn
          ? data.securityId
          : undefined,
        fundingAccountId:
          (actionIn(action, fundingAccountActions) ||
            actionIn(action, cashDestinationActions)) &&
          data.fundingAccountId
            ? data.fundingAccountId
            : undefined,
        quantity: isSplit
          ? ratio
          : (actionIn(action, quantityPriceActions) || actionIn(action, quantityOnlyActions))
            ? data.quantity
            : undefined,
        price: actionIn(action, quantityOnlyActions)
          ? undefined
          : isSplit
            ? (data.price && data.price > 0 ? data.price : undefined)
            : data.price,
        commission: actionIn(action, quantityOnlyActions) || isSplit
          ? undefined
          : data.commission,
        // What the trade came to, sent as the fact it is: the server stores it
        // as given and derives the price from it, so the figure the user
        // approved on screen is the figure in the ledger. Only the actions
        // whose total is a quantity times a price have one.
        totalAmount:
          actionIn(action, quantityPriceActions) && !isSplit
            ? storedTotalAmount
            : undefined,
        // Always sent for a redemption, including as 0: an omitted field means
        // "unchanged" to the backend, so clearing the box has to say so.
        accruedInterest: supportsAccruedInterest(action)
          ? (data.accruedInterest ?? 0)
          : undefined,
        // Only send the exchange rate for actions that post a cash transaction.
        exchangeRate:
          postsCash && data.exchangeRate && data.exchangeRate > 0
            ? data.exchangeRate
            : undefined,
        // Null lets the server infer the series from the date (an acquisition)
        // or take the oldest lots first (a removal); only a program-linked
        // security has one. A pick is sent as the series id it is.
        bondInstrumentId: bondSeries ? bondSeriesValue || null : undefined,
        description: data.description,
        status: data.status,
      };

      if (transaction) {
        await investmentsApi.updateTransaction(transaction.id, payload);
        toast.success(t('transactionForm.toastUpdated'));
        onSuccess?.();
      } else {
        await investmentsApi.createTransaction(payload);
        toast.success(t('transactionForm.toastCreated'));
        rememberTransactionDate(
          LAST_INVESTMENT_TRANSACTION_DATE_KEY,
          data.transactionDate,
        );
        finishAfterCreate(data.accountId);
      }
    } catch (error) {
      const message = getErrorMessage(error, t('transactionForm.toastSaveFailed'));
      const code = getErrorCode(error);
      if (bondSeries && code && (BOND_SERIES_ERROR_CODES as readonly string[]).includes(code)) {
        setBondSeriesError(message);
      }
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const needsSecurity = actionIn(watchedAction, securityRequiredActions);
  const needsQuantityPrice = actionIn(watchedAction, quantityPriceActions);
  const isQuantityOnly = actionIn(watchedAction, quantityOnlyActions);
  const isAmountOnly = actionIn(watchedAction, amountOnlyActions);
  const isSplit = watchedAction === 'SPLIT';
  // An individual posted transfer leg (TRANSFER_IN/TRANSFER_OUT). These only
  // appear when editing an existing transfer; the create flow uses the
  // combined 'TRANSFER' action instead.
  const isTransferLeg =
    watchedAction === 'TRANSFER_IN' || watchedAction === 'TRANSFER_OUT';
  // Either creating a transfer (combined action) or editing an existing leg.
  // Both render the From/To + security + quantity + cost-per-share UI.
  const transferMode = isTransfer || (isTransferLeg && !isUnpairedTransferIn);
  const canHaveFundingAccount = actionIn(watchedAction, fundingAccountActions);
  const canHaveCashDestination = actionIn(watchedAction, cashDestinationActions);

  // When creating, offer a single "Transfer" option and hide the raw
  // TRANSFER_IN/TRANSFER_OUT legs (they are produced as a pair by the backend).
  // When editing an existing leg, show the real action labels so the stored
  // action displays correctly.
  const actionOptions = transaction
    ? Object.entries(actionLabels).map(([value, label]) => ({ value, label }))
    : [
        ...Object.entries(actionLabels)
          .filter(([value]) => value !== 'TRANSFER_IN' && value !== 'TRANSFER_OUT')
          .map(([value, label]) => ({ value, label })),
        { value: 'TRANSFER', label: t('transactionForm.actionTransfer') },
      ];

  // Brokerage accounts eligible as a transfer destination: exclude the source
  // and any closed account (a closed account shouldn't receive new shares),
  // but keep the currently-selected destination visible when editing a transfer
  // that already points at a since-closed account.
  const destinationAccounts = brokerageAccounts.filter(
    (a) =>
      a.id !== watchedAccountId &&
      (!a.isClosed || a.id === watchedDestinationAccountId),
  );

  const splitPreview = useMemo(() => {
    if (!isSplit || !splitHoldingAt || splitRatio <= 0) return null;
    const currentQty = Number(splitHoldingAt.quantity);
    if (currentQty <= 0) return null;
    const currentAvg = Number(splitHoldingAt.averageCost ?? 0);
    return {
      currentQty,
      currentAvg,
      newQty: currentQty * splitRatio,
      newAvg: splitRatio > 0 ? currentAvg / splitRatio : 0,
    };
  }, [isSplit, splitHoldingAt, splitRatio]);

  return (
    <>
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Account Selection */}
      <Select
        label={transferMode ? t('transactionForm.fromAccount') : t('transactionForm.brokerageAccount')}
        error={errors.accountId?.message}
        options={[
          { value: '', label: t('transactionForm.selectAccount') },
          ...brokerageAccounts.map((a) => ({
            value: a.id,
            label: `${a.name} (${a.currencyCode})`,
          })),
        ]}
        {...register('accountId')}
      />

      {/* Date and Transaction Type */}
      <div className="grid grid-cols-2 gap-4">
        <DateInput
          label={t('transactionForm.date')}
          error={errors.transactionDate?.message}
          onDateChange={(date) => setValue('transactionDate', date, { shouldDirty: true, shouldValidate: true })}
          {...register('transactionDate')}
        />
        <Select
          label={t('transactionForm.transactionType')}
          error={errors.action?.message}
          options={actionOptions}
          // A posted transfer's direction is fixed; changing it would break
          // the linked pair. The backend rejects it too.
          disabled={isTransferLeg}
          {...register('action')}
        />
      </div>

      {/* Funding Account - for Buy/Sell to specify where funds come from/go to */}
      {canHaveFundingAccount && (
        <Select
          label={baseInvestmentAction(watchedAction) === 'BUY' ? t('transactionForm.fundsFrom') : t('transactionForm.fundsTo')}
          options={[
            { value: '', label: t('transactionForm.linkedCashDefault') },
            ...fundingAccounts.map((a) => ({
              value: a.id,
              label: a.name,
            })),
          ]}
          {...register('fundingAccountId')}
        />
      )}

      {/* Destination Cash Account - for Dividend/Interest/Capital Gain */}
      {canHaveCashDestination && (
        <Select
          label={t('transactionForm.depositTo')}
          options={[
            { value: '', label: t('transactionForm.linkedCashDefault') },
            ...cashDestinationAccountsList.map((a) => ({
              value: a.id,
              label: `${a.name} (${a.currencyCode})`,
            })),
          ]}
          {...register('fundingAccountId')}
        />
      )}

      {/* Destination account - for a transfer between accounts.
          Controlled (rather than registered) so it reflects the value set
          asynchronously when editing a transfer leg: the destination option
          only enters the list once the source account is resolved, and an
          uncontrolled select would silently drop a value not yet in its
          options (the cause of the blank "To Account" on TRANSFER_IN). */}
      {transferMode && (
        <Select
          label={t('transactionForm.toAccount')}
          error={errors.destinationAccountId?.message}
          value={watchedDestinationAccountId || ''}
          onChange={(e) =>
            setValue('destinationAccountId', e.target.value, {
              shouldDirty: true,
              shouldValidate: true,
            })
          }
          options={[
            { value: '', label: t('transactionForm.selectAccount') },
            ...destinationAccounts.map((a) => ({
              value: a.id,
              label: `${a.name} (${a.currencyCode})`,
            })),
          ]}
        />
      )}

      {/* Security Selection - only for actions that need it */}
      {(needsSecurity || transferMode || isUnpairedTransferIn) && (
        <div className="space-y-2">
          <Select
            label={t('transactionForm.security')}
            error={errors.securityId?.message}
            options={[
              {
                value: '',
                label: isTransfer
                  ? watchedAccountId
                    ? transferSecurityOptions.length > 0
                      ? t('transactionForm.selectSecurity')
                      : t('transactionForm.noSecuritiesHeld')
                    : t('transactionForm.selectFromAccountFirst')
                  : t('transactionForm.selectSecurity'),
              },
              ...(isTransfer
                ? transferSecurityOptions
                : securities.map((s) => ({
                    value: s.id,
                    label: `${s.symbol} - ${s.name} (${s.currencyCode})`,
                  }))),
            ]}
            {...register('securityId')}
          />
          {/* Transfers can only move securities already held, so adding a new
              one here makes no sense. */}
          {!transferMode && (
            <button
              type="button"
              onClick={() => setShowSecurityModal(true)}
              className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {t('transactionForm.addNewSecurity')}
            </button>
          )}
        </div>
      )}

      {/* The series a share-moving row of a bond program acts on */}
      {bondSeries && !transferMode && (
        <BondSeriesSelect
          series={bondSeries}
          value={bondSeriesValue}
          onChange={(id) => {
            setBondSeriesError(null);
            setValue('bondInstrumentId', id, { shouldDirty: true });
          }}
          error={bondSeriesError ?? undefined}
        />
      )}

      {/* Quantity and Price - for buy/sell/reinvest */}
      {needsQuantityPrice && (
        <div className={`grid gap-4 ${needsConversion ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <NumericInput
            label={t('transactionForm.quantityShares')}
            value={watchedQuantity || undefined}
            onChange={(value) => setValue('quantity', value, { shouldValidate: true })}
            decimalPlaces={8}
            min={0}
            error={errors.quantity?.message}
          />
          <NumericInput
            label={t('transactionForm.pricePerShare')}
            prefix={currencySymbol}
            value={watchedPrice || undefined}
            onChange={(value) => {
              priceEditedByPerson.current = true;
              typedPriceBasis.current = value ? { kind: 'price', value } : null;
              setValue('price', value, { shouldValidate: true });
            }}
            decimalPlaces={6}
            min={0}
            error={errors.price?.message}
          />
          {needsConversion && (
            <CurrencyInput
              label={t('transactionForm.commissionFees')}
              prefix={currencySymbol}
              value={watchedCommission || undefined}
              onChange={(value) => setValue('commission', value, { shouldValidate: true })}
              error={errors.commission?.message}
              allowNegative={false}
            />
          )}
        </div>
      )}

      {/* Quantity only - for add/remove shares (no price, no cost basis impact) */}
      {isQuantityOnly && (
        <NumericInput
          label={t('transactionForm.quantityShares')}
          value={watchedQuantity || undefined}
          onChange={(value) => setValue('quantity', value, { shouldValidate: true })}
          decimalPlaces={8}
          min={0}
          error={errors.quantity?.message}
        />
      )}

      {/* Stock split - new shares vs old shares + optional new price */}
      {isSplit && (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/40">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('transactionForm.splitRatio')}
          </div>
          {transaction && !watchedSplitNewShares && !watchedSplitOldShares && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {t('transactionForm.noSplitRatioWarning')}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <NumericInput
              label={t('transactionForm.newShares')}
              value={watchedSplitNewShares || undefined}
              onChange={(value) =>
                setValue('splitNewShares', value, { shouldDirty: true, shouldValidate: true })
              }
              decimalPlaces={8}
              min={0}
              error={errors.splitNewShares?.message}
            />
            <NumericInput
              label={t('transactionForm.oldShares')}
              value={watchedSplitOldShares || undefined}
              onChange={(value) =>
                setValue('splitOldShares', value, { shouldDirty: true, shouldValidate: true })
              }
              decimalPlaces={8}
              min={0}
              error={errors.splitOldShares?.message}
            />
          </div>
          <div className="text-xs text-gray-600 dark:text-gray-400">
            {t('transactionForm.splitRatioHelp')}{' '}
            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">
              {splitRatio > 0 ? formatPrice(splitRatio) : '–'}
            </span>
          </div>
          <NumericInput
            label={t('transactionForm.newPriceAfterSplit')}
            prefix={currencySymbol}
            value={watchedPrice || undefined}
            onChange={(value) => setValue('price', value, { shouldValidate: true })}
            decimalPlaces={6}
            min={0}
            error={errors.price?.message}
          />
          {splitPreview && (
            <div className="rounded border border-gray-200 bg-white p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
              <div className="font-medium text-gray-900 dark:text-gray-100">
                {t('transactionForm.holdingPreview')}
              </div>
              <div>
                {t('transactionForm.holdingPreviewBefore', { date: formatDate(watchedTransactionDate) })}{' '}
                <span className="font-mono">
                  {formatShareQuantity(splitPreview.currentQty)}
                </span>{' '}
                {t('transactionForm.holdingPreviewShares')}{' '}
                <span className="font-mono">
                  {formatCurrency(splitPreview.currentAvg, transactionCurrency, 4)}
                </span>{' '}
                {t('transactionForm.holdingPreviewAvgCost')}
              </div>
              <div>
                {t('transactionForm.holdingPreviewAfter')}{' '}
                <span className="font-mono">
                  {formatShareQuantity(splitPreview.newQty)}
                </span>{' '}
                {t('transactionForm.holdingPreviewShares')}{' '}
                <span className="font-mono">
                  {formatCurrency(splitPreview.newAvg, transactionCurrency, 4)}
                </span>{' '}
                {t('transactionForm.holdingPreviewAvgCost')}
              </div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('transactionForm.holdingPreviewCostBasisNote')}
              </div>
            </div>
          )}
          {!splitPreview && watchedSecurityId && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t('transactionForm.noSharesOnDate', { date: formatDate(watchedTransactionDate) })}
            </div>
          )}
        </div>
      )}

      {/* Amount - for dividend/interest/capital gain/return of capital */}
      {isAmountOnly && (
        <CurrencyInput
          label={t('transactionForm.amount')}
          prefix={currencySymbol}
          value={watchedPrice || undefined}
          onChange={(value) => setValue('price', value, { shouldValidate: true })}
          error={errors.price?.message}
          allowNegative={false}
        />
      )}

      {/* A return of capital is not income; say what it does instead. */}
      {watchedAction === 'RETURN_OF_CAPITAL' && (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200">
          {t('transactionForm.returnOfCapitalNote')}
        </div>
      )}

      {/* Quantity and cost basis - for a transfer between accounts */}
      {transferMode && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <NumericInput
              label={t('transactionForm.quantityShares')}
              value={watchedQuantity || undefined}
              onChange={(value) => setValue('quantity', value, { shouldValidate: true })}
              decimalPlaces={8}
              min={0}
              error={errors.quantity?.message}
            />
            {/* Read-only: the server carries the basis the source held on the
                transfer date and ignores a figure sent from here (A26-M22). */}
            <NumericInput
              label={t('transactionForm.costPerShare')}
              prefix={currencySymbol}
              value={watchedPrice || undefined}
              onChange={(value) => setValue('price', value, { shouldValidate: true })}
              decimalPlaces={6}
              min={0}
              disabled
              error={errors.price?.message}
            />
          </div>
          {selectedTransferHolding &&
            Number(selectedTransferHolding.quantity) > 0 && (
              <div className="rounded border border-gray-200 bg-white p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
                {t('transactionForm.sourceHolds')}{' '}
                <span className="font-mono">
                  {formatShareQuantity(Number(selectedTransferHolding.quantity))}
                </span>{' '}
                {t('transactionForm.sharesAt')}{' '}
                <span className="font-mono">
                  {selectedTransferHolding.averageCost == null
                    ? '–'
                    : formatCurrency(Number(selectedTransferHolding.averageCost), transactionCurrency, 4)}
                </span>{' '}
                {t('transactionForm.avgCostSuffix')}
              </div>
            )}
          <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200">
            {t('transactionForm.transferCostNote')}
          </div>
        </div>
      )}

      {/* Commission - rendered inline with qty/price when conversion is shown */}
      {needsQuantityPrice && !needsConversion && (
        <CurrencyInput
          label={t('transactionForm.commissionFees')}
          prefix={currencySymbol}
          value={watchedCommission || undefined}
          onChange={(value) => setValue('commission', value, { shouldValidate: true })}
          error={errors.commission?.message}
          allowNegative={false}
        />
      )}

      {/* Accrued interest -- a redemption alone pays it, and it rides on the
          same cash movement rather than needing a transaction of its own. */}
      {supportsAccruedInterest(watchedAction) && (
        <div>
          <CurrencyInput
            label={t('transactionForm.accruedInterest')}
            prefix={currencySymbol}
            value={watchedAccruedInterest || undefined}
            onChange={(value) => {
              interestEditedByPerson.current = true;
              setValue('accruedInterest', value, { shouldValidate: true });
            }}
            error={errors.accruedInterest?.message}
            allowNegative={false}
          />
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('transactionForm.accruedInterestHelp')}
          </div>
          {redemptionRequest !== null && (
            <div className="mt-1">
              <BondRedemptionInfo result={redemption} currencyCode={transactionCurrency} />
            </div>
          )}
        </div>
      )}

      {/* Description */}
      <Input
        label={t('transactionForm.description')}
        placeholder={t('transactionForm.descriptionPlaceholder')}
        maxLength={TRANSACTION_NOTE_MAX_LENGTH}
        error={errors.description?.message}
        {...register('description')}
      />

      {/* Status selector -- same four options as the cash register's form (the
          only place VOID can be set or cleared). An embedded split row's
          status is owned by its parent split transaction, so the field is
          disabled there and the hint points at the parent. */}
      <div>
        <Select
          label={tStatus('form.fields.status')}
          options={[
            { value: TransactionStatus.UNRECONCILED, label: tStatus('form.statusOptions.unreconciled') },
            { value: TransactionStatus.CLEARED, label: tStatus('form.statusOptions.cleared') },
            { value: TransactionStatus.RECONCILED, label: tStatus('form.statusOptions.reconciled') },
            { value: TransactionStatus.VOID, label: tStatus('form.statusOptions.void') },
          ]}
          disabled={isEmbedded}
          {...register('status')}
        />
        {isEmbedded && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('transactionForm.statusLockedToParent')}
          </p>
        )}
      </div>

      {/* Currency Conversion - when security currency differs from cash account currency */}
      {needsConversion && (needsQuantityPrice || isAmountOnly) && (
        <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('transactionForm.currencyConversion', { from: transactionCurrency, to: cashCurrency })}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <NumericInput
              label={t('transactionForm.exchangeRate', { from: transactionCurrency })}
              suffix={cashCurrency}
              value={watchedExchangeRate || undefined}
              onChange={(value) => {
                const incoming = value ?? 0;
                // The field shows FX_RATE_DISPLAY_DECIMALS (6) but the
                // auto-filled market rate is stored at 10dp (roundFxRate). A
                // blur on an untouched field hands back the 6dp rounding of that
                // value, which is not an edit: adopting it would truncate the
                // stored precision this PR exists to keep and mark the form dirty
                // for a change the user never made. Ignore a re-report that
                // matches the stored rate at the field's display precision.
                if (
                  roundToDecimals(
                    watchedExchangeRate ?? 0,
                    FX_RATE_DISPLAY_DECIMALS,
                  ) === roundToDecimals(incoming, FX_RATE_DISPLAY_DECIMALS)
                ) {
                  return;
                }
                rateEditedRef.current = true;
                setValue('exchangeRate', incoming, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              }}
              decimalPlaces={FX_RATE_DISPLAY_DECIMALS}
              min={0}
              error={errors.exchangeRate?.message}
            />
            <NumericInput
              label={t('transactionForm.convertedTotal')}
              prefix={cashCurrencySymbol}
              value={convertedAmount ?? undefined}
              onChange={handleConvertedAmountChange}
              decimalPlaces={4}
              min={0}
            />
          </div>
          {conversionUnresolved ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {t('transactionForm.exchangeRateUnresolved', {
                from: transactionCurrency,
                to: cashCurrency,
              })}
            </p>
          ) : (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t('transactionForm.conversionHelp')}
            </div>
          )}
        </div>
      )}

      {/* Total Amount Display - meaningless for a transfer (no cash moves) */}
      {(needsQuantityPrice || isAmountOnly) && !isTransferLeg && (
        <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-4">
          {needsQuantityPrice ? (
            // Editable, and authoritative when it is the field being edited:
            // a statement states what a sale came to, and typing a price
            // rounded to the cent instead throws the remainder away (141
            // shares for 820.91 becomes 141 x 5.82 = 820.62). Price and total
            // each follow the other, exactly as the exchange rate and the
            // converted amount above do.
            <NumericInput
              label={t('transactionForm.totalAmount')}
              prefix={currencySymbol}
              value={totalAmount || undefined}
              onChange={handleTotalAmountChange}
              decimalPlaces={4}
              min={0}
            />
          ) : (
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('transactionForm.totalAmount')}
              </span>
              <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {formatCurrency(totalAmount, transactionCurrency)}
              </span>
            </div>
          )}
          {needsQuantityPrice && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('transactionForm.sharesAtPrice', { shares: formatShareQuantity(watchedQuantity), symbol: currencySymbol, price: formatPrice(watchedPrice) })}
              {watchedCommission > 0 && ` ${baseInvestmentAction(watchedAction) === 'SELL' ? '-' : '+'} ${formatCurrency(watchedCommission, transactionCurrency)} ${t('transactionForm.commissionSuffix')}`}
              {supportsAccruedInterest(watchedAction) && watchedAccruedInterest > 0 &&
                ` + ${formatCurrency(watchedAccruedInterest, transactionCurrency)} ${t('transactionForm.accruedInterestSuffix')}`}
            </div>
          )}
          {needsConversion && (
            <div className="mt-2 flex justify-between items-center border-t border-gray-200 pt-2 dark:border-gray-600">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('transactionForm.postsToCashAccount', { currency: cashCurrency })}
              </span>
              <span className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {convertedAmount === null ? (
                  <span className="text-sm font-normal text-gray-400 dark:text-gray-500">
                    {t('transactionForm.notAvailable')}
                  </span>
                ) : (
                  formatCurrency(convertedAmount, cashCurrency)
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Form Actions */}
      <FormActions
        onCancel={onCancel}
        submitLabel={isTransfer ? t('transactionForm.submitTransfer') : transaction ? t('transactionForm.submitUpdate') : t('transactionForm.submitCreate')}
        isSubmitting={isLoading}
        submitOptions={canCreateAnother ? submitOptions : undefined}
        selectedSubmitOptionId={submitMode}
        onSubmitOptionChange={(id) => setSubmitMode(id === 'new' ? 'new' : 'close')}
        submitOptionsLabel={t('transactionForm.submitOptions')}
        submitDisabled={conversionUnresolved}
      />
    </form>

    <Modal isOpen={showSecurityModal} onClose={() => setShowSecurityModal(false)} maxWidth="lg" className="p-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
        {t('transactionForm.newSecurity')}
      </h2>
      <SecurityForm
        onSubmit={handleSecurityCreated}
        onCancel={() => setShowSecurityModal(false)}
      />
    </Modal>
    </>
  );
}

/**
 * The investment transaction form as every caller sees it.
 *
 * Its only job beyond rendering the fields is "Create & New": when the user
 * asks to keep entering, the form has to go back to exactly the state a freshly
 * opened window would be in. The fields component carries a good deal of
 * derived state -- the action, the security, the split-ratio pair, the holding
 * preview, the transfer's linked leg -- so it is restarted by remounting it
 * under a new key rather than by a field-by-field reset that would quietly miss
 * one of them. The account just used is passed back in as the default (the date
 * comes from the same remembered value a fresh open reads), so the next entry
 * starts where the last one left off.
 */
export function InvestmentTransactionForm(props: InvestmentTransactionFormProps) {
  const { onCreateAndNew, defaultAccountId } = props;
  const [restart, setRestart] = useState<{ n: number; accountId: string } | null>(null);

  const handleCreateAnother = useCallback(
    (accountId: string) => {
      setRestart((prev) => ({ n: (prev?.n ?? 0) + 1, accountId }));
      onCreateAndNew?.();
    },
    [onCreateAndNew],
  );

  return (
    <InvestmentTransactionFormFields
      {...props}
      key={restart?.n ?? 0}
      defaultAccountId={restart?.accountId ?? defaultAccountId}
      onCreateAnother={onCreateAndNew ? handleCreateAnother : undefined}
    />
  );
}
