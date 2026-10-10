'use client';

import { useState, useEffect, useMemo } from 'react';
import { baseInvestmentAction } from '@/lib/investment-actions';
import { InvestmentAction } from '@/types/investment';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Combobox } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows } from '@/components/transactions/SplitEditor';
import { toOverrideSplits } from './splitSerialization';
import { bookSplitRowsAtMinorUnit } from '@/lib/minor-unit-booking';
import {
  LoanOccurrenceMissing,
  ScheduledTransaction,
  ScheduledTransactionOverride,
  SelectedLoanOccurrence,
} from '@/types/scheduled-transaction';
import { loanOccurrenceLines } from '@/lib/loan-occurrence';
import { useLoanOccurrenceMissingText } from './useLoanOccurrenceMissingText';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { totalFromQuantity, quantityFromTotal, roundPrice, usableClose } from '@/lib/investmentFold';
import { roundToCents, getCurrencySymbol } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { TRANSACTION_NOTE_MAX_LENGTH } from '@/lib/transaction-note';

const logger = createLogger('OverrideEditorDialog');
interface OverrideEditorDialogProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  overrideDate: string;
  categories: Category[];
  accounts: Account[];
  existingOverride?: ScheduledTransactionOverride | null;
  // When provided, seeds the Amount field with this value (absolute, sign is
  // applied on save for transfers) instead of the base/override amount. Used by
  // the post-reconciliation flow to prefill a liability payment with the
  // reconciled balance.
  prefillAmount?: number | null;
  /**
   * For a loan bill, the occurrence as the server priced it at its own due
   * date (INV-LOAN-009): the dialog opens on its amount and its principal,
   * interest and extra principal lines, never the template's. An override
   * with lines of its own keeps them; `prefillAmount` outranks it.
   */
  loanOccurrence?: SelectedLoanOccurrence | null;
  onClose: () => void;
  onSave: () => void;
  /**
   * Create a category from text typed into any of this dialog's category
   * pickers -- the Category field and each split line's own -- resolving to the
   * created category. The page owns the category list, so it owns the creation.
   * When omitted the pickers only select from what already exists.
   */
  onCreateCategory?: (name: string) => Promise<Category | null | undefined>;
}

