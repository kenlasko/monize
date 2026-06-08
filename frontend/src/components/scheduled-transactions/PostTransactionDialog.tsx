'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Combobox } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows } from '@/components/transactions/SplitEditor';
import { toOverrideSplits } from './splitSerialization';
import { ScheduledTransaction, PostScheduledTransactionData } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { getLocalDateString } from '@/lib/utils';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents, getCurrencySymbol } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getProjectedBalanceAtDate, FutureTransaction } from '@/lib/forecast';
import { computeInvestmentCashImpact } from '@/lib/investmentCashImpact';
import { InvestmentAction } from '@/types/investment';

const logger = createLogger('PostTransactionDialog');

// Liability accounts normally carry negative balances — only warn if over credit limit
const LIABILITY_TYPES = new Set(['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT']);

function isLiabilityAccount(account: Account): boolean {
  return LIABILITY_TYPES.has(account.accountType);
}

/** Returns true when a projected balance should trigger a warning for the given account. */
function shouldWarnBalance(account: Account, projectedBalance: number): boolean {
  if (isLiabilityAccount(account)) {
    // Liability accounts: only warn if the balance exceeds the credit limit (if set)
    if (account.creditLimit != null && account.creditLimit > 0) {
      // Balance is negative, credit limit is positive — warn when balance is more negative than -creditLimit
      return projectedBalance < -account.creditLimit;
    }
    // No credit limit set — no warning for liability accounts
    return false;
  }
  // Asset accounts: warn if balance goes negative
  return projectedBalance < 0;
}

interface PostTransactionDialogProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  categories: Category[];
  accounts: Account[];
  scheduledTransactions: ScheduledTransaction[];
  futureTransactions: FutureTransaction[];
  onClose: () => void;
  onPosted: () => void;
}

