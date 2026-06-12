'use client';

import { useState, useEffect, useMemo } from 'react';
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
import { roundToCents, getCurrencySymbol, formatAmountWithCommas, getDecimalPlacesForCurrency } from '@/lib/format';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { InvestmentSplitFields } from './InvestmentSplitFields';

export type SplitType = 'category' | 'transfer' | 'investment';

export interface SplitRow extends CreateSplitData {
  id: string; // Temporary ID for React keys
  splitType: SplitType;
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
}: SplitEditorProps) {
  const t = useTranslations('transactions');
  const investmentSplitsEnabled = parentAccountSubType === 'INVESTMENT_CASH';
  const currencySymbol = getCurrencySymbol(currencyCode);
  const decimals = getDecimalPlacesForCurrency(currencyCode);
  const [localSplits, setLocalSplits] = useState<SplitRow[]>(splits);
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
      (a) => `${a.name}${a.isClosed ? ' (Closed)' : ''}`,
    );
  }, [accounts, sourceAccountId, supportsTransfers, splits]);

  // Sync with parent when splits prop changes
  useEffect(() => {
    setLocalSplits(splits);
  }, [splits]);

  const splitsTotal = localSplits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const remaining = Number(transactionAmount) - splitsTotal;
  const isBalanced = Math.abs(remaining) < 0.01;

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
      // computed cash impact passed as `_amount` via the value object.
      const { investment, amount } = value as {
        investment: InvestmentSplitDetails;
        amount: number;
      };
      newSplits[index] = {
        ...newSplits[index],
        investment,
        amount,
      };
      setLocalSplits(newSplits);
      onChange(newSplits);
      return;
    }

    // If changing category, adjust the amount sign based on income/expense
    if (field === 'categoryId' && value) {
      const category = categories.find(c => c.id === value);
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
        const category = categories.find(c => c.id === categoryId);
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

  const addSplit = () => {
    const newSplit: SplitRow = {
      id: `temp-${Date.now()}-${Math.random()}`,
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

    const totalAmount = Number(transactionAmount);
    // Round each split to 2 decimal places (cents)
    const amountPerSplit = Math.round((totalAmount / localSplits.length) * 100) / 100;

    // Distribute evenly, put remainder on last split
    const newSplits = localSplits.map((split, index) => {
      if (index === localSplits.length - 1) {
        // Last split gets remainder to ensure exact sum
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

  // Distribute remaining amount proportionally across all splits based on their current amounts
  const distributeProportionally = () => {
    if (localSplits.length === 0 || Math.abs(remaining) < 0.01) return;

    const absTotal = localSplits.reduce((sum, s) => sum + Math.abs(Number(s.amount) || 0), 0);

    // If all splits are zero, fall back to equal distribution
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
    const newSplits = localSplits.map((split, index) => {
      const currentAmount = Number(split.amount) || 0;
      const proportion = Math.abs(currentAmount) / absTotal;

      if (index === localSplits.length - 1) {
        // Last split absorbs rounding remainder
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
      <div className="flex justify-between items-center gap-2">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('splitEditor.header')}</h4>
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
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('splitEditor.splitLabel', { number: index + 1 })}</span>
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
                    <button
                      type="button"
                      onClick={() => removeSplit(index)}
                      disabled={disabled || !canRemoveRow(index)}
                      className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={!canRemoveRow(index) ? t('splitEditor.removeMinimum') : localSplits.length <= 2 ? t('splitEditor.removeAndConvert') : t('splitEditor.removeSplit')}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
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
                    onChange={(investment, amount) =>
                      handleSplitChange(index, 'investment', { investment, amount })
                    }
                    disabled={disabled}
                    currencyCode={currencyCode}
                  />
                ) : split.splitType === 'category' || !supportsTransfers ? (
                  <Combobox
                    placeholder={t('splitEditor.selectCategory')}
                    options={categoryOptions}
                    value={split.categoryId || ''}
                    initialDisplayValue={currentCategory?.name || ''}
                    onChange={(categoryId) =>
                      handleSplitChange(index, 'categoryId', categoryId || undefined)
                    }
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
                    prefix={currencySymbol}
                    value={split.amount}
                    onChange={(value) => handleSplitChange(index, 'amount', roundToCents(value ?? 0))}
                    disabled={disabled}
                    className="w-full"
                  />
                  <Input
                    type="text"
                    value={split.memo || ''}
                    onChange={(e) => handleSplitChange(index, 'memo', e.target.value)}
                    placeholder={t('splitEditor.mobileMemoPlaceholder')}
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
                  {currencySymbol}{formatAmountWithCommas(splitsTotal, decimals)}
                </span>
                {isBalanced ? (
                  <span className="text-xs text-green-600 dark:text-green-400">{t('splitEditor.balanced')}</span>
                ) : (
                  <span className="text-xs text-red-600 dark:text-red-400">
                    {t('splitEditor.remaining', { symbol: currencySymbol, amount: formatAmountWithCommas(remaining, decimals) })}
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
                  {t('splitEditor.setTotal', { symbol: currencySymbol, amount: formatAmountWithCommas(splitsTotal, decimals) })}
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
              <th className="px-1 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: supportsTransfers ? '34%' : '45%' }}>
                {supportsTransfers ? t('splitEditor.columns.categoryAccount') : t('splitEditor.columns.category')}
              </th>
              <th className="px-1 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: supportsTransfers ? '15%' : '13%' }}>
                {t('splitEditor.columns.amount')}
              </th>
              <th className="px-1 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase" style={{ width: '20%' }}>
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
                      onChange={(investment, amount) =>
                        handleSplitChange(index, 'investment', { investment, amount })
                      }
                      disabled={disabled}
                      currencyCode={currencyCode}
                    />
                  ) : split.splitType === 'category' || !supportsTransfers ? (
                    <Combobox
                      placeholder={t('splitEditor.selectCategory')}
                      options={categoryOptions}
                      value={split.categoryId || ''}
                      initialDisplayValue={currentCategory?.name || ''}
                      onChange={(categoryId) =>
                        handleSplitChange(index, 'categoryId', categoryId || undefined)
                      }
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
                    prefix={currencySymbol}
                    value={split.amount}
                    onChange={(value) => handleSplitChange(index, 'amount', roundToCents(value ?? 0))}
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
                    <button
                      type="button"
                      onClick={() => removeSplit(index)}
                      disabled={disabled || !canRemoveRow(index)}
                      className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      title={!canRemoveRow(index) ? t('splitEditor.removeMinimum') : localSplits.length <= 2 ? t('splitEditor.removeAndConvert') : t('splitEditor.removeSplit')}
                    >
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
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
                      {currencySymbol}{formatAmountWithCommas(splitsTotal, decimals)}
                    </span>
                    {isBalanced ? (
                      <span className="text-xs text-green-600 dark:text-green-400">{t('splitEditor.balanced')}</span>
                    ) : (
                      <span className="text-xs text-red-600 dark:text-red-400 whitespace-nowrap">
                        {t('splitEditor.needAmount', { symbol: currencySymbol, amount: formatAmountWithCommas(Number(transactionAmount), decimals), remaining: formatAmountWithCommas(remaining, decimals) })}
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
                      {t('splitEditor.setTotal', { symbol: currencySymbol, amount: formatAmountWithCommas(splitsTotal, decimals) })}
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
  // Override JSON shape
  splitKind?: 'category' | 'transfer' | 'investment';
  investment?: {
    action: string;
    securityId?: string;
    quantity?: number;
    price?: number;
    commission?: number;
    exchangeRate?: number;
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
        exchangeRate: Number(split.investmentTransaction.exchangeRate ?? 1),
      };
    } else if (split.investmentAction) {
      investment = {
        action: split.investmentAction as InvestmentSplitDetails['action'],
        securityId: split.investmentSecurityId ?? undefined,
        quantity: Number(split.investmentQuantity ?? 0),
        price: Number(split.investmentPrice ?? 0),
        commission: Number(split.investmentCommission ?? 0),
        exchangeRate: Number(split.investmentExchangeRate ?? 1),
      };
    } else if (split.investment) {
      investment = {
        action: split.investment.action as InvestmentSplitDetails['action'],
        securityId: split.investment.securityId,
        quantity: split.investment.quantity,
        price: split.investment.price,
        commission: split.investment.commission,
        exchangeRate: split.investment.exchangeRate,
      };
    }
    return {
      id: split.id || `temp-${Date.now()}-${index}`,
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
export function toCreateSplitData(splits: SplitRow[]): CreateSplitData[] {
  return splits.map((split) => ({
    splitKind: split.splitType,
    categoryId: split.splitType === 'category' ? split.categoryId : undefined,
    transferAccountId: split.splitType === 'transfer' ? split.transferAccountId : undefined,
    investment: split.splitType === 'investment' ? split.investment : undefined,
    amount: split.amount,
    memo: split.memo || undefined,
    tagIds: split.tagIds && split.tagIds.length > 0 ? split.tagIds : undefined,
  }));
}