export function OverrideEditorDialog({
  isOpen,
  scheduledTransaction,
  overrideDate,
  categories,
  accounts,
  existingOverride,
  prefillAmount,
  loanOccurrence,
  onClose,
  onSave,
  onCreateCategory,
}: OverrideEditorDialogProps) {
  const t = useTranslations('scheduledTransactions');
  const tc = useTranslations('common');
  const { formatPrice } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>(overrideDate);
  const [amount, setAmount] = useState<number>(0);
  // True while a loan occurrence's amount is unknown and the user has not
  // entered one: the field is empty rather than holding the template's amount.
  const [amountUnknown, setAmountUnknown] = useState(false);
  // Why a loan occurrence's amount, or only its lines, could not be seeded.
  const [loanSeedGap, setLoanSeedGap] = useState<{
    part: 'amount' | 'lines';
    missing: LoanOccurrenceMissing | null;
  } | null>(null);
  const missingText = useLoanOccurrenceMissingText();
  const [categoryId, setCategoryId] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isSplit, setIsSplit] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);

  // Investment-mode per-occurrence overrides.
  const [investmentQuantity, setInvestmentQuantity] = useState<number | ''>('');
  const [investmentPrice, setInvestmentPrice] = useState<number | ''>('');
  const [investmentTotalAmount, setInvestmentTotalAmount] = useState<number | ''>('');
  // UI-only computed total for qty+price actions; not persisted directly
  // (the backend derives total from qty * price + commission).
  const [investmentTotalValue, setInvestmentTotalValue] = useState<number | ''>('');
  const [marketPrice, setMarketPrice] = useState<number | null>(null);
  const [marketPriceDate, setMarketPriceDate] = useState<string | null>(null);
  // True only once a price request completes and returns no usable close -- the
  // one state that means "this security genuinely has no price history", kept
  // apart from marketPrice == null (also the loading window and a failed lookup).
  // A failed lookup is not an empty dataset (docs/frontend/api-and-cache.md).
  const [priceHistoryEmpty, setPriceHistoryEmpty] = useState(false);
  // True when the occurrence already has a price on file -- from this override
  // or from the schedule it belongs to. Such a price is an instruction the user
  // saved, so market data may be offered beside it but never written over it.
  const [hasStoredPrice, setHasStoredPrice] = useState(false);
  // Which of the two a stored price came from, so the provenance note tells the
  // truth: a price on *this* override reads "saved on this occurrence", while a
  // price inherited from the base schedule (a new override with no price of its
  // own yet) reads "from the schedule" -- claiming the latter was saved on the
  // occurrence would be a false provenance claim in the one place that exists
  // to state provenance.
  const [priceFromOccurrence, setPriceFromOccurrence] = useState(false);
  const [priceCameFromMarket, setPriceCameFromMarket] = useState(false);
  // True once the user types into the Total field after the dialog opens. The
  // latest close is fetched asynchronously and the auto-fill is total-first
  // (writePrice preserves the total and re-derives the quantity, issue #1148), so
  // a total the user typed while the fetch was in flight is present when the close
  // lands and would have the quantity rescaled beside it. A quantity-only edit is
  // safe to auto-fill -- with no total on the field the total-first fill degrades
  // to deriving the total from the shares, so the quantity is preserved -- so only
  // a typed total blocks it; a typed price already blocks via the
  // `investmentPrice === ''` gate.
  const [userEditedTotal, setUserEditedTotal] = useState(false);

  const isInvestmentKind = scheduledTransaction.isInvestment;
  const investmentAction = scheduledTransaction.investmentAction;
  const isInvestmentQuantityPrice =
    isInvestmentKind &&
    investmentAction != null &&
    ['BUY', 'SELL', 'REINVEST'].includes(baseInvestmentAction(investmentAction));
  const isInvestmentQuantityOnly =
    isInvestmentKind &&
    (investmentAction === 'ADD_SHARES' ||
      investmentAction === 'REMOVE_SHARES' ||
      investmentAction === 'SPLIT');
  const isInvestmentAmountOnly =
    isInvestmentKind &&
    investmentAction != null &&
    ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN'].includes(baseInvestmentAction(investmentAction));

  // Initialize form with base transaction or existing override values
  useEffect(() => {
    // Split lines are booked in the currency's smallest unit under a parent in
    // the same unit, the rounding difference on the loan's principal line:
    // a cents parent over a template's 4dp lines is what the server refused
    // (issue #1581).
    const initSplits = (rows: SplitRow[] | null, parentAmount: number, fallbackAmount: number) => {
      const booked =
        rows && !scheduledTransaction.isTransfer
          ? bookSplitRowsAtMinorUnit(rows, parentAmount, scheduledTransaction.currencyCode, scheduledTransaction.splits)
          : null;
      if (booked) {
        setSplits(booked.rows);
        setAmount(booked.parentAmount);
      } else {
        setSplits(rows ?? createEmptySplits(fallbackAmount));
      }
    };
    if (isOpen) {
      if (existingOverride) {
        // Use the existing override's date (which may differ from the original calculated date)
        setSelectedDate(existingOverride.overrideDate);
      } else {
        // For new overrides, use the original calculated date
        setSelectedDate(overrideDate);
      }

      if (existingOverride) {
        // Use override values (absolute value for transfers - sign is applied on save)
        const rawAmt = roundToCents(existingOverride.amount ?? scheduledTransaction.amount);
        const amt = scheduledTransaction.isTransfer ? Math.abs(rawAmt) : rawAmt;
        setAmount(prefillAmount != null ? roundToCents(prefillAmount) : amt);
        setCategoryId(existingOverride.categoryId ?? scheduledTransaction.categoryId ?? '');
        setDescription(existingOverride.description ?? scheduledTransaction.description ?? '');
        setIsSplit(existingOverride.isSplit ?? scheduledTransaction.isSplit);
        initSplits(
          existingOverride.isSplit && existingOverride.splits
            ? toSplitRows(existingOverride.splits.map((s, i) => ({
                id: `override-${i}`,
                ...s,
              })))
            : scheduledTransaction.isSplit && scheduledTransaction.splits
              ? toSplitRows(scheduledTransaction.splits)
              : null,
          Number(prefillAmount ?? existingOverride.amount ?? scheduledTransaction.amount),
          amt,
        );
      } else {
        // Use base transaction values (absolute value for transfers - sign is applied on save)
        const rawAmt = roundToCents(scheduledTransaction.amount);
        const amt = scheduledTransaction.isTransfer ? Math.abs(rawAmt) : rawAmt;
        setAmount(prefillAmount != null ? roundToCents(prefillAmount) : amt);
        setCategoryId(scheduledTransaction.categoryId ?? '');
        setDescription(scheduledTransaction.description ?? '');
        setIsSplit(scheduledTransaction.isSplit);
        initSplits(
          scheduledTransaction.isSplit && scheduledTransaction.splits
            ? toSplitRows(scheduledTransaction.splits)
            : null,
          Number(prefillAmount ?? scheduledTransaction.amount),
          amt,
        );
      }

      // A loan bill's occurrence opens on the figures the server priced for
      // it at its own due date, not the template's (INV-LOAN-009). An
      // override's own lines stand as the user wrote them.
      setAmountUnknown(false);
      setLoanSeedGap(null);
      const overrideHasOwnLines = !!(existingOverride?.isSplit && existingOverride.splits);
      if (loanOccurrence && !isInvestmentKind && prefillAmount == null && !overrideHasOwnLines) {
        const { occurrence, loanAccountId } = loanOccurrence;
        // Direction only: the projection's money is unsigned, and the bill
        // moves it the way the template does.
        const sign: 1 | -1 = Number(scheduledTransaction.amount) < 0 ? -1 : 1;
        const templateRows =
          scheduledTransaction.isSplit && scheduledTransaction.splits
            ? toSplitRows(scheduledTransaction.splits)
            : null;
        if (occurrence.amount === null) {
          setAmount(0);
          setAmountUnknown(true);
          setLoanSeedGap({ part: 'amount', missing: occurrence.missing });
          if (templateRows) setSplits(templateRows.map((row) => ({ ...row, amount: 0 })));
        } else {
          const parent = scheduledTransaction.isTransfer
            ? Math.abs(occurrence.amount)
            : sign * occurrence.amount;
          const lines = templateRows
            ? loanOccurrenceLines(templateRows, occurrence, loanAccountId, sign)
            : null;
          if (templateRows && !lines) {
            setLoanSeedGap({ part: 'lines', missing: occurrence.missing });
          }
          setAmount(roundToCents(parent));
          if (lines ?? templateRows) initSplits(lines ?? templateRows, parent, parent);
        }
      }

      // Investment-mode prefill: existing override values fall back to the
      // base scheduled transaction's saved values.
      const initialQty =
        existingOverride?.investmentQuantity != null
          ? Number(existingOverride.investmentQuantity)
          : scheduledTransaction.investmentQuantity != null
            ? Number(scheduledTransaction.investmentQuantity)
            : '';
      const initialPrice =
        existingOverride?.investmentPrice != null
          ? Number(existingOverride.investmentPrice)
          : scheduledTransaction.investmentPrice != null
            ? Number(scheduledTransaction.investmentPrice)
            : '';
      const initialTotalAmount =
        existingOverride?.investmentTotalAmount != null
          ? Number(existingOverride.investmentTotalAmount)
          : scheduledTransaction.investmentTotalAmount != null
            ? Number(scheduledTransaction.investmentTotalAmount)
            : '';
      setInvestmentQuantity(initialQty);
      setInvestmentPrice(initialPrice);
      setInvestmentTotalAmount(initialTotalAmount);
      setHasStoredPrice(typeof initialPrice === 'number' && initialPrice > 0);
      setPriceFromOccurrence(existingOverride?.investmentPrice != null);
      setPriceCameFromMarket(false);
      setUserEditedTotal(false);
      if (
        typeof initialQty === 'number' &&
        initialQty > 0 &&
        typeof initialPrice === 'number' &&
        initialPrice > 0
      ) {
        const sign = baseInvestmentAction(scheduledTransaction.investmentAction as InvestmentAction) === 'SELL' ? -1 : 1;
        setInvestmentTotalValue(
          totalFromQuantity(
            initialQty,
            initialPrice,
            sign,
            Number(scheduledTransaction.investmentCommission ?? 0),
          ),
        );
      } else {
        setInvestmentTotalValue('');
      }
      setMarketPrice(null);
      setMarketPriceDate(null);
      setPriceHistoryEmpty(false);
    }
  }, [isOpen, existingOverride, scheduledTransaction, overrideDate, prefillAmount, loanOccurrence, isInvestmentKind]);

  // Fetch the most recent close price for the security so we can auto-fill
  // the Price field (matching the new-scheduled-transaction form behaviour).
  useEffect(() => {
    if (!isOpen || !isInvestmentKind || !isInvestmentQuantityPrice) return;
    const securityId = scheduledTransaction.investmentSecurityId;
    if (!securityId) return;
    let cancelled = false;
    // Reset while the request is in flight: "no price history" is a
    // completed-empty result, not the loading window and not a failed lookup.
    setPriceHistoryEmpty(false);
    investmentsApi
      .getSecurityPrices(securityId, { limit: 1 })
      .then((prices) => {
        if (cancelled) return;
        const close = usableClose(prices);
        setMarketPrice(close ? close.price : null);
        setMarketPriceDate(close ? close.date : null);
        setPriceHistoryEmpty(close === null);
      })
      .catch((err) => {
        if (cancelled) return;
        setMarketPrice(null);
        setMarketPriceDate(null);
        // A failed lookup is not an empty dataset -- leave the hint off.
        setPriceHistoryEmpty(false);
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

  const investmentSign = baseInvestmentAction(scheduledTransaction.investmentAction as InvestmentAction) === 'SELL' ? -1 : 1;
  const investmentCommission = Number(scheduledTransaction.investmentCommission ?? 0);

  /**
   * Write a market price into the form and recompute the field the user did not
   * set. Only ever called for a market figure -- the auto-fill below and the
   * "use latest close" button -- so the value always came from the market and
   * `priceCameFromMarket` is set unconditionally.
   *
   * Precedence here is total-first (issue #1148), matching the keystroke path
   * (`handleInvestmentPriceChange`) and the posting dialog's market refresh: a
   * stated total keeps the amount invested and the share count follows, so
   * clicking "use latest close" and typing the same price book the same quantity
   * and total. Only when no total is present does a stated quantity derive the
   * total -- the auto-fill's own case, where the price field is empty so no total
   * has been computed yet, which keeps a quantity-only edit safe to auto-fill.
   * Either way the click never leaves an inconsistent price/total/quantity triple.
   *
   * Once a market price is written, the field no longer holds the stored
   * instruction, so `hasStoredPrice` drops -- the provenance note must not
   * outlive the value it describes.
   */
  const writePrice = (price: number) => {
    const rounded = roundPrice(price);
    setInvestmentPrice(rounded);
    setPriceCameFromMarket(true);
    setHasStoredPrice(false);
    if (investmentTotalValue !== '') {
      // Total-first: preserve the amount invested, re-derive the quantity.
      setInvestmentQuantity(
        quantityFromTotal(Number(investmentTotalValue), rounded, investmentSign, investmentCommission),
      );
    } else if (investmentQuantity !== '' && Number(investmentQuantity) > 0) {
      // No total to preserve (the auto-fill case) -- derive it from the quantity.
      setInvestmentTotalValue(
        totalFromQuantity(Number(investmentQuantity), rounded, investmentSign, investmentCommission),
      );
    }
  };

  // The latest close fills the Price field only when the occurrence has no
  // price of its own -- a brand new override on a schedule that never stored
  // one. Where a price *is* on file it stays put and the market figure is
  // offered as an explicit action instead: this dialog used to overwrite it on
  // open, so reopening an override to change only its date silently re-priced a
  // future purchase at today's close. Uses the "info from previous render"
  // pattern to avoid violating react-hooks/set-state-in-effect.
  //
  // `!userEditedTotal` is the second half of that guard: the fetch is
  // asynchronous, and the fill is total-first (writePrice preserves the total and
  // re-derives the quantity, issue #1148). A total the user typed while the fetch
  // was in flight is present when the close lands, so the fill would rescale the
  // quantity beside it -- the typed-before-fetch race PostTransactionDialog guards
  // on its side. A quantity-only edit does not block it: with no total on the
  // field the total-first fill degrades to deriving the total from the shares, so
  // the typed quantity is preserved and filling the price matches
  // ScheduledTransactionForm on identical input.
  const [lastSeenMarketPrice, setLastSeenMarketPrice] = useState<number | null>(null);
  if (isOpen && marketPrice !== lastSeenMarketPrice) {
    setLastSeenMarketPrice(marketPrice);
    if (
      isInvestmentQuantityPrice &&
      !hasStoredPrice &&
      !userEditedTotal &&
      investmentPrice === '' &&
      marketPrice != null &&
      marketPrice > 0
    ) {
      writePrice(marketPrice);
    }
  }

  // marketPrice is already null unless it is a usable positive number
  // (usableClose rejects zero/negative/NaN before it is set), so a plain null
  // check is all that is needed here.
  const roundedMarketPrice = marketPrice != null ? roundPrice(marketPrice) : null;
  // Offer the market price only when it would actually change the field.
  const canApplyMarketPrice =
    isInvestmentQuantityPrice &&
    roundedMarketPrice !== null &&
    roundedMarketPrice !== investmentPrice;

  const handleInvestmentQuantityChange = (raw: number | undefined) => {
    const qty = raw ?? '';
    setInvestmentQuantity(qty);
    if (qty !== '' && investmentPrice !== '' && Number(investmentPrice) > 0) {
      setInvestmentTotalValue(
        totalFromQuantity(Number(qty), Number(investmentPrice), investmentSign, investmentCommission),
      );
    }
  };

  const handleInvestmentPriceChange = (raw: number | undefined) => {
    const price = raw ?? '';
    setInvestmentPrice(price);
    // A typed (or cleared) price is the user's own, whatever it happens to
    // equal, so it is no longer the stored instruction: both provenance flags
    // drop, and the "saved on this occurrence" note stops claiming a value the
    // user has since changed.
    setPriceCameFromMarket(false);
    setHasStoredPrice(false);
    if (price !== '' && Number(price) > 0) {
      // Keystroke path: total-first (a stated budget wins, quantity follows).
      if (investmentTotalValue !== '') {
        setInvestmentQuantity(
          quantityFromTotal(Number(investmentTotalValue), Number(price), investmentSign, investmentCommission),
        );
      } else if (investmentQuantity !== '') {
        setInvestmentTotalValue(
          totalFromQuantity(Number(investmentQuantity), Number(price), investmentSign, investmentCommission),
        );
      }
    }
  };

  const handleInvestmentTotalValueChange = (raw: number | undefined) => {
    setUserEditedTotal(true);
    if (raw === undefined) {
      setInvestmentTotalValue('');
      return;
    }
    setInvestmentTotalValue(raw);
    if (investmentPrice !== '' && Number(investmentPrice) > 0) {
      setInvestmentQuantity(
        quantityFromTotal(raw, Number(investmentPrice), investmentSign, investmentCommission),
      );
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

  const handleSave = async () => {
    if (isInvestmentKind) {
      if (isInvestmentQuantityPrice || isInvestmentQuantityOnly) {
        if (investmentQuantity === '' || Number(investmentQuantity) <= 0) {
          toast.error(t('overrideEditor.toasts.quantityRequired'));
          return;
        }
      }
      if (isInvestmentQuantityPrice) {
        if (investmentPrice === '' || Number(investmentPrice) <= 0) {
          toast.error(t('overrideEditor.toasts.priceRequired'));
          return;
        }
      }
      if (isInvestmentAmountOnly) {
        if (investmentTotalAmount === '') {
          toast.error(t('overrideEditor.toasts.totalAmountRequired'));
          return;
        }
      }
    }

    if (!isInvestmentKind && amountUnknown) {
      toast.error(t('loanOccurrence.amountRequired'));
      return;
    }

    setIsLoading(true);
    try {
      // For transfers, negate the amount (user enters positive, stored as negative)
      const savedAmount = scheduledTransaction.isTransfer ? -Math.abs(amount) : amount;
      const baseData = isInvestmentKind
        ? {
            description: description || null,
            investmentQuantity:
              investmentQuantity === '' ? null : Number(investmentQuantity),
            investmentPrice:
              investmentPrice === '' ? null : Number(investmentPrice),
            investmentTotalAmount:
              investmentTotalAmount === '' ? null : Number(investmentTotalAmount),
          }
        : {
            amount: savedAmount,
            categoryId: isSplit ? null : (categoryId || null),
            description: description || null,
            isSplit,
            splits: isSplit ? toOverrideSplits(splits) : null,
          };

      // originalDate = the calculated occurrence date from the picker (overrideDate prop)
      // selectedDate = the actual date the user wants this occurrence to be (may differ)
      const dateChanged = existingOverride && selectedDate !== existingOverride.overrideDate;

      if (existingOverride) {
        // Update the existing override in place, including a date move (issue
        // #1167 R10-F3). Moving the date used to delete-then-recreate, which lost
        // the override's split identities so a validly pinned FX rate could no
        // longer be correlated and was silently re-resolved. `originalDate` (the
        // row's identity) is unchanged; only `overrideDate` moves.
        await scheduledTransactionsApi.updateOverride(
          scheduledTransaction.id,
          existingOverride.id,
          dateChanged ? { ...baseData, overrideDate: selectedDate } : baseData,
        );
        toast.success(
          dateChanged
            ? t('overrideEditor.toasts.moved')
            : t('overrideEditor.toasts.updated'),
        );
      } else {
        // Create new override
        await scheduledTransactionsApi.createOverride(scheduledTransaction.id, {
          ...baseData,
          originalDate: overrideDate, // The date from the picker is the original calculated date
          overrideDate: selectedDate, // The selected date (may be same or different)
        });
        toast.success(t('overrideEditor.toasts.created'));
      }
      onSave();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('overrideEditor.toasts.saveFailed')));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!existingOverride) return;

    setIsLoading(true);
    try {
      await scheduledTransactionsApi.deleteOverride(scheduledTransaction.id, existingOverride.id);
      toast.success(t('overrideEditor.toasts.deleted'));
      onSave();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('overrideEditor.toasts.deleteFailed')));
    } finally {
      setIsLoading(false);
    }
  };

  // Handler for SplitEditor to update amount
  const handleAmountChange = (newAmount: number) => {
    setAmount(roundToCents(newAmount));
    setAmountUnknown(false);
  };

  const currentCategory = categoryId ? categories.find(c => c.id === categoryId) : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="5xl" className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {t('overrideEditor.title')}
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
          t('overrideEditor.descriptionInvestment', {
            action: investmentAction || 'investment',
            security: scheduledTransaction.investmentSecurity
              ? (scheduledTransaction.investmentSecurity.symbol || scheduledTransaction.investmentSecurity.name)
              : '',
            account: scheduledTransaction.account?.name ?? '',
          })
        ) : (
          t('overrideEditor.descriptionRegular', { name: scheduledTransaction.name })
        )}
        {existingOverride && (
          <span className="ml-1 text-blue-600 dark:text-blue-400">{t('overrideEditor.overrideExists')}</span>
        )}
      </div>

      <div className="space-y-4">
        {/* Date */}
        <DateInput
          label={t('overrideEditor.occurrenceDateLabel')}
          value={selectedDate}
          onDateChange={(date) => setSelectedDate(date)}
        />

        {/* Investment-kind: quantity / price / total */}
        {isInvestmentKind && (
          <>
            {(isInvestmentQuantityPrice || isInvestmentQuantityOnly) && (
              <NumericInput
                label={t('overrideEditor.quantityLabel')}
                decimalPlaces={8}
                min={0}
                value={investmentQuantity === '' ? undefined : investmentQuantity}
                onChange={(value) =>
                  isInvestmentQuantityPrice
                    ? handleInvestmentQuantityChange(value)
                    : setInvestmentQuantity(value ?? '')
                }
              />
            )}
            {isInvestmentQuantityPrice && (
              <>
                <NumericInput
                  label={t('overrideEditor.pricePerShareLabel')}
                  decimalPlaces={6}
                  min={0}
                  placeholder={
                    roundedMarketPrice != null
                      ? t('overrideEditor.latestPricePlaceholder', {
                          price: formatPrice(roundedMarketPrice),
                        })
                      : undefined
                  }
                  value={investmentPrice === '' ? undefined : investmentPrice}
                  onChange={handleInvestmentPriceChange}
                />
                {/* Price provenance. The stored value wins on open; the latest
                    close is a suggestion the user applies deliberately. */}
                {canApplyMarketPrice && (
                  <div className="-mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>
                      {marketPriceDate
                        ? t('overrideEditor.latestCloseOnDate', {
                            price: formatPrice(roundedMarketPrice),
                            date: formatDate(marketPriceDate),
                          })
                        : t('overrideEditor.latestClose', {
                            price: formatPrice(roundedMarketPrice),
                          })}
                    </span>
                    <button
                      type="button"
                      onClick={() => writePrice(roundedMarketPrice)}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {t('overrideEditor.useLatestClose')}
                    </button>
                  </div>
                )}
                {priceCameFromMarket && !canApplyMarketPrice && (
                  <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {marketPriceDate
                      ? t('overrideEditor.priceFromMarketOnDate', { date: formatDate(marketPriceDate) })
                      : t('overrideEditor.priceFromMarket')}
                  </p>
                )}
                {hasStoredPrice && !canApplyMarketPrice && (
                  <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {priceFromOccurrence
                      ? t('overrideEditor.priceFromOccurrence')
                      : t('overrideEditor.priceFromSchedule')}
                  </p>
                )}
                <CurrencyInput
                  label={t('overrideEditor.totalPriceLabel')}
                  prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                  value={
                    typeof investmentTotalValue === 'number'
                      ? investmentTotalValue
                      : undefined
                  }
                  onChange={handleInvestmentTotalValueChange}
                />
                {scheduledTransaction.investmentSecurityId && priceHistoryEmpty && investmentPrice === '' && (
                  <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {t('overrideEditor.noPriceHistory')}
                  </p>
                )}
              </>
            )}
            {isInvestmentAmountOnly && (
              <CurrencyInput
                label={t('overrideEditor.totalAmountLabel')}
                prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                value={
                  typeof investmentTotalAmount === 'number'
                    ? investmentTotalAmount
                    : undefined
                }
                onChange={(value) => setInvestmentTotalAmount(value ?? '')}
              />
            )}
          </>
        )}

        {/* Amount — non-investment only */}
        {!isInvestmentKind && (
          <CurrencyInput
            label={t('overrideEditor.amountLabel')}
            prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
            value={amountUnknown ? undefined : amount}
            onChange={(value) => {
              setAmount(value ?? 0);
              setAmountUnknown(false);
            }}
            allowSignToggle
          />
        )}
        {!isInvestmentKind && loanSeedGap && (
          <p className="-mt-2 text-xs text-amber-700 dark:text-amber-300" role="note">
            {t(
              loanSeedGap.part === 'amount'
                ? 'loanOccurrence.editorUnknown'
                : 'loanOccurrence.editorLinesUnknown',
              { reason: missingText(loanSeedGap.missing) },
            )}
          </p>
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
                {t('overrideEditor.transferSummary', {
                  from: scheduledTransaction.account?.name ?? '',
                  to: scheduledTransaction.transferAccount?.name ?? '',
                })}
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* Split toggle */}
            <label className="flex items-center gap-2 cursor-pointer w-fit">
              <ToggleSwitch
                checked={isSplit}
                onChange={(next) => {
                  setIsSplit(next);
                  if (next && splits.length < 2) {
                    setSplits(createEmptySplits(amount));
                  }
                }}
                label={t('overrideEditor.splitLabel')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('overrideEditor.splitLabel')}
              </span>
            </label>

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
                onCreateCategory={onCreateCategory}
              />
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('overrideEditor.categoryLabel')}
                </label>
                <Combobox
                  placeholder={t('overrideEditor.categoryPlaceholder')}
                  options={categoryOptions}
                  value={categoryId}
                  initialDisplayValue={currentCategory?.name || ''}
                  onChange={(value) => setCategoryId(value || '')}
                  onCreateNew={
                    onCreateCategory
                      ? async (name) => {
                          const created = await onCreateCategory(name);
                          if (created) setCategoryId(created.id);
                        }
                      : undefined
                  }
                  allowCustomValue={!!onCreateCategory}
                  valueIsId
                />
              </div>
            )}
          </>
        )
        )}

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('overrideEditor.descriptionLabel')}
          </label>
          <Input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('overrideEditor.descriptionPlaceholder')}
            maxLength={TRANSACTION_NOTE_MAX_LENGTH}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 flex justify-between">
        <div>
          {existingOverride && (
            <Button
              variant="outline"
              onClick={handleDelete}
              isLoading={isLoading}
              className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/50"
            >
              {t('overrideEditor.resetToDefault')}
            </Button>
          )}
        </div>
        <div className="flex space-x-3">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSave} isLoading={isLoading}>
            {existingOverride ? t('overrideEditor.updateOverride') : t('overrideEditor.saveOverride')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
