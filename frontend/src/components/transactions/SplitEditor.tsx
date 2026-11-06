'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { Tag, TagUsageMap } from '@/types/tag';
import { InvestmentSplitDetails } from '@/types/transaction';
import type { SplitRow } from './split-rows';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { FALLBACK_DEFAULT_CURRENCY } from '@/lib/default-currency';
import {
  roundMoney,
  sumMoney,
  roundToDecimals,
  roundToEntryPlaces,
  getCurrencySymbol,
  getDecimalPlacesForCurrency,
  awaitsRegisteredPlaces,
  MONEY_SCALE,
  moneyDecimalsForCurrency,
} from '@/lib/format';
import { useLocalizedAmount } from '@/hooks/useLocalizedAmount';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import { InvestmentSplitFields } from './InvestmentSplitFields';
import { RemoveSplitLineButton } from './SplitLineButtons';
import {
  useSplitTransferFxAutofill,
  currentTransferTargetAmount,
  SplitFxPatch,
} from './useSplitTransferFxAutofill';
import { splitTransferPair } from './split-transfer-currency';
import { SplitAmountFields } from './SplitAmountFields';
import { TRANSACTION_NOTE_MAX_LENGTH } from '@/lib/transaction-note';
import { buildTagOptions } from '@/lib/tag-options';
import { Th } from '@/components/ui/Table';

export type { SplitType, SplitRow } from './split-rows';
export { createEmptySplits, toSplitRows, toCreateSplitData } from './split-rows';

interface SplitEditorProps {
  splits: SplitRow[];
  onChange: (splits: SplitRow[]) => void;
  categories: Category[];
  tags?: Tag[];
  /** Orders the tag picker recent-first (`buildTagOptions`); absent means A-Z. */
  tagUsage?: TagUsageMap;
  accounts?: Account[];
  sourceAccountId?: string;
  /** When the parent account is INVESTMENT_CASH, the investment split kind is enabled. */
  parentAccountSubType?: string | null;
  transactionAmount: number;
  disabled?: boolean;
  onTransactionAmountChange?: (amount: number) => void;
  currencyCode?: string;
  /**
   * When provided, deleting one of the final two splits is allowed: it converts
   * the transaction back to a regular one using the remaining split's category.
   * The remaining split must be a category split for this to be offered.
   */
  onConvertToRegular?: (categoryId: string | undefined) => void;
  /**
   * Foreign-currency editing. When both are set (and the display currency
   * differs from the account currency), a two-pill toggle lets the user view
   * and edit split amounts in `displayCurrencyCode` instead of the account
   * currency. `displayRate` is account-currency units per 1 unit of the display
   * currency. Amounts are always stored in the account currency (splits sum to
   * the account-currency transaction amount); the foreign values are converted
   * on edit, so distribution and balancing stay exact in the account currency.
   */
  displayCurrencyCode?: string;
  displayRate?: number;
  /**
   * Create a category from text typed into a split line's category picker,
   * resolving to the created category (or null/undefined when nothing was
   * created). When provided, the picker offers the same "+ Create" row as the
   * non-split transaction form's category field; when omitted, typed text that
   * matches nothing is discarded, which is what every split line used to do.
   */
  onCreateCategory?: (name: string) => Promise<Category | null | undefined>;
  /**
   * The parent transaction's date (`YYYY-MM-DD`). An investment line prefills its
   * FX rate from the rate for this day (INV-FX-001), never the latest.
   */
  transactionDate?: string;
  /**
   * Offer an "Amount Received" on a transfer line whose target account is in
   * another currency, prefilled from the rate for `transactionDate` and
   * editable. Only the transaction form sets it: the field is saved as the
   * line's `transferTargetAmount`, which the scheduled surfaces do not store.
   */
  crossCurrencyTransfers?: boolean;
}

// A stable default, so an absent prop does not rebuild the tag options every render.
const NO_TAG_USAGE: TagUsageMap = {};

