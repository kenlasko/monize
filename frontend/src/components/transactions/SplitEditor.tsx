'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { Tag } from '@/types/tag';
import { CreateSplitData, InvestmentSplitDetails } from '@/types/transaction';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents, roundToDecimals, getCurrencySymbol, getDecimalPlacesForCurrency } from '@/lib/format';
import { useLocalizedAmount } from '@/hooks/useLocalizedAmount';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import { InvestmentSplitFields } from './InvestmentSplitFields';
import { RemoveSplitLineButton } from './SplitLineButtons';
import { TRANSACTION_NOTE_MAX_LENGTH } from '@/lib/transaction-note';
import { isUuid } from '@/lib/uuid';

export type SplitType = 'category' | 'transfer' | 'investment';

export interface SplitRow extends CreateSplitData {
  id: string; // Temporary ID for React keys
  splitType: SplitType;
  // Real user intent (issue #1167 R9-F2): true once the user edits this line's FX
  // rate input, so a re-entered rate on a *continuing* investment line is honoured
  // for the current pair even when its value equals the stale stored one. Reset
  // when the security (and thus the pair) changes. UI-only -- the serializer turns
  // it into `rateExplicit`; it never reaches an ordinary transaction DTO.
  exchangeRateEdited?: boolean;
}

interface SplitEditorProps {
  splits: SplitRow[];
  onChange: (splits: SplitRow[]) => void;
  categories: Category[];
  tags?: Tag[];
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
}

