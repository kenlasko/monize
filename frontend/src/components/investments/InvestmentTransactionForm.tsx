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
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { SecurityForm } from '@/components/securities/SecurityForm';
import { investmentsApi } from '@/lib/investments';
import { getLocalDateString } from '@/lib/utils';
import { Account } from '@/types/account';
import {
  InvestmentAction,
  InvestmentTransaction,
  Security,
  CreateSecurityData,
  Holding,
} from '@/types/investment';
import { getCurrencySymbol, roundToDecimals } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateFormat } from '@/hooks/useDateFormat';
import { createLogger } from '@/lib/logger';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const logger = createLogger('InvestmentTxForm');

const investmentTransactionSchema = z.object({
  accountId: z.string().min(1, 'Account is required'),
  // 'TRANSFER' is a UI-only action that creates a TRANSFER_OUT + TRANSFER_IN
  // pair on the backend; it is offered only when creating, not editing.
  action: z.enum(['BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'SPLIT', 'TRANSFER_IN', 'TRANSFER_OUT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES', 'TRANSFER']),
  transactionDate: z.string().min(1, 'Date is required'),
  securityId: z.string().optional(),
  fundingAccountId: z.string().optional(),
  // Destination account for a TRANSFER (the source is `accountId`).
  destinationAccountId: z.string().optional(),
  quantity: z.coerce.number().min(0).optional(),
  price: z.coerce.number().min(0).optional(),
  commission: z.coerce.number().min(0).optional(),
  exchangeRate: z.coerce.number().gt(0).optional(),
  description: z.string().optional(),
  // SPLIT-only fields, combined into `quantity` (the ratio) on submit.
  splitNewShares: z.coerce.number().gt(0).optional(),
  splitOldShares: z.coerce.number().gt(0).optional(),
});

type InvestmentTransactionFormData = z.infer<typeof investmentTransactionSchema>;

interface InvestmentTransactionFormProps {
  accounts: Account[];
  allAccounts?: Account[];  // All accounts for funding dropdown (if not provided, uses accounts)
  transaction?: InvestmentTransaction;
  defaultAccountId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onConversionStateChange?: (needsConversion: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

const actionLabels: Record<InvestmentAction, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  INTEREST: 'Interest',
  CAPITAL_GAIN: 'Capital Gain',
  SPLIT: 'Stock Split',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  REINVEST: 'Reinvest Dividend',
  ADD_SHARES: 'Add Shares',
  REMOVE_SHARES: 'Remove Shares',
};

// Actions that require a security selection. Transfers (the combined create
// action and the TRANSFER_IN/TRANSFER_OUT edit legs) render their own security
// + quantity + cost fields via `transferMode`, so they're excluded here.
const securityRequiredActions: InvestmentAction[] = ['BUY', 'SELL', 'DIVIDEND', 'CAPITAL_GAIN', 'SPLIT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES'];

// Actions that require quantity and price
const quantityPriceActions: InvestmentAction[] = ['BUY', 'SELL', 'REINVEST'];

// Actions that only need quantity (no price, no cash effect)
const quantityOnlyActions: InvestmentAction[] = ['ADD_SHARES', 'REMOVE_SHARES'];

// Actions that only need an amount (no quantity/price)
const amountOnlyActions: InvestmentAction[] = ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN'];

// Actions that can have an external funding account (where funds come from/go to)
const fundingAccountActions: InvestmentAction[] = ['BUY', 'SELL'];

// Actions that deposit cash into an account and can target a destination cash
// account other than the brokerage's linked cash account (e.g. a dividend paid
// directly into a chequing account).
const cashDestinationActions: InvestmentAction[] = ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN'];

// Actions that post a cash transaction against the cash/funding account.
// Only these need exchange rate handling when security and cash currencies differ.
const cashPostingActions: InvestmentAction[] = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'INTEREST',
  'CAPITAL_GAIN',
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

export function InvestmentTransactionForm({
  accounts,
  allAccounts,
  transaction,
  defaultAccountId,
  onSuccess,
  onCancel,
  onDirtyChange,
  onConversionStateChange,
  submitRef,
}: InvestmentTransactionFormProps) {
  const { defaultCurrency, formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [securitiesLoaded, setSecuritiesLoaded] = useState(false);
  const [showSecurityModal, setShowSecurityModal] = useState(false);
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
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<InvestmentTransactionFormData>({
    resolver: zodResolver(investmentTransactionSchema) as Resolver<InvestmentTransactionFormData>,
    defaultValues: transaction
      ? {
          accountId: transaction.accountId,
          action: transaction.action,
          transactionDate: transaction.transactionDate,
          securityId: transaction.securityId || transaction.security?.id || '',
          fundingAccountId: transaction.fundingAccountId || '',
          quantity: transaction.quantity ?? 0,
          // For amount-only actions, use totalAmount as the price field value
          price: amountOnlyActions.includes(transaction.action)
            ? (transaction.totalAmount ?? 0)
            : (transaction.price ?? 0),
          commission: transaction.commission ?? 0,
          exchangeRate: transaction.exchangeRate ?? 1,
          description: transaction.description || '',
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
          transactionDate: getLocalDateString(),
          fundingAccountId: '',
          destinationAccountId: '',
          quantity: undefined,
          price: undefined,
          commission: undefined,
          exchangeRate: undefined,
          description: '',
          splitNewShares: undefined,
          splitOldShares: undefined,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  const watchedAccountId = watch('accountId');
  const watchedAction = watch('action') as InvestmentAction;
  // 'TRANSFER' is a UI-only action and is not part of InvestmentAction, so it
  // never matches any of the classification arrays below; transfer fields are
  // rendered from this flag instead.
  const isTransfer = (watchedAction as string) === 'TRANSFER';
  // Editing an existing transfer leg (the action is one of the real
  // TRANSFER_IN/OUT values, not the UI-only 'TRANSFER').
  const isTransferEditing =
    !!transaction &&
    ((watchedAction as string) === 'TRANSFER_IN' ||
      (watchedAction as string) === 'TRANSFER_OUT');
  // Source-account holdings are relevant both when creating a transfer and when
  // editing one (to validate the available quantity).
  const transferActive = isTransfer || isTransferEditing;
  const watchedSecurityId = watch('securityId');
  const watchedDestinationAccountId = watch('destinationAccountId');
  const watchedFundingAccountId = watch('fundingAccountId');
  const watchedQuantity = Number(watch('quantity')) || 0;
  const watchedPrice = Number(watch('price')) || 0;
  const watchedCommission = Number(watch('commission')) || 0;
  const watchedExchangeRate = Number(watch('exchangeRate')) || 0;
  const watchedTransactionDate = watch('transactionDate');
  const watchedSplitNewShares = Number(watch('splitNewShares')) || 0;
  const watchedSplitOldShares = Number(watch('splitOldShares')) || 0;
  const splitRatio =
    watchedSplitOldShares > 0 ? watchedSplitNewShares / watchedSplitOldShares : 0;

  const allAccountsSource = allAccounts || accounts;
  const { getRate: getMarketRate } = useExchangeRates();

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
      (fundingAccountActions.includes(watchedAction) ||
        cashDestinationActions.includes(watchedAction)) &&
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
  const currencySymbol = getCurrencySymbol(transactionCurrency);
  const cashCurrencySymbol = getCurrencySymbol(cashCurrency);

  const needsConversion =
    cashPostingActions.includes(watchedAction) &&
    !!transactionCurrency &&
    !!cashCurrency &&
    transactionCurrency !== cashCurrency;

  // Notify the parent so it can resize the modal to fit the conversion section
  useEffect(() => {
    onConversionStateChange?.(needsConversion);
  }, [needsConversion, onConversionStateChange]);

  // Calculate total amount
  const totalAmount = useMemo(() => {
    if (quantityPriceActions.includes(watchedAction)) {
      const subtotal = roundToDecimals(watchedQuantity * watchedPrice, 4);
      if (watchedAction === 'BUY' || watchedAction === 'REINVEST') {
        return roundToDecimals(subtotal + watchedCommission, 4);
      } else {
        return roundToDecimals(subtotal - watchedCommission, 4);
      }
    }
    return watchedPrice; // For amount-only actions, price is used as the amount
  }, [watchedAction, watchedQuantity, watchedPrice, watchedCommission]);

  // Auto-fill the exchange rate with the latest market rate whenever the
  // currency pair changes, unless the user is editing an existing transaction
  // (in which case we keep the stored rate) or has manually edited the field.
  //
  // Wait until securities have loaded before running: otherwise, when editing
  // an existing cross-currency transaction, the security isn't in the list
  // yet so transactionCurrency falls back to the account currency, making
  // needsConversion transiently false. Without this guard we'd clobber the
  // stored exchangeRate to 1 here, then replace it with the market default
  // on the next render after securities finish loading.
  useEffect(() => {
    if (!securitiesLoaded) return;
    if (!needsConversion) {
      // When no conversion is needed, keep the rate at 1 implicitly so the
      // backend falls back cleanly.
      if (watchedExchangeRate !== 1) {
        setValue('exchangeRate', 1, { shouldDirty: false });
      }
      return;
    }
    // If form already has a non-default rate (either from editing or user
    // input), don't clobber it.
    if (watchedExchangeRate && watchedExchangeRate !== 1) {
      return;
    }
    const marketRate = getMarketRate(transactionCurrency, cashCurrency);
    if (marketRate && marketRate !== 1) {
      setValue('exchangeRate', roundToDecimals(marketRate, 6), {
        shouldDirty: false,
      });
    }
  }, [
    securitiesLoaded,
    needsConversion,
    transactionCurrency,
    cashCurrency,
    getMarketRate,
    setValue,
    watchedExchangeRate,
  ]);

  const convertedAmount = useMemo(() => {
    if (!needsConversion) return totalAmount;
    const rate = watchedExchangeRate || 1;
    return roundToDecimals(totalAmount * rate, 4);
  }, [needsConversion, totalAmount, watchedExchangeRate]);

  const handleConvertedAmountChange = (value: number | undefined) => {
    if (!needsConversion || totalAmount === 0) return;
    if (value === undefined || value === null) return;
    const newRate = roundToDecimals(value / totalAmount, 10);
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
      !fundingAccountActions.includes(watchedAction) &&
      !cashDestinationActions.includes(watchedAction) &&
      watchedFundingAccountId
    ) {
      setValue('fundingAccountId', '', { shouldDirty: false });
    }
  }, [watchedAction, watchedFundingAccountId, setValue]);

  // Pull the holding state as it was just before this split's transaction
  // date, so the preview's "Before" reflects what the user actually held at
  // that point in time -- not the live holdings (which already include this
  // split and any subsequent activity). Re-fetched whenever the inputs that
  // would change the answer change.
  useEffect(() => {
    if (
      watchedAction !== 'SPLIT' ||
      !watchedAccountId ||
      !watchedSecurityId ||
      !watchedTransactionDate
    ) {
      setSplitHoldingAt(null);
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
  // average cost we use to prefill the cost-per-share.
  useEffect(() => {
    if (!transferActive || !watchedAccountId) {
      setTransferSourceHoldings([]);
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
  // (TRANSFER_IN) account, regardless of which leg was opened.
  useEffect(() => {
    const action = transaction?.action;
    if (
      !transaction ||
      (action !== 'TRANSFER_IN' && action !== 'TRANSFER_OUT') ||
      !transaction.linkedTransactionId
    ) {
      setTransferLinkedLeg(null);
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
      toast.success('Security created');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create security'));
      throw error;
    }
  };

  const onSubmit = async (data: InvestmentTransactionFormData) => {
    setIsLoading(true);
    try {
      if (data.action === 'TRANSFER') {
        const quantity = Number(data.quantity) || 0;
        const costPerShare = Number(data.price) || 0;
        if (!data.securityId) {
          toast.error('Select a security to transfer');
          setIsLoading(false);
          return;
        }
        if (!data.destinationAccountId) {
          toast.error('Select a destination account');
          setIsLoading(false);
          return;
        }
        if (data.destinationAccountId === data.accountId) {
          toast.error('Source and destination accounts must be different');
          setIsLoading(false);
          return;
        }
        if (quantity <= 0) {
          toast.error('Quantity must be greater than zero');
          setIsLoading(false);
          return;
        }
        const available = roundToDecimals(
          Number(selectedTransferHolding?.quantity ?? 0),
          8,
        );
        if (selectedTransferHolding && quantity > available) {
          toast.error(`Only ${available} shares available to transfer`);
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
        toast.success('Securities transferred');
        onSuccess?.();
        return;
      }

      // Editing an existing transfer: update the pair via the source (OUT) leg.
      if (
        transaction &&
        (data.action === 'TRANSFER_IN' || data.action === 'TRANSFER_OUT')
      ) {
        const quantity = Number(data.quantity) || 0;
        const costPerShare = Number(data.price) || 0;
        if (!data.securityId) {
          toast.error('Select a security to transfer');
          setIsLoading(false);
          return;
        }
        if (!data.destinationAccountId) {
          toast.error('Select a destination account');
          setIsLoading(false);
          return;
        }
        if (data.destinationAccountId === data.accountId) {
          toast.error('Source and destination accounts must be different');
          setIsLoading(false);
          return;
        }
        if (quantity <= 0) {
          toast.error('Quantity must be greater than zero');
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
            toast.error(`Only ${available} shares available to transfer`);
            setIsLoading(false);
            return;
          }
        }
        const outLegId =
          data.action === 'TRANSFER_OUT'
            ? transaction.id
            : transferLinkedLeg?.id;
        if (!outLegId) {
          toast.error('Could not load the paired transfer leg; reopen and try again');
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
        });
        toast.success('Transfer updated');
        onSuccess?.();
        return;
      }

      const action = data.action as InvestmentAction;
      const postsCash = cashPostingActions.includes(action);
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
        toast.error('Split ratio must be greater than zero');
        setIsLoading(false);
        return;
      }
      const payload = {
        accountId: data.accountId,
        action,
        transactionDate: data.transactionDate,
        securityId: securityRequiredActions.includes(action)
          ? data.securityId
          : undefined,
        fundingAccountId:
          (fundingAccountActions.includes(action) ||
            cashDestinationActions.includes(action)) &&
          data.fundingAccountId
            ? data.fundingAccountId
            : undefined,
        quantity: isSplit
          ? ratio
          : (quantityPriceActions.includes(action) || quantityOnlyActions.includes(action))
            ? data.quantity
            : undefined,
        price: quantityOnlyActions.includes(action)
          ? undefined
          : isSplit
            ? (data.price && data.price > 0 ? data.price : undefined)
            : data.price,
        commission: quantityOnlyActions.includes(action) || isSplit
          ? undefined
          : data.commission,
        // Only send the exchange rate for actions that post a cash transaction.
        exchangeRate:
          postsCash && data.exchangeRate && data.exchangeRate > 0
            ? data.exchangeRate
            : undefined,
        description: data.description,
      };

      if (transaction) {
        await investmentsApi.updateTransaction(transaction.id, payload);
        toast.success('Transaction updated');
      } else {
        await investmentsApi.createTransaction(payload);
        toast.success('Transaction created');
      }
      onSuccess?.();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save transaction'));
    } finally {
      setIsLoading(false);
    }
  };

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const needsSecurity = securityRequiredActions.includes(watchedAction);
  const needsQuantityPrice = quantityPriceActions.includes(watchedAction);
  const isQuantityOnly = quantityOnlyActions.includes(watchedAction);
  const isAmountOnly = amountOnlyActions.includes(watchedAction);
  const isSplit = watchedAction === 'SPLIT';
  // An individual posted transfer leg (TRANSFER_IN/TRANSFER_OUT). These only
  // appear when editing an existing transfer; the create flow uses the
  // combined 'TRANSFER' action instead.
  const isTransferLeg =
    watchedAction === 'TRANSFER_IN' || watchedAction === 'TRANSFER_OUT';
  // Either creating a transfer (combined action) or editing an existing leg.
  // Both render the From/To + security + quantity + cost-per-share UI.
  const transferMode = isTransfer || isTransferLeg;
  const canHaveFundingAccount = fundingAccountActions.includes(watchedAction);
  const canHaveCashDestination = cashDestinationActions.includes(watchedAction);

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
        { value: 'TRANSFER', label: 'Transfer' },
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
        label={transferMode ? 'From Account' : 'Brokerage Account'}
        error={errors.accountId?.message}
        options={[
          { value: '', label: 'Select account...' },
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
          label="Date"
          error={errors.transactionDate?.message}
          onDateChange={(date) => setValue('transactionDate', date, { shouldDirty: true, shouldValidate: true })}
          {...register('transactionDate')}
        />
        <Select
          label="Transaction Type"
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
          label={watchedAction === 'BUY' ? 'Funds From (optional)' : 'Funds To (optional)'}
          options={[
            { value: '', label: 'Linked cash account (default)' },
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
          label="Deposit To (optional)"
          options={[
            { value: '', label: 'Linked cash account (default)' },
            ...cashDestinationAccountsList.map((a) => ({
              value: a.id,
              label: `${a.name} (${a.currencyCode})`,
            })),
          ]}
          {...register('fundingAccountId')}
        />
      )}

      {/* Destination account - for a transfer between accounts */}
      {transferMode && (
        <Select
          label="To Account"
          error={errors.destinationAccountId?.message}
          options={[
            { value: '', label: 'Select account...' },
            ...destinationAccounts.map((a) => ({
              value: a.id,
              label: `${a.name} (${a.currencyCode})`,
            })),
          ]}
          {...register('destinationAccountId')}
        />
      )}

      {/* Security Selection - only for actions that need it */}
      {(needsSecurity || transferMode) && (
        <div className="space-y-2">
          <Select
            label="Security"
            error={errors.securityId?.message}
            options={[
              {
                value: '',
                label: isTransfer
                  ? watchedAccountId
                    ? transferSecurityOptions.length > 0
                      ? 'Select security...'
                      : 'No securities held in this account'
                    : 'Select the From account first'
                  : 'Select security...',
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
              + Add new security
            </button>
          )}
        </div>
      )}

      {/* Quantity and Price - for buy/sell/reinvest */}
      {needsQuantityPrice && (
        <div className={`grid gap-4 ${needsConversion ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <NumericInput
            label="Quantity (Shares)"
            value={watchedQuantity || undefined}
            onChange={(value) => setValue('quantity', value, { shouldValidate: true })}
            decimalPlaces={8}
            min={0}
            error={errors.quantity?.message}
          />
          <NumericInput
            label={`Price per Share (${transactionCurrency})`}
            prefix={currencySymbol}
            value={watchedPrice || undefined}
            onChange={(value) => setValue('price', value, { shouldValidate: true })}
            decimalPlaces={6}
            min={0}
            error={errors.price?.message}
          />
          {needsConversion && (
            <CurrencyInput
              label={`Commission / Fees (${transactionCurrency})`}
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
          label="Quantity (Shares)"
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
            Split ratio
          </div>
          {transaction && !watchedSplitNewShares && !watchedSplitOldShares && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              No split ratio is set on this transaction. Enter the ratio as it was
              announced before saving — Monize won&apos;t assume one for you.
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <NumericInput
              label="New shares"
              value={watchedSplitNewShares || undefined}
              onChange={(value) =>
                setValue('splitNewShares', value, { shouldDirty: true, shouldValidate: true })
              }
              decimalPlaces={8}
              min={0}
              error={errors.splitNewShares?.message}
            />
            <NumericInput
              label="Old shares"
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
            Enter the ratio as it was announced. For a 2-for-1 split use 2 new and 1 old;
            for a 1-for-2 reverse split use 1 new and 2 old. Effective ratio:{' '}
            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">
              {splitRatio > 0 ? splitRatio.toFixed(6) : '–'}
            </span>
          </div>
          <NumericInput
            label={`New price per share, after split (${transactionCurrency}, optional)`}
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
                Holding preview
              </div>
              <div>
                Before (as of {formatDate(watchedTransactionDate)}):{' '}
                <span className="font-mono">
                  {splitPreview.currentQty.toFixed(4)}
                </span>{' '}
                shares @{' '}
                <span className="font-mono">
                  {currencySymbol}
                  {splitPreview.currentAvg.toFixed(4)}
                </span>{' '}
                avg cost
              </div>
              <div>
                After:{' '}
                <span className="font-mono">
                  {splitPreview.newQty.toFixed(4)}
                </span>{' '}
                shares @{' '}
                <span className="font-mono">
                  {currencySymbol}
                  {splitPreview.newAvg.toFixed(4)}
                </span>{' '}
                avg cost
              </div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Total cost basis is preserved across the split.
              </div>
            </div>
          )}
          {!splitPreview && watchedSecurityId && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              No shares of this security were held in this account on{' '}
              {formatDate(watchedTransactionDate)}; the split will be recorded
              but won&apos;t change holdings until shares are added on or
              before that date.
            </div>
          )}
        </div>
      )}

      {/* Amount - for dividend/interest/capital gain/transfers */}
      {isAmountOnly && (
        <CurrencyInput
          label={`Amount (${transactionCurrency})`}
          prefix={currencySymbol}
          value={watchedPrice || undefined}
          onChange={(value) => setValue('price', value, { shouldValidate: true })}
          error={errors.price?.message}
          allowNegative={false}
        />
      )}

      {/* Quantity and cost basis - for a transfer between accounts */}
      {transferMode && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <NumericInput
              label="Quantity (Shares)"
              value={watchedQuantity || undefined}
              onChange={(value) => setValue('quantity', value, { shouldValidate: true })}
              decimalPlaces={8}
              min={0}
              error={errors.quantity?.message}
            />
            <NumericInput
              label={`Cost per Share (${transactionCurrency})`}
              prefix={currencySymbol}
              value={watchedPrice || undefined}
              onChange={(value) => setValue('price', value, { shouldValidate: true })}
              decimalPlaces={6}
              min={0}
              error={errors.price?.message}
            />
          </div>
          {selectedTransferHolding &&
            Number(selectedTransferHolding.quantity) > 0 && (
              <div className="rounded border border-gray-200 bg-white p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
                Source holds{' '}
                <span className="font-mono">
                  {Number(selectedTransferHolding.quantity).toFixed(4)}
                </span>{' '}
                shares @{' '}
                <span className="font-mono">
                  {currencySymbol}
                  {Number(selectedTransferHolding.averageCost ?? 0).toFixed(4)}
                </span>{' '}
                avg cost.
              </div>
            )}
          <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200">
            The cost per share (prefilled from the source account) is carried to
            the destination so your gain and profit reports stay correct. This
            moves shares only -- no cash changes hands.
          </div>
        </div>
      )}

      {/* Commission - rendered inline with qty/price when conversion is shown */}
      {needsQuantityPrice && !needsConversion && (
        <CurrencyInput
          label={`Commission / Fees (${transactionCurrency})`}
          prefix={currencySymbol}
          value={watchedCommission || undefined}
          onChange={(value) => setValue('commission', value, { shouldValidate: true })}
          error={errors.commission?.message}
          allowNegative={false}
        />
      )}

      {/* Description */}
      <Input
        label="Description (optional)"
        placeholder="Optional notes"
        error={errors.description?.message}
        {...register('description')}
      />

      {/* Currency Conversion - when security currency differs from cash account currency */}
      {needsConversion && (needsQuantityPrice || isAmountOnly) && (
        <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Currency conversion ({transactionCurrency} &rarr; {cashCurrency})
          </div>
          <div className="grid grid-cols-2 gap-4">
            <NumericInput
              label={`Exchange rate (1 ${transactionCurrency} =)`}
              suffix={cashCurrency}
              value={watchedExchangeRate || undefined}
              onChange={(value) =>
                setValue('exchangeRate', value ?? 0, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
              decimalPlaces={6}
              min={0}
              error={errors.exchangeRate?.message}
            />
            <NumericInput
              label={`Converted total (${cashCurrency})`}
              prefix={cashCurrencySymbol}
              value={convertedAmount || undefined}
              onChange={handleConvertedAmountChange}
              decimalPlaces={4}
              min={0}
            />
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Adjust the rate or the converted total to match the amount actually posted to your cash account.
          </div>
        </div>
      )}

      {/* Total Amount Display - meaningless for a transfer (no cash moves) */}
      {(needsQuantityPrice || isAmountOnly) && !isTransferLeg && (
        <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Total Amount ({transactionCurrency})
            </span>
            <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {formatCurrency(totalAmount, transactionCurrency)}
            </span>
          </div>
          {needsQuantityPrice && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {watchedQuantity} shares @ {currencySymbol}{watchedPrice.toFixed(6)}
              {watchedCommission > 0 && ` ${watchedAction === 'SELL' ? '-' : '+'} ${formatCurrency(watchedCommission, transactionCurrency)} commission`}
            </div>
          )}
          {needsConversion && (
            <div className="mt-2 flex justify-between items-center border-t border-gray-200 pt-2 dark:border-gray-600">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Posts to cash account ({cashCurrency})
              </span>
              <span className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {formatCurrency(convertedAmount, cashCurrency)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Form Actions */}
      <FormActions onCancel={onCancel} submitLabel={isTransfer ? 'Transfer Securities' : transaction ? 'Update Transaction' : 'Create Transaction'} isSubmitting={isLoading} />
    </form>

    <Modal isOpen={showSecurityModal} onClose={() => setShowSecurityModal(false)} maxWidth="lg" className="p-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
        New Security
      </h2>
      <SecurityForm
        onSubmit={handleSecurityCreated}
        onCancel={() => setShowSecurityModal(false)}
      />
    </Modal>
    </>
  );
}