export function SplitEditor({
  splits,
  onChange,
  categories,
  tags = [],
  tagUsage = NO_TAG_USAGE,
  accounts = [],
  sourceAccountId = '',
  parentAccountSubType,
  transactionAmount,
  disabled = false,
  onTransactionAmountChange,
  currencyCode = FALLBACK_DEFAULT_CURRENCY,
  onConvertToRegular,
  displayCurrencyCode,
  displayRate,
  onCreateCategory,
  transactionDate,
  crossCurrencyTransfers = false,
}: SplitEditorProps) {
  const t = useTranslations('transactions');
  // Read-only amounts, grouped in the user's number locale (en-US unchanged).
  const formatAmountLocal = useLocalizedAmount();
  const accountOptionLabel = useAccountOptionLabel({ withCurrency: false });
  const investmentSplitsEnabled = parentAccountSubType === 'INVESTMENT_CASH';
  const currencySymbol = getCurrencySymbol(currencyCode);
  // A coin the registry does not hold yet is entered at the column scale
  // (`awaitsRegisteredPlaces`), not `Intl`'s guess of two, so a line typed
  // before `GET /currencies` answers is not rounded to cents.
  const decimals = awaitsRegisteredPlaces(currencyCode)
    ? MONEY_SCALE
    : getDecimalPlacesForCurrency(currencyCode);
  // The account currency's money precision: four for fiat, a coin's eight.
  // Every line, total, remainder and distribution rounds and sums at it.
  const money = moneyDecimalsForCurrency(currencyCode);
  const [localSplits, setLocalSplits] = useState<SplitRow[]>(splits);

  // Foreign-currency editing toggle. Available only when a display currency and
  // a positive rate are supplied and the two currencies differ. Amounts are
  // always stored in the account currency; the toggle only changes the currency
  // the amounts are shown and entered in.
  const canToggleCurrency =
    !!displayCurrencyCode &&
    !!displayRate &&
    displayRate > 0 &&
    displayCurrencyCode.toUpperCase() !== currencyCode.toUpperCase();
  const [showForeignAmounts, setShowForeignAmounts] = useState(false);
  const foreignActive = canToggleCurrency && showForeignAmounts;
  const rate = displayRate ?? 1;
  const activeSymbol = foreignActive
    ? getCurrencySymbol(displayCurrencyCode as string)
    : currencySymbol;
  const activeDecimals = foreignActive
    ? getDecimalPlacesForCurrency(displayCurrencyCode as string)
    : decimals;
  // Convert a stored account-currency amount to the currency currently shown.
  const toDisplayAmount = (accountAmount: number) =>
    foreignActive ? roundToDecimals(accountAmount / rate, activeDecimals) : accountAmount;
  // Convert an amount typed in the currently shown currency back to the stored
  // account currency, rounded to cents as the rest of the editor does, or to a
  // coin's own places from the currency registry (a -0.0051 BTC line was
  // stored as -0.01).
  const toStoredPlaces = (amount: number) => roundToEntryPlaces(amount, currencyCode);
  const fromDisplayAmount = (displayAmount: number) =>
    toStoredPlaces(foreignActive ? displayAmount * rate : displayAmount);
  // Index of the split pending removal that would convert the transaction back
  // to a regular one (only set while the confirmation dialog is open).
  const [convertPendingIndex, setConvertPendingIndex] = useState<number | null>(null);

  // Always show Type column since a transaction will always have an account
  const supportsTransfers = true;

  // Memoize category options to avoid rebuilding on every render
  const categoryOptions = useMemo(() => buildCategoryTree(categories).map(({ category }) => {
    const parentCategory = category.parentId
      ? categories.find(c => c.id === category.parentId)
      : null;
    return {
      value: category.id,
      label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
    };
  }), [categories]);

  // Memoize tag options for multiselect
  const tagOptions = useMemo(() => buildTagOptions(tags, tagUsage), [tags, tagUsage]);

  // Memoize account options (excluding source account, asset accounts, investment accounts, and closed accounts)
  const accountOptions = useMemo(() => {
    if (!supportsTransfers) return [];
    const selectedTransferAccountIds = new Set(
      splits.filter(s => s.splitType === 'transfer' && s.transferAccountId).map(s => s.transferAccountId!)
    );
    return buildAccountDropdownOptions(
      accounts,
      (a) =>
        a.id !== sourceAccountId &&
        a.accountSubType !== 'INVESTMENT_BROKERAGE' &&
        (!a.isClosed || selectedTransferAccountIds.has(a.id)),
      accountOptionLabel,
    );
  }, [accounts, sourceAccountId, supportsTransfers, splits, accountOptionLabel]);

  // Sync with parent when splits prop changes (the "info from previous render"
  // pattern rather than a setState in an effect)
  const [syncedSplits, setSyncedSplits] = useState(splits);
  if (syncedSplits !== splits) {
    setSyncedSplits(splits);
    setLocalSplits(splits);
  }

  // A category created from a split line is applied before the parent's own
  // state update has re-rendered this component, so the new row is not in
  // `categories` yet. Remember what was created here so the income/expense sign
  // rules below can still read its `isIncome` flag on the very first apply.
  const createdCategoriesRef = useRef<Category[]>([]);
  const findCategory = useCallback(
    (id: string): Category | undefined =>
      categories.find((c) => c.id === id) ??
      createdCategoriesRef.current.find((c) => c.id === id),
    [categories],
  );

  // The splits as last committed, for a rate that arrives between renders.
  const splitsRef = useRef(localSplits);
  useEffect(() => {
    splitsRef.current = localSplits;
  });

  const defaultSign: 1 | -1 = Number(transactionAmount) > 0 ? 1 : -1;
  const transferPairOf = (split: SplitRow) =>
    crossCurrencyTransfers
      ? splitTransferPair(split, accounts, currencyCode, sourceAccountId, defaultSign)
      : null;
  const applyFxPatches = (patches: Record<string, SplitFxPatch>) => {
    const next = splitsRef.current.map((split) =>
      patches[split.id] ? { ...split, ...patches[split.id] } : split,
    );
    splitsRef.current = next;
    setLocalSplits(next);
    onChange(next);
  };
  const transferFx = useSplitTransferFxAutofill<SplitRow>({
    fromCurrency: currencyCode,
    date: transactionDate,
    lines: localSplits,
    pairOf: transferPairOf,
    defaultSign,
    onPatch: applyFxPatches,
  });

  // Every change to the lines lands here. A moved amount re-derives the
  // received amount of a cross-currency transfer line still holding a derived
  // one; a typed received amount skips that, since it is the user's figure.
  const commitSplits = (next: SplitRow[], options: { reconcile?: boolean } = {}) => {
    const committed =
      options.reconcile === false ? next : transferFx.reconcile(localSplits, next);
    splitsRef.current = committed;
    setLocalSplits(committed);
    onChange(committed);
  };

  const handleTargetAmountChange = (index: number, value: number | undefined) => {
    const line = localSplits[index];
    const newSplits = [...localSplits];
    newSplits[index] = { ...line, ...transferFx.editTarget(line, value) };
    commitSplits(newSplits, { reconcile: false });
  };

  // Summed and compared at the account currency's money precision (four for
  // fiat, a coin's eight), the rule the server's `validateSplitAmountSum`
  // applies (`sumMoney` of the lines against `roundMoney` of the total). A
  // one-cent tolerance read a 0.0049 BTC remainder as balanced, disabled "Add
  // remaining", and the save was refused. A fiat amount is entered at two
  // places, so its lines already sum exactly.
  const splitsTotal = sumMoney(localSplits.map((s) => Number(s.amount) || 0), money);
  const remaining = roundMoney(roundMoney(Number(transactionAmount), money) - splitsTotal, money);
  // Balance is always judged in the account currency so distribution and the
  // balanced/remaining indicators stay exact regardless of the display currency.
  const isBalanced = remaining === 0;
  // Footer figures rendered in whichever currency the amounts are shown in.
  const displaySplitsTotal = toDisplayAmount(splitsTotal);
  const displayRemaining = toDisplayAmount(remaining);
  const displayTransactionAmount = toDisplayAmount(Number(transactionAmount));

  const handleSplitChange = (index: number, field: keyof SplitRow, value: any) => {
    const newSplits = [...localSplits];

    // If changing split type, clear the other-kind fields
    if (field === 'splitType') {
      if (value === 'category') {
        newSplits[index] = {
          ...newSplits[index],
          splitType: 'category',
          transferAccountId: undefined,
          transferTargetAmount: undefined,
          investment: undefined,
        };
      } else if (value === 'transfer') {
        newSplits[index] = {
          ...newSplits[index],
          splitType: 'transfer',
          categoryId: undefined,
          transferTargetAmount: undefined,
          investment: undefined,
        };
      } else {
        newSplits[index] = {
          ...newSplits[index],
          splitType: 'investment',
          categoryId: undefined,
          transferAccountId: undefined,
          transferTargetAmount: undefined,
          investment: newSplits[index].investment ?? { action: 'BUY' },
        };
      }
      commitSplits(newSplits);
      return;
    }

    if (field === 'investment') {
      // Caller updated the investment payload; set both `investment` and the
      // computed cash impact passed as `_amount` via the value object. `meta`
      // carries the real rate-edit intent (issue #1167 R9-F2): a user edit of the
      // FX rate latches `exchangeRateEdited`; a security change resets it, because
      // the rate then belongs to a new pair the user has not yet chosen a value
      // for.
      const { investment, amount, meta } = value as {
        investment: InvestmentSplitDetails;
        amount: number;
        meta?: { rateEdited?: boolean; securityChanged?: boolean };
      };
      const prevEdited = newSplits[index].exchangeRateEdited ?? false;
      const exchangeRateEdited = meta?.securityChanged
        ? false
        : prevEdited || meta?.rateEdited === true;
      newSplits[index] = {
        ...newSplits[index],
        investment,
        amount,
        exchangeRateEdited,
      };
      commitSplits(newSplits);
      return;
    }

    // A received amount belongs to the account it arrived in: another target
    // starts empty and is filled from that pair's rate, as on a transfer.
    if (field === 'transferAccountId') {
      newSplits[index] = {
        ...newSplits[index],
        transferAccountId: value,
        transferTargetAmount: undefined,
        transferTargetFromCurrency: undefined,
      };
      commitSplits(newSplits);
      return;
    }

    // If changing category, adjust the amount sign based on income/expense
    if (field === 'categoryId' && value) {
      const category = findCategory(value);
      // A category with automatic sign turned off keeps whatever sign was typed.
      if (category && category.effectiveAutoSign !== false) {
        const currentAmount = Number(newSplits[index].amount) || 0;
        if (currentAmount !== 0) {
          const absAmount = Math.abs(currentAmount);
          const newAmount = category.isIncome ? absAmount : -absAmount;
          if (newAmount !== currentAmount) {
            newSplits[index] = { ...newSplits[index], amount: newAmount };
          }
        }

        // When the first split's category is set, adjust the transaction total sign
        // to match (analogous to how normal transactions infer sign from category)
        if (index === 0 && onTransactionAmountChange && transactionAmount !== 0) {
          const absTotal = Math.abs(transactionAmount);
          const newTotal = category.isIncome ? absTotal : -absTotal;
          if (newTotal !== transactionAmount) {
            onTransactionAmountChange(newTotal);
            // Flip uncategorized splits to keep them consistent with the new sign
            for (let i = 0; i < newSplits.length; i++) {
              if (i !== index && !newSplits[i].categoryId) {
                const amt = Number(newSplits[i].amount) || 0;
                if (amt !== 0) {
                  newSplits[i] = { ...newSplits[i], amount: -amt };
                }
              }
            }
          }
        }
      }
    }

    // If changing amount, adjust sign based on selected category
    // But respect explicit sign changes (same pattern as handleAmountChange)
    if (field === 'amount') {
      const categoryId = newSplits[index].categoryId;
      if (categoryId) {
        const category = findCategory(categoryId);
        if (category) {
          const newAmount = Number(value) || 0;
          if (newAmount !== 0) {
            // Check if user is just changing the sign (same absolute value)
            const currentAmount = Number(newSplits[index].amount) || 0;
            const isJustSignChange = Math.abs(currentAmount) === Math.abs(newAmount) && Math.abs(currentAmount) !== 0;

            if (!isJustSignChange && category.effectiveAutoSign !== false) {
              const absAmount = Math.abs(newAmount);
              value = category.isIncome ? absAmount : -absAmount;
            }
          }
        }
      }
    }

    newSplits[index] = { ...newSplits[index], [field]: value };
    commitSplits(newSplits);
  };

  // The apply step of an asynchronous create has to run against the splits as
  // they are when the category comes back, not as they were when the user
  // typed: rows can be added, removed or reordered while the request is in
  // flight. Both are read through a ref that every render refreshes.
  const latestRef = useRef({ localSplits, handleSplitChange });
  useEffect(() => {
    latestRef.current = { localSplits, handleSplitChange };
  });

  // Create a category from the text typed into a split line and assign it to
  // the row that asked. The row is addressed by its id rather than its index
  // for the same reason.
  const handleCategoryCreate = async (splitId: string, name: string) => {
    if (!onCreateCategory) return;
    const category = await onCreateCategory(name);
    if (!category) return;
    createdCategoriesRef.current = [...createdCategoriesRef.current, category];
    const { localSplits: current, handleSplitChange: applyChange } = latestRef.current;
    const index = current.findIndex((s) => s.id === splitId);
    // The row was removed while the request was in flight: the category still
    // exists (the user asked for it), it simply has nowhere to land.
    if (index === -1) return;
    applyChange(index, 'categoryId', category.id);
  };

  const addSplit = () => {
    const newSplit: SplitRow = {
      id: `temp-${crypto.randomUUID()}`,
      splitType: 'category',
      categoryId: undefined,
      transferAccountId: undefined,
      amount: roundMoney(remaining, money), // Pre-fill with the remaining amount, at the currency's money precision
      memo: '',
    };
    const newSplits = [...localSplits, newSplit];
    commitSplits(newSplits);
  };

  // Whether removing the row at `index` is allowed. Above two splits removal is
  // always allowed. At exactly two splits, removal is only offered when it can
  // convert the transaction back to a regular one -- i.e. the parent provided
  // `onConvertToRegular` and the split that would remain is a category split.
  const canRemoveRow = (index: number) => {
    if (localSplits.length > 2) return true;
    if (localSplits.length === 2 && onConvertToRegular) {
      const remaining = localSplits[index === 0 ? 1 : 0];
      return remaining?.splitType === 'category';
    }
    return false;
  };

  const removeSplit = (index: number) => {
    if (localSplits.length > 2) {
      const newSplits = localSplits.filter((_, i) => i !== index);
      commitSplits(newSplits);
      return;
    }
    // At two splits, deleting one converts back to a regular transaction.
    if (canRemoveRow(index)) {
      setConvertPendingIndex(index);
    }
  };

  const confirmConvertToRegular = () => {
    if (convertPendingIndex === null) return;
    const remaining = localSplits[convertPendingIndex === 0 ? 1 : 0];
    setConvertPendingIndex(null);
    onConvertToRegular?.(remaining?.categoryId);
  };

  const distributeEvenly = () => {
    if (localSplits.length === 0) return;

    const totalAmount = roundMoney(Number(transactionAmount), money);
    // Each split at the currency's money precision.
    const amountPerSplit = roundMoney(totalAmount / localSplits.length, money);

    // Distribute evenly, putting the remainder on the last row for an exact sum.
    const newSplits = localSplits.map((split, index) => {
      if (index === localSplits.length - 1) {
        const otherSplitsTotal = roundMoney(amountPerSplit * (localSplits.length - 1), money);
        const lastAmount = roundMoney(totalAmount - otherSplitsTotal, money);
        return { ...split, amount: lastAmount };
      }
      return { ...split, amount: amountPerSplit };
    });

    commitSplits(newSplits);
  };

  // Add unassigned amount to a specific split
  const addRemainingToSplit = (index: number) => {
    if (isBalanced) return; // No remaining amount

    const newSplits = [...localSplits];
    const currentAmount = Number(newSplits[index].amount) || 0;
    newSplits[index] = { ...newSplits[index], amount: roundMoney(currentAmount + remaining, money) };
    commitSplits(newSplits);
  };

  // Distribute the remaining amount proportionally across the splits based on
  // their current amounts.
  const distributeProportionally = () => {
    if (localSplits.length === 0 || isBalanced) return;

    const absTotal = sumMoney(localSplits.map((s) => Math.abs(Number(s.amount) || 0)), money);
    const lastSplit = localSplits[localSplits.length - 1];

    // If all splits are zero, fall back to equal distribution.
    if (absTotal === 0) {
      const perSplit = roundMoney(remaining / localSplits.length, money);
      const newSplits = localSplits.map((split, index) => {
        const currentAmount = Number(split.amount) || 0;
        if (index === localSplits.length - 1) {
          const distributed = roundMoney(perSplit * (localSplits.length - 1), money);
          const lastPortion = roundMoney(remaining - distributed, money);
          return { ...split, amount: roundMoney(currentAmount + lastPortion, money) };
        }
        return { ...split, amount: roundMoney(currentAmount + perSplit, money) };
      });
      commitSplits(newSplits);
      return;
    }

    let distributedSoFar = 0;
    const newSplits = localSplits.map((split) => {
      const currentAmount = Number(split.amount) || 0;
      const proportion = Math.abs(currentAmount) / absTotal;

      if (split === lastSplit) {
        // Last split absorbs the rounding remainder
        const lastPortion = roundMoney(remaining - distributedSoFar, money);
        return { ...split, amount: roundMoney(currentAmount + lastPortion, money) };
      }

      const portion = roundMoney(remaining * proportion, money);
      distributedSoFar += portion;
      return { ...split, amount: roundMoney(currentAmount + portion, money) };
    });

    commitSplits(newSplits);
  };

  // Set the transaction total to the sum of splits
  const setTotalToSplitsSum = () => {
    if (onTransactionAmountChange && splitsTotal !== 0) {
      onTransactionAmountChange(roundMoney(splitsTotal, money));
    }
  };

  const renderAmountFields = (split: SplitRow, index: number) => (
    <SplitAmountFields
      pair={transferPairOf(split)}
      amountCurrencyCode={foreignActive ? (displayCurrencyCode as string) : currencyCode}
      amountSymbol={activeSymbol}
      amountDecimals={activeDecimals}
      amountValue={toDisplayAmount(split.amount)}
      onAmountChange={(value) => handleSplitChange(index, 'amount', fromDisplayAmount(value ?? 0))}
      receivedValue={currentTransferTargetAmount(split, currencyCode)}
      onReceivedChange={(value) => handleTargetAmountChange(index, value)}
      disabled={disabled}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('splitEditor.header')}</h4>
          {canToggleCurrency && (
            <div
              className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600 text-xs"
              role="group"
              title={t('splitEditor.currencyToggle.title')}
            >
              <button
                type="button"
                onClick={() => setShowForeignAmounts(false)}
                aria-pressed={!foreignActive}
                aria-label={t('splitEditor.currencyToggle.ariaAmountsIn', { code: currencyCode })}
                className={`px-2 py-1 font-medium transition-colors ${
                  !foreignActive
                    ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                {currencyCode}
              </button>
              <button
                type="button"
                onClick={() => setShowForeignAmounts(true)}
                aria-pressed={foreignActive}
                aria-label={t('splitEditor.currencyToggle.ariaAmountsIn', { code: displayCurrencyCode as string })}
                className={`px-2 py-1 font-medium transition-colors ${
                  foreignActive
                    ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                {displayCurrencyCode}
              </button>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={distributeProportionally}
            disabled={disabled || localSplits.length === 0 || isBalanced}
            title={t('splitEditor.distributeProportionallyTitle')}
          >
            {t('splitEditor.distributeProportionally')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={distributeEvenly}
            disabled={disabled || localSplits.length === 0}
          >
            {t('splitEditor.distributeEvenly')}
          </Button>
        </div>
      </div>

      {/* Splits — Mobile Card Layout */}
      <div className="md:hidden border dark:border-gray-700 rounded-lg overflow-visible">
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {localSplits.map((split, index) => {
            const currentCategory = split.categoryId
              ? categories.find(c => c.id === split.categoryId)
              : null;

            return (
              <div key={split.id} className="p-3 space-y-2 bg-white dark:bg-gray-900">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                    {t('splitEditor.splitLabel', { number: index + 1 })}
                  </span>
                  <div className="flex space-x-1">
                    <button
                      type="button"
                      onClick={() => addRemainingToSplit(index)}
                      disabled={disabled || isBalanced}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={isBalanced ? t('splitEditor.noUnassigned') : t('splitEditor.addRemaining')}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                    </button>
                    <RemoveSplitLineButton
                      onClick={() => removeSplit(index)}
                      disabled={disabled || !canRemoveRow(index)}
                      title={!canRemoveRow(index) ? t('splitEditor.removeMinimum') : localSplits.length <= 2 ? t('splitEditor.removeAndConvert') : t('splitEditor.removeSplit')}
                    />
                  </div>
                </div>
                {supportsTransfers && (
                  <Select
                    options={[
                      { value: 'category', label: t('splitEditor.splitTypes.category') },
                      { value: 'transfer', label: t('splitEditor.splitTypes.transfer') },
                      ...(investmentSplitsEnabled
                        ? [{ value: 'investment', label: t('splitEditor.splitTypes.investment') }]
                        : []),
                    ]}
                    value={split.splitType}
                    onChange={(e) => handleSplitChange(index, 'splitType', e.target.value)}
                    disabled={disabled}
                    className="w-full"
                  />
                )}
                {split.splitType === 'investment' ? (
                  <InvestmentSplitFields
                    value={split.investment}
                    onChange={(investment, amount, meta) =>
                      handleSplitChange(index, 'investment', { investment, amount, meta })
                    }
                    disabled={disabled}
                    currencyCode={currencyCode}
                    transactionDate={transactionDate}
                    rateEdited={split.exchangeRateEdited}
                  />
                ) : split.splitType === 'category' || !supportsTransfers ? (
                  // Same picker as the non-split form's Category field: an id-backed
                  // combobox offering "+ Create" for text that matches no category,
                  // so a split line can name one that does not exist yet instead of
                  // discarding what was typed (issue #1187). The create affordance
                  // appears only where the surface can actually create one.
                  <Combobox
                    placeholder={t('splitEditor.selectCategory')}
                    options={categoryOptions}
                    value={split.categoryId || ''}
                    initialDisplayValue={currentCategory?.name || ''}
                    onChange={(categoryId) =>
                      handleSplitChange(index, 'categoryId', categoryId || undefined)
                    }
                    onCreateNew={
                      onCreateCategory
                        ? (name) => handleCategoryCreate(split.id, name)
                        : undefined
                    }
                    allowCustomValue={!!onCreateCategory}
                    valueIsId
                    disabled={disabled}
                  />
                ) : (
                  <Select
                    options={[
                      { value: '', label: t('splitEditor.selectAccount') },
                      ...accountOptions,
                    ]}
                    value={split.transferAccountId || ''}
                    onChange={(e) =>
                      handleSplitChange(index, 'transferAccountId', e.target.value || undefined)
                    }
                    disabled={disabled}
                    className="w-full"
                  />
                )}
                <div className="grid grid-cols-2 gap-2">
                  {renderAmountFields(split, index)}
                  <Input
                    type="text"
                    value={split.memo || ''}
                    onChange={(e) => handleSplitChange(index, 'memo', e.target.value)}
                    placeholder={t('splitEditor.mobileMemoPlaceholder')}
                    maxLength={TRANSACTION_NOTE_MAX_LENGTH}
                    disabled={disabled}
                    className="w-full"
                  />
                </div>
                {tagOptions.length > 0 && (
                  <MultiSelect
                    options={tagOptions}
                    value={split.tagIds || []}
                    onChange={(values) => handleSplitChange(index, 'tagIds', values)}
                    placeholder={t('splitEditor.tagsPlaceholder')}
                    disabled={disabled}
                  />
                )}
              </div>
            );
          })}
        </div>
        {/* Add Split + Total */}
        <div className="bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={addSplit}
            disabled={disabled}
            className="w-full px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-1"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            <span>{t('splitEditor.addSplit')}</span>
          </button>
          <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between flex-wrap gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('splitEditor.total')}</span>
                <span className={`font-medium ${isBalanced ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {activeSymbol}{formatAmountLocal(displaySplitsTotal, activeDecimals)}
                </span>
                {isBalanced ? (
                  <span className="text-xs text-green-600 dark:text-green-400">{t('splitEditor.balanced')}</span>
                ) : (
                  <span className="text-xs text-red-600 dark:text-red-400">
                    {t('splitEditor.remaining', { symbol: activeSymbol, amount: formatAmountLocal(displayRemaining, activeDecimals) })}
                  </span>
                )}
              </div>
              {!isBalanced && onTransactionAmountChange && splitsTotal !== 0 && (
                <button
                  type="button"
                  onClick={setTotalToSplitsSum}
                  disabled={disabled}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline disabled:opacity-50 whitespace-nowrap"
                >
                  {t('splitEditor.setTotal', { symbol: activeSymbol, amount: formatAmountLocal(displaySplitsTotal, activeDecimals) })}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Splits — Desktop Table Layout */}
      <div className="hidden md:block border dark:border-gray-700 rounded-lg overflow-visible">
        <table className="w-full table-fixed divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800 rounded-t-lg">
            <tr>
              {supportsTransfers && (
                <Th className="px-1 py-2" style={{ width: '14%' }}>
                  {t('splitEditor.columns.type')}
                </Th>
              )}
              <Th className="px-1 py-2" style={{ width: supportsTransfers ? '32%' : '45%' }}>
                {supportsTransfers ? t('splitEditor.columns.categoryAccount') : t('splitEditor.columns.category')}
              </Th>
              <Th className="px-1 py-2" style={{ width: supportsTransfers ? '20%' : '13%' }}>
                {t('splitEditor.columns.amount')}
              </Th>
              <Th className="px-1 py-2" style={{ width: '17%' }}>
                {t('splitEditor.columns.memo')}
              </Th>
              {tagOptions.length > 0 && (
                <Th className="px-1 py-2" style={{ width: '15%' }}>
                  {t('splitEditor.columns.tags')}
                </Th>
              )}
              <Th className="px-1 py-2" style={{ width: '5%' }} />
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {localSplits.map((split, index) => {
              // Find current category name for initial display
              const currentCategory = split.categoryId
                ? categories.find(c => c.id === split.categoryId)
                : null;

              return (
              <tr key={split.id}>
                {supportsTransfers && (
                  <td className="px-1 py-2">
                    <Select
                      options={[
                        { value: 'category', label: t('splitEditor.splitTypes.category') },
                        { value: 'transfer', label: t('splitEditor.splitTypes.transfer') },
                        ...(investmentSplitsEnabled
                          ? [{ value: 'investment', label: t('splitEditor.splitTypes.investment') }]
                          : []),
                      ]}
                      value={split.splitType}
                      onChange={(e) => handleSplitChange(index, 'splitType', e.target.value)}
                      disabled={disabled}
                      className="w-full"
                    />
                  </td>
                )}
                <td className="px-1 py-2">
                  {split.splitType === 'investment' ? (
                    <InvestmentSplitFields
                      value={split.investment}
                      onChange={(investment, amount, meta) =>
                        handleSplitChange(index, 'investment', { investment, amount, meta })
                      }
                      disabled={disabled}
                      currencyCode={currencyCode}
                      transactionDate={transactionDate}
                      rateEdited={split.exchangeRateEdited}
                    />
                  ) : split.splitType === 'category' || !supportsTransfers ? (
                    // Same picker as the non-split form's Category field: an id-backed
                    // combobox offering "+ Create" for text that matches no category,
                    // so a split line can name one that does not exist yet instead of
                    // discarding what was typed (issue #1187). The create affordance
                    // appears only where the surface can actually create one.
                    <Combobox
                      placeholder={t('splitEditor.selectCategory')}
                      options={categoryOptions}
                      value={split.categoryId || ''}
                      initialDisplayValue={currentCategory?.name || ''}
                      onChange={(categoryId) =>
                        handleSplitChange(index, 'categoryId', categoryId || undefined)
                      }
                      onCreateNew={
                        onCreateCategory
                          ? (name) => handleCategoryCreate(split.id, name)
                          : undefined
                      }
                      allowCustomValue={!!onCreateCategory}
                      valueIsId
                      disabled={disabled}
                    />
                  ) : (
                    <Select
                      options={[
                        { value: '', label: t('splitEditor.selectAccount') },
                        ...accountOptions,
                      ]}
                      value={split.transferAccountId || ''}
                      onChange={(e) =>
                        handleSplitChange(index, 'transferAccountId', e.target.value || undefined)
                      }
                      disabled={disabled}
                      className="w-full"
                    />
                  )}
                </td>
                <td className="px-1 py-2">
                  {renderAmountFields(split, index)}
                </td>
                <td className="px-1 py-2">
                  <Input
                    type="text"
                    value={split.memo || ''}
                    onChange={(e) => handleSplitChange(index, 'memo', e.target.value)}
                    placeholder={t('splitEditor.memoPlaceholder')}
                    maxLength={TRANSACTION_NOTE_MAX_LENGTH}
                    disabled={disabled}
                    className="w-full"
                  />
                </td>
                {tagOptions.length > 0 && (
                  <td className="px-1 py-2">
                    <MultiSelect
                      options={tagOptions}
                      value={split.tagIds || []}
                      onChange={(values) => handleSplitChange(index, 'tagIds', values)}
                      placeholder={t('splitEditor.tagsPlaceholder')}
                      disabled={disabled}
                    />
                  </td>
                )}
                <td className="px-1 py-2">
                  <div className="flex space-x-1 justify-end">
                    <button
                      type="button"
                      onClick={() => addRemainingToSplit(index)}
                      disabled={disabled || isBalanced}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={isBalanced ? t('splitEditor.noUnassigned') : t('splitEditor.addRemaining')}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                        />
                      </svg>
                    </button>
                    <RemoveSplitLineButton
                      onClick={() => removeSplit(index)}
                      disabled={disabled || !canRemoveRow(index)}
                      title={!canRemoveRow(index) ? t('splitEditor.removeMinimum') : localSplits.length <= 2 ? t('splitEditor.removeAndConvert') : t('splitEditor.removeSplit')}
                    />
                  </div>
                </td>
              </tr>
            );
            })}
          </tbody>
          <tfoot className="bg-gray-50 dark:bg-gray-800">
            {/* Add Split Button Row */}
            <tr className="border-t border-gray-200 dark:border-gray-700">
              <td colSpan={(supportsTransfers ? 5 : 4) + (tagOptions.length > 0 ? 1 : 0)} className="p-0">
                <button
                  type="button"
                  onClick={addSplit}
                  disabled={disabled}
                  className="w-full px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-1"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  <span>{t('splitEditor.addSplit')}</span>
                </button>
              </td>
            </tr>
            {/* Total Row */}
            <tr className="border-t border-gray-200 dark:border-gray-700">
              <td colSpan={(supportsTransfers ? 5 : 4) + (tagOptions.length > 0 ? 1 : 0)} className="px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('splitEditor.total')}</span>
                    <span
                      className={`font-medium ${
                        isBalanced ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {activeSymbol}{formatAmountLocal(displaySplitsTotal, activeDecimals)}
                    </span>
                    {isBalanced ? (
                      <span className="text-xs text-green-600 dark:text-green-400">{t('splitEditor.balanced')}</span>
                    ) : (
                      <span className="text-xs text-red-600 dark:text-red-400 whitespace-nowrap">
                        {t('splitEditor.needAmount', { symbol: activeSymbol, amount: formatAmountLocal(displayTransactionAmount, activeDecimals), remaining: formatAmountLocal(displayRemaining, activeDecimals) })}
                      </span>
                    )}
                  </div>
                  {!isBalanced && onTransactionAmountChange && splitsTotal !== 0 && (
                    <button
                      type="button"
                      onClick={setTotalToSplitsSum}
                      disabled={disabled}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline disabled:opacity-50 whitespace-nowrap"
                    >
                      {t('splitEditor.setTotal', { symbol: activeSymbol, amount: formatAmountLocal(displaySplitsTotal, activeDecimals) })}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <ConfirmDialog
        isOpen={convertPendingIndex !== null}
        variant="warning"
        title={t('splitEditor.convertConfirm.title')}
        message={t('splitEditor.convertConfirm.message')}
        confirmLabel={t('splitEditor.convertConfirm.confirm')}
        onConfirm={confirmConvertToRegular}
        onCancel={() => setConvertPendingIndex(null)}
        pushHistory
      />
    </div>
  );
}