export function SplitEditor({
  splits,
  onChange,
  categories,
  tags = [],
  accounts = [],
  sourceAccountId = '',
  parentAccountSubType,
  transactionAmount,
  disabled = false,
  onTransactionAmountChange,
  currencyCode = 'CAD',
  onConvertToRegular,
  displayCurrencyCode,
  displayRate,
  onCreateCategory,
}: SplitEditorProps) {
  const t = useTranslations('transactions');
  // Read-only amounts, grouped in the user's number locale (en-US unchanged).
  const formatAmountLocal = useLocalizedAmount();
  const accountOptionLabel = useAccountOptionLabel({ withCurrency: false });
  const investmentSplitsEnabled = parentAccountSubType === 'INVESTMENT_CASH';
  const currencySymbol = getCurrencySymbol(currencyCode);
  const decimals = getDecimalPlacesForCurrency(currencyCode);
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
  // account currency (always rounded to cents, matching the rest of the editor).
  const fromDisplayAmount = (displayAmount: number) =>
    foreignActive ? roundToCents(displayAmount * rate) : roundToCents(displayAmount);
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
  const tagOptions = useMemo(() =>
    [...tags]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map(tag => ({ value: tag.id, label: tag.name })),
    [tags]
  );

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

  // Sync with parent when splits prop changes
  useEffect(() => {
    setLocalSplits(splits);
  }, [splits]);

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

  const splitsTotal = localSplits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const remaining = Number(transactionAmount) - splitsTotal;
  // Balance is always judged in the account currency so distribution and the
  // balanced/remaining indicators stay exact regardless of the display currency.
  const isBalanced = Math.abs(remaining) < 0.01;
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
          investment: undefined,
        };
      } else if (value === 'transfer') {
        newSplits[index] = {
          ...newSplits[index],
          splitType: 'transfer',
          categoryId: undefined,
          investment: undefined,
        };
      } else {
        newSplits[index] = {
          ...newSplits[index],
          splitType: 'investment',
          categoryId: undefined,
          transferAccountId: undefined,
          investment: newSplits[index].investment ?? { action: 'BUY' },
        };
      }
      setLocalSplits(newSplits);
      onChange(newSplits);
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
      setLocalSplits(newSplits);
      onChange(newSplits);
      return;
    }

    // If changing category, adjust the amount sign based on income/expense
    if (field === 'categoryId' && value) {
      const category = findCategory(value);
      if (category) {
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

            if (!isJustSignChange) {
              const absAmount = Math.abs(newAmount);
              value = category.isIncome ? absAmount : -absAmount;
            }
          }
        }
      }
    }

    newSplits[index] = { ...newSplits[index], [field]: value };
    setLocalSplits(newSplits);
    onChange(newSplits);
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
      amount: Math.round(remaining * 100) / 100, // Pre-fill with remaining amount, rounded to 2 decimals
      memo: '',
    };
    const newSplits = [...localSplits, newSplit];
    setLocalSplits(newSplits);
    onChange(newSplits);
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
      setLocalSplits(newSplits);
      onChange(newSplits);
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

    const totalAmount = Math.round(Number(transactionAmount) * 100) / 100;
    // Round each split to 2 decimal places (cents)
    const amountPerSplit = Math.round((totalAmount / localSplits.length) * 100) / 100;

    // Distribute evenly, putting the remainder on the last row for an exact sum.
    const newSplits = localSplits.map((split, index) => {
      if (index === localSplits.length - 1) {
        const otherSplitsTotal = Math.round(amountPerSplit * (localSplits.length - 1) * 100) / 100;
        const lastAmount = Math.round((totalAmount - otherSplitsTotal) * 100) / 100;
        return { ...split, amount: lastAmount };
      }
      return { ...split, amount: amountPerSplit };
    });

    setLocalSplits(newSplits);
    onChange(newSplits);
  };

  // Add unassigned amount to a specific split
  const addRemainingToSplit = (index: number) => {
    if (Math.abs(remaining) < 0.01) return; // No remaining amount

    const newSplits = [...localSplits];
    const currentAmount = Number(newSplits[index].amount) || 0;
    newSplits[index] = { ...newSplits[index], amount: Math.round((currentAmount + remaining) * 100) / 100 };
    setLocalSplits(newSplits);
    onChange(newSplits);
  };

  // Distribute the remaining amount proportionally across the splits based on
  // their current amounts.
  const distributeProportionally = () => {
    if (localSplits.length === 0 || Math.abs(remaining) < 0.01) return;

    const absTotal = localSplits.reduce((sum, s) => sum + Math.abs(Number(s.amount) || 0), 0);
    const lastSplit = localSplits[localSplits.length - 1];

    // If all splits are zero, fall back to equal distribution.
    if (absTotal < 0.01) {
      const perSplit = Math.round((remaining / localSplits.length) * 100) / 100;
      const newSplits = localSplits.map((split, index) => {
        const currentAmount = Number(split.amount) || 0;
        if (index === localSplits.length - 1) {
          const distributed = Math.round(perSplit * (localSplits.length - 1) * 100) / 100;
          const lastPortion = Math.round((remaining - distributed) * 100) / 100;
          return { ...split, amount: Math.round((currentAmount + lastPortion) * 100) / 100 };
        }
        return { ...split, amount: Math.round((currentAmount + perSplit) * 100) / 100 };
      });
      setLocalSplits(newSplits);
      onChange(newSplits);
      return;
    }

    let distributedSoFar = 0;
    const newSplits = localSplits.map((split) => {
      const currentAmount = Number(split.amount) || 0;
      const proportion = Math.abs(currentAmount) / absTotal;

      if (split === lastSplit) {
        // Last split absorbs the rounding remainder
        const lastPortion = Math.round((remaining - distributedSoFar) * 100) / 100;
        return { ...split, amount: Math.round((currentAmount + lastPortion) * 100) / 100 };
      }

      const portion = Math.round(remaining * proportion * 100) / 100;
      distributedSoFar += portion;
      return { ...split, amount: Math.round((currentAmount + portion) * 100) / 100 };
    });

    setLocalSplits(newSplits);
    onChange(newSplits);
  };

  // Set the transaction total to the sum of splits
  const setTotalToSplitsSum = () => {
    if (onTransactionAmountChange && splitsTotal !== 0) {
      onTransactionAmountChange(Math.round(splitsTotal * 100) / 100);
    }
  };

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
            disabled={disabled || localSplits.length === 0 || Math.abs(remaining) < 0.01}
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
                      disabled={disabled || Math.abs(remaining) < 0.01}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={Math.abs(remaining) < 0.01 ? t('splitEditor.noUnassigned') : t('splitEditor.addRemaining')}
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
                  <CurrencyInput
                    prefix={activeSymbol}
                    value={toDisplayAmount(split.amount)}
                    onChange={(value) => handleSplitChange(index, 'amount', fromDisplayAmount(value ?? 0))}
                    allowSignToggle
                    disabled={disabled}
                    className="w-full"
                  />
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
                <th className="px-1 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: '14%' }}>
                  {t('splitEditor.columns.type')}
                </th>
              )}
              <th className="px-1 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: supportsTransfers ? '32%' : '45%' }}>
                {supportsTransfers ? t('splitEditor.columns.categoryAccount') : t('splitEditor.columns.category')}
              </th>
              <th className="px-1 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: supportsTransfers ? '20%' : '13%' }}>
                {t('splitEditor.columns.amount')}
              </th>
              <th className="px-1 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: '17%' }}>
                {t('splitEditor.columns.memo')}
              </th>
              {tagOptions.length > 0 && (
                <th className="px-1 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: '15%' }}>
                  {t('splitEditor.columns.tags')}
                </th>
              )}
              <th className="px-1 py-2" style={{ width: '5%' }}></th>
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
                  <CurrencyInput
                    prefix={activeSymbol}
                    value={toDisplayAmount(split.amount)}
                    onChange={(value) => handleSplitChange(index, 'amount', fromDisplayAmount(value ?? 0))}
                    allowSignToggle
                    disabled={disabled}
                    className="w-full"
                  />
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
                      disabled={disabled || Math.abs(remaining) < 0.01}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={Math.abs(remaining) < 0.01 ? t('splitEditor.noUnassigned') : t('splitEditor.addRemaining')}
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