export function PostTransactionDialog({
  isOpen,
  scheduledTransaction,
  categories,
  accounts,
  scheduledTransactions,
  futureTransactions,
  onClose,
  onPosted,
}: PostTransactionDialogProps) {
  const t = useTranslations('scheduledTransactions');
  const tc = useTranslations('common');
  const { formatCurrency, formatNumber } = useNumberFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [amount, setAmount] = useState<number>(0);
  const [categoryId, setCategoryId] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isSplit, setIsSplit] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);
  const [transactionDate, setTransactionDate] = useState<string>('');
  const [referenceNumber, setReferenceNumber] = useState<string>('');

  // Investment-mode per-occurrence overrides
  const [investmentQuantity, setInvestmentQuantity] = useState<number | ''>('');
  const [investmentPrice, setInvestmentPrice] = useState<number | ''>('');
  const [investmentTotalAmount, setInvestmentTotalAmount] = useState<number | ''>('');
  // UI-only computed total for qty+price actions (qty * price + commission).
  // Not sent to the backend -- the API derives the total from qty/price/commission.
  const [investmentTotalValue, setInvestmentTotalValue] = useState<number | ''>('');
  const [marketPrice, setMarketPrice] = useState<number | null>(null);

  const isInvestmentKind = scheduledTransaction.isInvestment;
  const investmentAction = scheduledTransaction.investmentAction;
  const isInvestmentQuantityPrice = isInvestmentKind &&
    (investmentAction === 'BUY' || investmentAction === 'SELL' || investmentAction === 'REINVEST');
  const isInvestmentQuantityOnly = isInvestmentKind &&
    (investmentAction === 'ADD_SHARES' || investmentAction === 'REMOVE_SHARES' || investmentAction === 'SPLIT');
  const isInvestmentAmountOnly = isInvestmentKind &&
    (investmentAction === 'DIVIDEND' || investmentAction === 'INTEREST' || investmentAction === 'CAPITAL_GAIN');

  const todayStr = useMemo(() => getLocalDateString(), []);

  const sourceAccount = useMemo(() => {
    // For investment-kind rows, the cash side -- not the brokerage -- is what
    // moves. Pick the funding account if the user explicitly set one
    // (contribution+buy from a checking account), otherwise the brokerage's
    // paired INVESTMENT_CASH account. Fall back to the brokerage only if no
    // pair exists, so we still show *something* useful.
    if (scheduledTransaction.isInvestment) {
      if (scheduledTransaction.investmentFundingAccountId) {
        return (
          accounts.find(
            (a) => a.id === scheduledTransaction.investmentFundingAccountId,
          ) ??
          scheduledTransaction.investmentFundingAccount ??
          null
        );
      }
      const brokerage = accounts.find(
        (a) => a.id === scheduledTransaction.accountId,
      );
      if (brokerage?.linkedAccountId) {
        const cash = accounts.find(
          (a) => a.id === brokerage.linkedAccountId,
        );
        if (cash) return cash;
      }
      return brokerage ?? scheduledTransaction.account ?? null;
    }
    return scheduledTransaction.account
      ? accounts.find((a) => a.id === scheduledTransaction.accountId) ??
          scheduledTransaction.account
      : null;
  }, [
    accounts,
    scheduledTransaction.account,
    scheduledTransaction.accountId,
    scheduledTransaction.isInvestment,
    scheduledTransaction.investmentFundingAccountId,
    scheduledTransaction.investmentFundingAccount,
  ]);
  const transferAccount = scheduledTransaction.isTransfer && scheduledTransaction.transferAccount
    ? accounts.find(a => a.id === scheduledTransaction.transferAccountId) ?? scheduledTransaction.transferAccount
    : null;

  // The cash impact that will actually post -- reflects per-occurrence edits
  // the user makes here, not just the base scheduled transaction's amount.
  // For investments we re-derive from the current quantity / price / total so
  // the projected-balance header updates as the user types.
  const effectivePostAmount = useMemo(() => {
    if (!isInvestmentKind) return amount;
    if (!investmentAction) return 0;
    if (isInvestmentAmountOnly) {
      return investmentTotalAmount === '' ? 0 : Number(investmentTotalAmount);
    }
    if (isInvestmentQuantityPrice) {
      const qty = investmentQuantity === '' ? 0 : Number(investmentQuantity);
      const price = investmentPrice === '' ? 0 : Number(investmentPrice);
      const commission = Number(scheduledTransaction.investmentCommission ?? 0);
      return computeInvestmentCashImpact(
        investmentAction as InvestmentAction,
        qty,
        price,
        commission,
      );
    }
    // ADD_SHARES / REMOVE_SHARES / SPLIT -- shares move, no cash impact.
    return 0;
  }, [
    isInvestmentKind,
    isInvestmentAmountOnly,
    isInvestmentQuantityPrice,
    investmentAction,
    investmentQuantity,
    investmentPrice,
    investmentTotalAmount,
    scheduledTransaction.investmentCommission,
    amount,
  ]);

  const projectedBalances = useMemo(() => {
    if (!transactionDate) return null;
    const sourceBefore = sourceAccount
      ? getProjectedBalanceAtDate(sourceAccount, transactionDate, scheduledTransactions, futureTransactions, scheduledTransaction.id, accounts)
      : null;
    const transferBefore = transferAccount
      ? getProjectedBalanceAtDate(transferAccount, transactionDate, scheduledTransactions, futureTransactions, scheduledTransaction.id, accounts)
      : null;
    return {
      sourceBefore,
      sourceAfter: sourceBefore != null ? roundToCents(sourceBefore + effectivePostAmount) : null,
      transferBefore,
      transferAfter: transferBefore != null ? roundToCents(transferBefore - effectivePostAmount) : null,
    };
  }, [sourceAccount, transferAccount, transactionDate, effectivePostAmount, scheduledTransactions, futureTransactions, scheduledTransaction.id, accounts]);

  // Initialize form with transaction values (including override if exists)
  useEffect(() => {
    if (isOpen) {
      const nextOverride = scheduledTransaction.nextOverride;

      // Use override values if they exist, otherwise use base transaction values
      const amt = roundToCents(
        nextOverride?.amount ?? scheduledTransaction.amount
      );
      setAmount(amt);
      setCategoryId(nextOverride?.categoryId ?? scheduledTransaction.categoryId ?? '');
      setDescription(nextOverride?.description ?? scheduledTransaction.description ?? '');
      setIsSplit(nextOverride?.isSplit ?? scheduledTransaction.isSplit);

      setReferenceNumber('');

      // Set transaction date: use override date if modified, otherwise next due date
      const nextDueDate = (nextOverride?.overrideDate ?? scheduledTransaction.nextDueDate).split('T')[0];
      setTransactionDate(nextDueDate);

      // Initialize splits
      if ((nextOverride?.isSplit ?? scheduledTransaction.isSplit)) {
        if (nextOverride?.splits && nextOverride.splits.length > 0) {
          setSplits(toSplitRows(nextOverride.splits.map((s, i) => ({
            id: `override-${i}`,
            ...s,
          }))));
        } else if (scheduledTransaction.splits && scheduledTransaction.splits.length > 0) {
          setSplits(toSplitRows(scheduledTransaction.splits));
        } else {
          setSplits(createEmptySplits(amt));
        }
      } else {
        setSplits(createEmptySplits(amt));
      }

      // Investment-kind: prefill from the next-occurrence override if one
      // exists, falling back to the base scheduled transaction's saved values.
      // Without the override fallback, a user who has tweaked the upcoming
      // occurrence (e.g. a one-off DRIP buy at a different quantity) sees the
      // original numbers in the Post dialog.
      const overrideQty = nextOverride?.investmentQuantity;
      const overridePrice = nextOverride?.investmentPrice;
      const overrideTotal = nextOverride?.investmentTotalAmount;
      const initialQty =
        overrideQty != null
          ? Number(overrideQty)
          : scheduledTransaction.investmentQuantity != null
            ? Number(scheduledTransaction.investmentQuantity)
            : '';
      const initialPrice =
        overridePrice != null
          ? Number(overridePrice)
          : scheduledTransaction.investmentPrice != null
            ? Number(scheduledTransaction.investmentPrice)
            : '';
      setInvestmentQuantity(initialQty);
      setInvestmentPrice(initialPrice);
      setInvestmentTotalAmount(
        overrideTotal != null
          ? Number(overrideTotal)
          : scheduledTransaction.investmentTotalAmount != null
            ? Number(scheduledTransaction.investmentTotalAmount)
            : '',
      );
      // Seed the UI-only total. Prefer the originally-scheduled total (override
      // or base) so it stays fixed when the latest market price is applied --
      // the price change should move the share quantity, not the amount
      // invested. Fall back to qty * price (+ signed commission) only when no
      // total was scheduled.
      const storedTotal =
        overrideTotal != null
          ? Number(overrideTotal)
          : scheduledTransaction.investmentTotalAmount != null
            ? Number(scheduledTransaction.investmentTotalAmount)
            : null;
      if (storedTotal != null && storedTotal > 0) {
        setInvestmentTotalValue(Math.round(storedTotal * 10_000) / 10_000);
      } else if (
        typeof initialQty === 'number' &&
        initialQty > 0 &&
        typeof initialPrice === 'number' &&
        initialPrice > 0
      ) {
        const commission = Number(scheduledTransaction.investmentCommission ?? 0);
        const sign = scheduledTransaction.investmentAction === 'SELL' ? -1 : 1;
        const total = initialQty * initialPrice + sign * commission;
        setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
      } else {
        setInvestmentTotalValue('');
      }
      setMarketPrice(null);
    }
  }, [isOpen, scheduledTransaction]);

  // Fetch the most recent close price for the security so we can auto-fill
  // the Price field (matching the new-scheduled-transaction form's behaviour).
  useEffect(() => {
    if (!isOpen || !isInvestmentKind || !isInvestmentQuantityPrice) return;
    const securityId = scheduledTransaction.investmentSecurityId;
    if (!securityId) return;
    let cancelled = false;
    investmentsApi
      .getSecurityPrices(securityId, 1)
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
  }, [
    isOpen,
    isInvestmentKind,
    isInvestmentQuantityPrice,
    scheduledTransaction.investmentSecurityId,
  ]);

  // When the market price arrives, overwrite the Price with the latest value.
  // The originally-scheduled total stays fixed, so the new price recomputes the
  // share quantity rather than the amount invested. Uses the "info from
  // previous render" pattern to avoid violating react-hooks/set-state-in-effect.
  const [lastSeenMarketPrice, setLastSeenMarketPrice] = useState<number | null>(null);
  if (isOpen && marketPrice !== lastSeenMarketPrice) {
    setLastSeenMarketPrice(marketPrice);
    if (isInvestmentQuantityPrice && marketPrice != null && marketPrice > 0) {
      const rounded = Math.round(marketPrice * 1_000_000) / 1_000_000;
      setInvestmentPrice(rounded);
      const commission = Number(scheduledTransaction.investmentCommission ?? 0);
      const sign = scheduledTransaction.investmentAction === 'SELL' ? -1 : 1;
      if (investmentTotalValue !== '' && Number(investmentTotalValue) > 0) {
        // Preserve the scheduled total -- adjust quantity to the new price.
        const cost = Number(investmentTotalValue) - sign * commission;
        const qty = Math.max(0, cost / rounded);
        setInvestmentQuantity(Math.round(qty * 100_000_000) / 100_000_000);
      } else if (investmentQuantity !== '' && Number(investmentQuantity) > 0) {
        // No scheduled total to preserve -- fall back to deriving it from qty.
        const total = Number(investmentQuantity) * rounded + sign * commission;
        setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
      }
    }
  }

  const investmentSign = scheduledTransaction.investmentAction === 'SELL' ? -1 : 1;
  const investmentCommission = Number(scheduledTransaction.investmentCommission ?? 0);

  const handleInvestmentQuantityChange = (raw: string) => {
    const qty = raw === '' ? '' : Number(raw);
    setInvestmentQuantity(qty);
    if (qty !== '' && investmentPrice !== '' && Number(investmentPrice) > 0) {
      const total = Number(qty) * Number(investmentPrice) + investmentSign * investmentCommission;
      setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
    }
  };

  const handleInvestmentPriceChange = (raw: string) => {
    const price = raw === '' ? '' : Number(raw);
    setInvestmentPrice(price);
    if (price !== '' && Number(price) > 0) {
      if (investmentTotalValue !== '') {
        // User has a target total -- keep it and derive quantity.
        const cost = Number(investmentTotalValue) - investmentSign * investmentCommission;
        const qty = Math.max(0, cost / Number(price));
        setInvestmentQuantity(Math.round(qty * 100_000_000) / 100_000_000);
      } else if (investmentQuantity !== '') {
        const total = Number(investmentQuantity) * Number(price) + investmentSign * investmentCommission;
        setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
      }
    }
  };

  const handleInvestmentTotalValueChange = (raw: number | undefined) => {
    if (raw === undefined) {
      setInvestmentTotalValue('');
      return;
    }
    setInvestmentTotalValue(raw);
    if (investmentPrice !== '' && Number(investmentPrice) > 0) {
      const cost = raw - investmentSign * investmentCommission;
      const qty = Math.max(0, cost / Number(investmentPrice));
      setInvestmentQuantity(Math.round(qty * 100_000_000) / 100_000_000);
    }
  };

  const categoryOptions = useMemo(() => {
    return buildCategoryTree(categories).map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    });
  }, [categories]);

  const handlePost = async () => {
    if (isInvestmentKind) {
      if (isInvestmentQuantityPrice || isInvestmentQuantityOnly) {
        if (investmentQuantity === '' || Number(investmentQuantity) <= 0) {
          toast.error(t('postDialog.toasts.quantityRequired'));
          return;
        }
      }
      if (isInvestmentQuantityPrice) {
        if (investmentPrice === '' || Number(investmentPrice) <= 0) {
          toast.error(t('postDialog.toasts.priceRequired'));
          return;
        }
      }
      if (isInvestmentAmountOnly) {
        if (investmentTotalAmount === '') {
          toast.error(t('postDialog.toasts.totalAmountRequired'));
          return;
        }
      }
    } else if (isSplit) {
      if (splits.length < 2) {
        toast.error(t('postTransaction.minSplits'));
        return;
      }
      const splitsTotal = splits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
      const remaining = Math.abs(amount - splitsTotal);
      if (remaining >= 0.01) {
        toast.error(t('postTransaction.splitMismatch'));
        return;
      }
    }

    setIsLoading(true);
    try {
      const postData: PostScheduledTransactionData = isInvestmentKind
        ? {
            transactionDate,
            description: description || null,
            investmentQuantity:
              investmentQuantity === '' ? undefined : Number(investmentQuantity),
            investmentPrice:
              investmentPrice === '' ? undefined : Number(investmentPrice),
            investmentTotalAmount:
              investmentTotalAmount === '' ? undefined : Number(investmentTotalAmount),
          }
        : {
            transactionDate,
            amount,
            categoryId: isSplit ? null : (categoryId || null),
            description: description || null,
            referenceNumber: referenceNumber || undefined,
            isSplit,
            splits: isSplit ? toOverrideSplits(splits) : undefined,
          };

      await scheduledTransactionsApi.post(scheduledTransaction.id, postData);
      toast.success(t('postDialog.toasts.posted'));
      onPosted();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('postDialog.toasts.postFailed')));
    } finally {
      setIsLoading(false);
    }
  };

  const handleAmountChange = (newAmount: number) => {
    setAmount(roundToCents(newAmount));
  };

  const currentCategory = categoryId ? categories.find(c => c.id === categoryId) : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="5xl" className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {t('postDialog.title')}
        </h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {isInvestmentKind ? (
          <>
{t('postDialog.descriptionInvestment', { action: investmentAction || 'investment', security: scheduledTransaction.investmentSecurity?.symbol || scheduledTransaction.investmentSecurity?.name || '', account: scheduledTransaction.account?.name || '' })}
          </>
        ) : scheduledTransaction.isTransfer ? (
          <>
{t('postDialog.descriptionTransfer', { name: scheduledTransaction.name, sourceAccount: scheduledTransaction.account?.name || '', targetAccount: scheduledTransaction.transferAccount?.name || '' })}
          </>
        ) : (
          <>
{t('postDialog.descriptionRegular', { name: scheduledTransaction.name, account: scheduledTransaction.account?.name || '' })}
          </>
        )}
      </div>

      {/* Account balance info */}
      {projectedBalances && sourceAccount && (
        <div className="bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg p-3 mb-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">{sourceAccount.name}</span>
            <span className="text-gray-500 dark:text-gray-400">
              {formatCurrency(projectedBalances.sourceBefore!, scheduledTransaction.currencyCode)}
              {' → '}
              <span className={projectedBalances.sourceAfter! < projectedBalances.sourceBefore! ? 'text-red-600 dark:text-red-400 font-medium' : 'text-green-600 dark:text-green-400 font-medium'}>
                {formatCurrency(projectedBalances.sourceAfter!, scheduledTransaction.currencyCode)}
              </span>
            </span>
          </div>
          {transferAccount && projectedBalances.transferBefore != null && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">{transferAccount.name}</span>
              <span className="text-gray-500 dark:text-gray-400">
                {formatCurrency(projectedBalances.transferBefore, scheduledTransaction.currencyCode)}
                {' → '}
                <span className={projectedBalances.transferAfter! > projectedBalances.transferBefore ? 'text-green-600 dark:text-green-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
                  {formatCurrency(projectedBalances.transferAfter!, scheduledTransaction.currencyCode)}
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Balance warning — for asset accounts: below zero; for liability accounts: over credit limit */}
      {(() => {
        if (!projectedBalances) return null;
        const sourceWarn = sourceAccount && projectedBalances.sourceAfter != null && shouldWarnBalance(sourceAccount, projectedBalances.sourceAfter);
        const transferWarn = transferAccount && projectedBalances.transferAfter != null && shouldWarnBalance(transferAccount, projectedBalances.transferAfter);
        if (!sourceWarn && !transferWarn) return null;

        const warningLabel = (account: Account) =>
          isLiabilityAccount(account) ? 'over the credit limit' : 'below zero';

        return (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg p-3 mb-4 flex items-start gap-2">
            <svg className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="text-sm text-amber-700 dark:text-amber-300">
              {sourceWarn && transferWarn ? (
                <>
                  Posting on this date will bring <span className="font-medium">{sourceAccount?.name}</span> to{' '}
                  <span className="font-medium">{formatCurrency(projectedBalances.sourceAfter!, scheduledTransaction.currencyCode)}</span> ({warningLabel(sourceAccount!)}) and{' '}
                  <span className="font-medium">{transferAccount?.name}</span> to{' '}
                  <span className="font-medium">{formatCurrency(projectedBalances.transferAfter!, scheduledTransaction.currencyCode)}</span> ({warningLabel(transferAccount!)}).
                </>
              ) : sourceWarn ? (
                <>
                  Posting on this date will bring <span className="font-medium">{sourceAccount?.name}</span> to{' '}
                  <span className="font-medium">{formatCurrency(projectedBalances.sourceAfter!, scheduledTransaction.currencyCode)}</span>, {warningLabel(sourceAccount!)}.
                </>
              ) : (
                <>
                  Posting on this date will bring <span className="font-medium">{transferAccount?.name}</span> to{' '}
                  <span className="font-medium">{formatCurrency(projectedBalances.transferAfter!, scheduledTransaction.currencyCode)}</span>, {warningLabel(transferAccount!)}.
                </>
              )}
            </div>
          </div>
        );
      })()}

      <div className="space-y-4">
        {/* Transaction Date */}
        <div>
          <div className="flex items-center gap-2">
            <DateInput
              label={t('postDialog.transactionDateLabel')}
              value={transactionDate}
              onDateChange={(date) => setTransactionDate(date)}
            />
            {transactionDate !== todayStr && (
              <button
                type="button"
                onClick={() => setTransactionDate(todayStr)}
                className="shrink-0 mt-6 px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
              >
                {t('postDialog.todayButton')}
              </button>
            )}
          </div>
        </div>

        {/* Investment-kind: action-specific overrides */}
        {isInvestmentKind && (
          <>
            {(isInvestmentQuantityPrice || isInvestmentQuantityOnly) && (
              <Input
                label={t('postDialog.quantityLabel')}
                type="number"
                step="0.00000001"
                min={0}
                value={investmentQuantity}
                onChange={(e) =>
                  isInvestmentQuantityPrice
                    ? handleInvestmentQuantityChange(e.target.value)
                    : setInvestmentQuantity(
                        e.target.value === '' ? '' : Number(e.target.value),
                      )
                }
              />
            )}
            {isInvestmentQuantityPrice && (
              <>
                <Input
                  label={t('postDialog.pricePerShareLabel')}
                  type="number"
                  step="0.000001"
                  min={0}
                  placeholder={
                    marketPrice != null
                      ? t('postDialog.latestPlaceholder', { price: formatNumber(marketPrice, 6).replace(/0+$/, '').replace(/\.$/, '') })
                      : undefined
                  }
                  value={investmentPrice}
                  onChange={(e) => handleInvestmentPriceChange(e.target.value)}
                />
                <CurrencyInput
                  label={t('postDialog.totalPriceLabel')}
                  prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                  value={
                    typeof investmentTotalValue === 'number'
                      ? investmentTotalValue
                      : undefined
                  }
                  onChange={handleInvestmentTotalValueChange}
                />
                {scheduledTransaction.investmentSecurityId && marketPrice == null && (
                  <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {t('postDialog.noPriceHistory')}
                  </p>
                )}
              </>
            )}
            {isInvestmentAmountOnly && (
              <CurrencyInput
                label={t('postDialog.totalAmountLabel')}
                prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                value={typeof investmentTotalAmount === 'number' ? investmentTotalAmount : undefined}
                onChange={(value) => setInvestmentTotalAmount(value ?? '')}
              />
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('postDialog.descriptionLabel')}
              </label>
              <Input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('postDialog.descriptionPlaceholder')}
              />
            </div>
          </>
        )}

        {/* Amount — non-investment only */}
        {!isInvestmentKind && (
        <CurrencyInput
          label={t('postDialog.amountLabel')}
          prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
          value={amount}
          onChange={(value) => setAmount(value ?? 0)}
        />
        )}

        {/* Transfer indicator - shown instead of category for transfers */}
        {!isInvestmentKind && (
        scheduledTransaction.isTransfer ? (
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg p-4">
            <div className="flex items-center">
              <svg className="h-5 w-5 text-blue-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                Transfer: {scheduledTransaction.account?.name} → {scheduledTransaction.transferAccount?.name}
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* Split toggle */}
            <div className="flex items-center">
              <input
                type="checkbox"
                id="isSplit"
                checked={isSplit}
                onChange={(e) => {
                  setIsSplit(e.target.checked);
                  if (e.target.checked && splits.length < 2) {
                    setSplits(createEmptySplits(amount));
                  }
                }}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="isSplit" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                {t('postDialog.splitLabel')}
              </label>
            </div>

            {/* Category or Splits */}
            {isSplit ? (
              <SplitEditor
                splits={splits}
                onChange={setSplits}
                categories={categories}
                accounts={accounts}
                sourceAccountId={scheduledTransaction.accountId}
                parentAccountSubType={
                  accounts.find((a) => a.id === scheduledTransaction.accountId)
                    ?.accountSubType ?? null
                }
                transactionAmount={amount}
                onTransactionAmountChange={handleAmountChange}
                currencyCode={scheduledTransaction.currencyCode}
              />
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('postDialog.categoryLabel')}
                </label>
                <Combobox
                  placeholder={t('postDialog.selectCategoryPlaceholder')}
                  options={categoryOptions}
                  value={categoryId}
                  initialDisplayValue={currentCategory?.name || ''}
                  onChange={(value) => setCategoryId(value || '')}
                />
              </div>
            )}
          </>
        )
        )}

        {/* Description and Reference Number — non-investment only (investment renders description in its own block) */}
        {!isInvestmentKind && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Description (optional)
            </label>
            <Input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('postDialog.descriptionPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('postDialog.referenceNumberLabel')}
            </label>
            <Input
              type="text"
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder={t('postDialog.referencePlaceholder')}
            />
          </div>
        </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-6 flex justify-end space-x-3">
        <Button variant="outline" onClick={onClose} disabled={isLoading}>
          {tc('cancel')}
        </Button>
        <Button onClick={handlePost} isLoading={isLoading}>
          {t('postDialog.postButton')}
        </Button>
      </div>
    </Modal>
  );
}