// Helper function to generate temporary IDs for new splits
export function createEmptySplits(transactionAmount: number): SplitRow[] {
  const halfAmount = Math.round((Number(transactionAmount) / 2) * 100) / 100;
  const otherHalf = Math.round((Number(transactionAmount) - halfAmount) * 100) / 100;

  return [
    {
      id: `temp-${Date.now()}-1`,
      splitType: 'category',
      categoryId: undefined,
      transferAccountId: undefined,
      amount: halfAmount,
      memo: '',
    },
    {
      id: `temp-${Date.now()}-2`,
      splitType: 'category',
      categoryId: undefined,
      transferAccountId: undefined,
      amount: otherHalf,
      memo: '',
    },
  ];
}

// Convert API splits to SplitRow format. Accepts both transaction splits (with
// `investmentTransaction` relation) and scheduled-transaction splits (with the
// investment payload denormalized as `investment*` columns on the row itself).
// A real server-issued split id is a UUID. A synthetic React key (a
// pre-migration override's `override-N`, or a `temp-...` row the user just
// added) is not, and must never be treated as source identity (issue #1167
// R8-F1) -- it would be rejected by the DTO's `@IsUUID` and could masquerade as
// a persistent id, so it is checked with `isUuid`.
export function toSplitRows(splits: {
  id?: string;
  kind?: 'category' | 'transfer' | 'investment';
  categoryId?: string | null;
  transferAccountId?: string | null;
  amount: number;
  memo?: string | null;
  tags?: { id: string }[];
  investmentTransaction?: {
    action: string;
    securityId: string | null;
    quantity: number | null;
    price: number | null;
    commission: number;
    exchangeRate: number;
  } | null;
  // Scheduled-transaction-split shape
  investmentAction?: string | null;
  investmentSecurityId?: string | null;
  investmentQuantity?: number | null;
  investmentPrice?: number | null;
  investmentCommission?: number | null;
  investmentExchangeRate?: number | null;
  investmentExchangeRateFromCurrency?: string | null;
  investmentExchangeRateToCurrency?: string | null;
  // Override JSON shape
  splitKind?: 'category' | 'transfer' | 'investment';
  investment?: {
    action: string;
    securityId?: string;
    quantity?: number;
    price?: number;
    commission?: number;
    exchangeRate?: number;
    exchangeRateFromCurrency?: string;
    exchangeRateToCurrency?: string;
  };
}[]): SplitRow[] {
  return splits.map((split, index) => {
    const kind: SplitType =
      split.kind === 'investment' ||
      split.splitKind === 'investment' ||
      split.investmentTransaction ||
      split.investmentAction ||
      split.investment
        ? 'investment'
        : split.transferAccountId
          ? 'transfer'
          : 'category';
    let investment: InvestmentSplitDetails | undefined;
    if (split.investmentTransaction) {
      investment = {
        action: split.investmentTransaction.action as InvestmentSplitDetails['action'],
        securityId: split.investmentTransaction.securityId ?? undefined,
        quantity: Number(split.investmentTransaction.quantity ?? 0),
        price: Number(split.investmentTransaction.price ?? 0),
        commission: Number(split.investmentTransaction.commission ?? 0),
        // A persisted rate of null is unknown FX, not 1 (issue #1167 R10-F1):
        // coercing it to 1 lets the server bless a synthetic 1 as the current
        // pair. Preserve undefined so the split carries no rate.
        exchangeRate:
          split.investmentTransaction.exchangeRate != null
            ? Number(split.investmentTransaction.exchangeRate)
            : undefined,
      };
    } else if (split.investmentAction) {
      investment = {
        action: split.investmentAction as InvestmentSplitDetails['action'],
        securityId: split.investmentSecurityId ?? undefined,
        quantity: Number(split.investmentQuantity ?? 0),
        price: Number(split.investmentPrice ?? 0),
        commission: Number(split.investmentCommission ?? 0),
        // A persisted scheduled rate of null is unknown FX, not 1 (issue #1167
        // R10-F1): coercing it to 1 lets a cosmetic edit bless a synthetic 1 as
        // the current cross-currency pair. Preserve undefined -- the cross-currency
        // field then resolves the real rate, and a matched null-rate source is not
        // stamped unless the user actually enters one.
        exchangeRate:
          split.investmentExchangeRate != null
            ? Number(split.investmentExchangeRate)
            : undefined,
        // Carry the server-recorded currency pair (issue #1167 F5-1) so a Post
        // that resends this line unchanged lets the server tell a still-valid
        // rate from a since-stale one, rather than trusting the scalar blindly.
        exchangeRateFromCurrency:
          split.investmentExchangeRateFromCurrency ?? undefined,
        exchangeRateToCurrency:
          split.investmentExchangeRateToCurrency ?? undefined,
      };
    } else if (split.investment) {
      investment = {
        action: split.investment.action as InvestmentSplitDetails['action'],
        securityId: split.investment.securityId,
        quantity: split.investment.quantity,
        price: split.investment.price,
        commission: split.investment.commission,
        exchangeRate: split.investment.exchangeRate,
        exchangeRateFromCurrency: split.investment.exchangeRateFromCurrency,
        exchangeRateToCurrency: split.investment.exchangeRateToCurrency,
      };
    }
    return {
      id: split.id || `temp-${Date.now()}-${index}`,
      // The source split's real id (undefined for a row the user just added), so
      // an edit/post can name it as `sourceSplitId` and the server decides FX
      // provenance by identity (issue #1167 F4). Only a real server id (a UUID)
      // may become source identity: a synthetic React key (a pre-migration
      // override's `override-N`, or a `temp-` row) is UI-only and would be
      // rejected by the DTO's `@IsUUID` and, worse, could masquerade as a
      // persistent id (issue #1167 R8-F1). Anything else stays undefined, which
      // the server reads as "new/unidentified line".
      sourceSplitId: isUuid(split.id) ? split.id : undefined,
      splitType: kind,
      categoryId: split.categoryId || undefined,
      transferAccountId: split.transferAccountId || undefined,
      investment,
      amount: Number(split.amount),
      memo: split.memo || '',
      tagIds: split.tags?.map(t => t.id) || [],
    };
  });
}

// Convert SplitRow to API format (removes temporary id and splitType)
// Convert SplitRow to API format (removes temporary id and splitType).
//
// `includeSourceIdentity` is opt-in and OFF by default: `sourceSplitId` is a
// scheduled-transaction correlation field (issue #1167 F4) that the ordinary
// transaction DTO does not accept, so emitting it there fails validation under
// `forbidNonWhitelisted` (R7-F1). Only the scheduled create/update surface passes
// it true.
export function toCreateSplitData(
  splits: SplitRow[],
  options: { includeSourceIdentity?: boolean } = {},
): CreateSplitData[] {
  return splits.map((split) => ({
    splitKind: split.splitType,
    categoryId: split.splitType === 'category' ? split.categoryId : undefined,
    transferAccountId: split.splitType === 'transfer' ? split.transferAccountId : undefined,
    investment: split.splitType === 'investment' ? split.investment : undefined,
    amount: split.amount,
    memo: split.memo || undefined,
    tagIds: split.tagIds && split.tagIds.length > 0 ? split.tagIds : undefined,
    // Carry the source split id only for scheduled surfaces that decide FX
    // provenance by identity; undefined for a row the user added.
    sourceSplitId: options.includeSourceIdentity
      ? split.sourceSplitId
      : undefined,
    // The line's FX rate is a deliberate value for the current settlement pair,
    // so the server stamps that pair rather than treating the line as an
    // unidentified legacy row (issue #1167 R8-F2/R9-F2). True for a genuinely new
    // investment line (no source identity), or a continuing one whose rate the
    // user actually edited (`exchangeRateEdited`) -- the latter closes the
    // same-value re-entry edge where the re-typed value equals the stale stored
    // one. Scheduled surfaces only, alongside the source-identity opt-in.
    rateExplicit:
      options.includeSourceIdentity &&
      split.splitType === 'investment' &&
      (!split.sourceSplitId || split.exchangeRateEdited === true)
        ? true
        : undefined,
  }));
}
